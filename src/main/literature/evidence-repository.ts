import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

type LiteratureEvidenceOrigin = 'selection' | 'retrieval'

type LiteraturePageQuad = Readonly<{
  page: number
  points: readonly [number, number, number, number, number, number, number, number]
}>

type LiteratureEvidencePayload = Readonly<{
  quote: string
  prefix?: string
  suffix?: string
  textPosition?: Readonly<{ start: number; end: number }>
  pageQuads?: readonly LiteraturePageQuad[]
}>

type SaveLiteratureEvidenceInput = Readonly<{
  id: string
  projectId: string
  sessionId: string
  sourceMessageId: string
  uploadVersionId?: string
  extractionId?: string
  documentChecksum: string
  origin: LiteratureEvidenceOrigin
  pageStart: number
  pageEnd: number
  extractorFingerprint: string
  evidenceSchemaVersion: number
  payload: LiteratureEvidencePayload
}>

type FindLiteratureEvidenceInput = Readonly<{
  id: string
  documentChecksum: string
  extractorFingerprint: string
  evidenceSchemaVersion: number
}>

type LiteratureEvidenceClient = Pick<
  PrismaClient,
  '$transaction' | 'literatureEvidence' | 'literatureExtraction' | 'project' | 'uploadVersion'
>
type LiteratureEvidenceClientProvider = () => Promise<LiteratureEvidenceClient>

const MAX_QUOTE_CHARS = 8_000
const MAX_CONTEXT_CHARS = 256
const MAX_PAGE_QUADS = 128
const MAX_EVIDENCE_JSON_CHARS = 32_000
const HASH_PATTERN = /^[a-f0-9]{64}$/

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const validatePayload = (
  payload: LiteratureEvidencePayload,
  pageStart: number,
  pageEnd: number
): string => {
  if (
    !payload.quote.trim() ||
    payload.quote.length > MAX_QUOTE_CHARS ||
    (payload.prefix !== undefined && payload.prefix.length > MAX_CONTEXT_CHARS) ||
    (payload.suffix !== undefined && payload.suffix.length > MAX_CONTEXT_CHARS)
  ) {
    throw new Error('Literature Evidence text exceeds the persistence limit.')
  }
  if (
    payload.textPosition &&
    (!Number.isSafeInteger(payload.textPosition.start) ||
      !Number.isSafeInteger(payload.textPosition.end) ||
      payload.textPosition.start < 0 ||
      payload.textPosition.end < payload.textPosition.start)
  ) {
    throw new Error('Literature Evidence text position is invalid.')
  }
  if (
    payload.pageQuads &&
    (payload.pageQuads.length > MAX_PAGE_QUADS ||
      payload.pageQuads.some(
        ({ page, points }) =>
          !Number.isSafeInteger(page) ||
          page < pageStart ||
          page > pageEnd ||
          points.length !== 8 ||
          points.some((point) => !Number.isFinite(point))
      ))
  ) {
    throw new Error('Literature Evidence page geometry is invalid.')
  }
  const evidenceJson = JSON.stringify(payload)
  if (evidenceJson.length > MAX_EVIDENCE_JSON_CHARS) {
    throw new Error('Literature Evidence payload exceeds the persistence limit.')
  }
  return evidenceJson
}

class LiteratureEvidenceRepository {
  constructor(private readonly clientProvider: LiteratureEvidenceClientProvider) {}

  async find(input: FindLiteratureEvidenceInput): Promise<LiteratureEvidencePayload | undefined> {
    const client = await this.clientProvider()
    const row = await client.literatureEvidence.findUnique({ where: { id: input.id } })
    if (
      !row ||
      row.documentChecksum !== input.documentChecksum ||
      row.extractorFingerprint !== input.extractorFingerprint ||
      row.evidenceSchemaVersion !== input.evidenceSchemaVersion ||
      row.evidenceChecksum !== sha256(row.evidenceJson)
    ) {
      return undefined
    }
    try {
      const payload = JSON.parse(row.evidenceJson) as LiteratureEvidencePayload
      validatePayload(payload, row.pageStart, row.pageEnd)
      return payload
    } catch {
      return undefined
    }
  }

  async save(input: SaveLiteratureEvidenceInput): Promise<void> {
    if (
      !HASH_PATTERN.test(input.documentChecksum) ||
      !HASH_PATTERN.test(input.extractorFingerprint) ||
      !Number.isSafeInteger(input.pageStart) ||
      !Number.isSafeInteger(input.pageEnd) ||
      input.pageStart < 1 ||
      input.pageEnd < input.pageStart ||
      !Number.isSafeInteger(input.evidenceSchemaVersion) ||
      input.evidenceSchemaVersion < 1
    ) {
      throw new Error('Literature Evidence identity is invalid.')
    }
    const evidenceJson = validatePayload(input.payload, input.pageStart, input.pageEnd)
    const client = await this.clientProvider()
    await client.$transaction(async (transaction) => {
      const owner = await transaction.project.findFirst({
        where: { id: input.projectId, deletedAt: null },
        select: { id: true }
      })
      if (!owner) return
      if (input.uploadVersionId) {
        const uploadVersion = await transaction.uploadVersion.findUnique({
          where: { id: input.uploadVersionId },
          select: { checksum: true, contentType: true }
        })
        if (
          !uploadVersion ||
          uploadVersion.checksum !== input.documentChecksum ||
          uploadVersion.contentType !== 'application/pdf'
        ) {
          throw new Error('Literature Evidence UploadVersion identity does not match the PDF.')
        }
      }
      if (input.extractionId) {
        const extraction = await transaction.literatureExtraction.findUnique({
          where: { id: input.extractionId },
          select: { uploadVersionId: true, documentChecksum: true, extractorFingerprint: true }
        })
        if (
          !extraction ||
          extraction.documentChecksum !== input.documentChecksum ||
          extraction.extractorFingerprint !== input.extractorFingerprint ||
          (input.uploadVersionId && extraction.uploadVersionId !== input.uploadVersionId)
        ) {
          throw new Error('Literature Evidence extraction identity does not match the PDF.')
        }
      }
      const data = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        sourceMessageId: input.sourceMessageId,
        uploadVersionId: input.uploadVersionId ?? null,
        extractionId: input.extractionId ?? null,
        documentChecksum: input.documentChecksum,
        origin: input.origin,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        extractorFingerprint: input.extractorFingerprint,
        evidenceSchemaVersion: input.evidenceSchemaVersion,
        evidenceJson,
        evidenceChecksum: sha256(evidenceJson)
      }
      await transaction.literatureEvidence.upsert({
        where: { id: input.id },
        create: { id: input.id, ...data },
        update: data
      })
    })
  }

  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return
    const client = await this.clientProvider()
    await client.literatureEvidence.deleteMany({ where: { sessionId: { in: [...sessionIds] } } })
  }

  async reconcileSessions(existingSessionIds: readonly string[]): Promise<void> {
    const client = await this.clientProvider()
    await client.literatureEvidence.deleteMany({
      where: { sessionId: { notIn: [...existingSessionIds] } }
    })
  }
}

export { LiteratureEvidenceRepository }
export type {
  FindLiteratureEvidenceInput,
  LiteratureEvidenceOrigin,
  LiteratureEvidencePayload,
  LiteraturePageQuad,
  SaveLiteratureEvidenceInput
}
