import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { LiteratureEvidenceRepository } from './evidence-repository'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('LiteratureEvidenceRepository', () => {
  let root: string
  let client: PrismaClient
  let repository: LiteratureEvidenceRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'literature-evidence-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    repository = new LiteratureEvidenceRepository(async () => client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-file-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'paper.pdf',
        originalFilename: 'paper.pdf'
      }
    })
    await client.uploadVersion.create({
      data: {
        id: 'upload-version-1',
        uploadFileId: 'upload-file-1',
        versionNumber: 1,
        state: 'ready',
        contentStorageKey: 'uploads/paper.pdf',
        filename: 'paper.pdf',
        originalFilename: 'paper.pdf',
        contentType: 'application/pdf',
        sizeBytes: 5n,
        checksum: HASH_A
      }
    })
    await client.literatureExtraction.create({
      data: {
        id: 'extraction-1',
        uploadVersionId: 'upload-version-1',
        documentChecksum: HASH_A,
        mimeType: 'application/pdf',
        extractorFingerprint: HASH_B,
        extractionSchemaVersion: 1,
        updatedAt: new Date()
      }
    })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  const saveEvidence = (): Promise<void> =>
    repository.save({
      id: 'evidence-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      uploadVersionId: 'upload-version-1',
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      origin: 'selection',
      pageStart: 2,
      pageEnd: 2,
      extractorFingerprint: HASH_B,
      evidenceSchemaVersion: 1,
      payload: {
        quote: 'The reported effect was statistically significant.',
        prefix: 'Results: ',
        suffix: ' Further analysis followed.',
        textPosition: { start: 100, end: 150 },
        pageQuads: [{ page: 2, points: [1, 2, 3, 2, 3, 4, 1, 4] }]
      }
    })

  it('persists bounded Evidence and verifies its checksum before returning it', async () => {
    await saveEvidence()

    await expect(
      repository.find({
        id: 'evidence-1',
        documentChecksum: HASH_A,
        extractorFingerprint: HASH_B,
        evidenceSchemaVersion: 1
      })
    ).resolves.toMatchObject({ quote: 'The reported effect was statistically significant.' })
    await client.literatureEvidence.update({
      where: { id: 'evidence-1' },
      data: { evidenceJson: '{"quote":"tampered"}' }
    })
    await expect(
      repository.find({
        id: 'evidence-1',
        documentChecksum: HASH_A,
        extractorFingerprint: HASH_B,
        evidenceSchemaVersion: 1
      })
    ).resolves.toBeUndefined()
  })

  it('keeps quoted Evidence after its rebuildable PDF extraction is deleted', async () => {
    await saveEvidence()

    await client.uploadVersion.delete({ where: { id: 'upload-version-1' } })

    await expect(client.literatureExtraction.count()).resolves.toBe(0)
    await expect(
      client.literatureEvidence.findUnique({ where: { id: 'evidence-1' } })
    ).resolves.toMatchObject({
      uploadVersionId: null,
      extractionId: null,
      documentChecksum: HASH_A
    })
  })

  it('enforces quote limits before writing', async () => {
    await expect(
      repository.save({
        id: 'evidence-too-large',
        projectId: 'project-1',
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        documentChecksum: HASH_A,
        origin: 'retrieval',
        pageStart: 1,
        pageEnd: 1,
        extractorFingerprint: HASH_B,
        evidenceSchemaVersion: 1,
        payload: { quote: 'x'.repeat(8_001) }
      })
    ).rejects.toThrow('Literature Evidence text exceeds the persistence limit.')
    await expect(client.literatureEvidence.count()).resolves.toBe(0)
  })

  it('removes Evidence with its Session and does not recreate it for a deleted Project', async () => {
    await saveEvidence()
    await repository.deleteSessions(['session-1'])
    await expect(client.literatureEvidence.count()).resolves.toBe(0)

    await client.project.update({ where: { id: 'project-1' }, data: { deletedAt: new Date() } })
    await saveEvidence()
    await expect(client.literatureEvidence.count()).resolves.toBe(0)
  })
})
