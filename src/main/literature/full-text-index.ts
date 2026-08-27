import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

import { migrationSqlExecutor } from '../database/migration-sql-executor'
import { createLogger } from '../logger'
import {
  LITERATURE_INDEX_SCHEMA_VERSION,
  literatureIndexSchemaObjects,
  literatureIndexSchemaStatements
} from '../database/migrations/literature-index-0001'

type LiteratureIndexChunk = Readonly<{
  pageStart: number
  pageEnd: number
  textStart: number
  textEnd: number
  sectionTitle?: string
  content: string
}>

type ReplaceLiteratureIndexInput = Readonly<{
  extractionId: string
  documentChecksum: string
  extractorFingerprint: string
  chunks: readonly LiteratureIndexChunk[]
}>

type LiteratureSearchResult = Readonly<{
  extractionId: string
  pageStart: number
  pageEnd: number
  textStart: number
  textEnd: number
  sectionTitle?: string
  content: string
  rank: number
  relativeScore: number
}>

type SearchLiteratureIndexInput = Readonly<{
  extractionIds: readonly string[]
  query: string
  limit?: number
}>

const MAX_INDEX_CHUNKS = 20_000
const MAX_CHUNK_CHARS = 12_000
const MAX_SECTION_TITLE_CHARS = 1_024
const MAX_QUERY_TERMS = 16
const MAX_SEARCH_RESULTS = 20
const SEARCH_CANDIDATE_MULTIPLIER = 3
const MIN_RELATIVE_BM25_SCORE = 0.25
const MAX_RESULT_OVERLAP_RATIO = 0.5
const HASH_PATTERN = /^[a-f0-9]{64}$/
const log = createLogger('literature-reading-context')

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const literatureIndexPath = (storageRoot: string): string =>
  join(storageRoot, 'literature', 'literature-fulltext.sqlite').replace(/\\/g, '/')

const createLiteratureIndexClient = (storageRoot: string): PrismaClient =>
  new PrismaClient({
    datasources: { db: { url: `file:${literatureIndexPath(storageRoot)}?connection_limit=1` } }
  })

const migrateLiteratureIndex = async (client: PrismaClient): Promise<void> => {
  await migrationSqlExecutor.execute(client, 'PRAGMA foreign_keys = ON')
  const [version] = await migrationSqlExecutor.query<Array<{ user_version: bigint | number }>>(
    client,
    'PRAGMA user_version'
  )
  const currentVersion = Number(version?.user_version ?? 0)
  if (currentVersion > LITERATURE_INDEX_SCHEMA_VERSION) {
    throw new Error(`Literature index schema version ${currentVersion} is not supported.`)
  }
  if (currentVersion === 0) {
    await client.$transaction(async (transaction) => {
      for (const statement of literatureIndexSchemaStatements) {
        await migrationSqlExecutor.execute(transaction, statement)
      }
      await migrationSqlExecutor.execute(
        transaction,
        `PRAGMA user_version = ${LITERATURE_INDEX_SCHEMA_VERSION}`
      )
    })
  }
  const rows = await migrationSqlExecutor.query<Array<{ name: string }>>(
    client,
    `SELECT "name" FROM "sqlite_schema" WHERE "name" IN (${literatureIndexSchemaObjects.map(() => '?').join(', ')})`,
    ...literatureIndexSchemaObjects
  )
  const names = new Set(rows.map(({ name }) => name))
  if (literatureIndexSchemaObjects.some((name) => !names.has(name))) {
    throw new Error('Literature index schema is incomplete.')
  }
}

const normalizeSearchQuery = (query: string): string | undefined => {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, MAX_QUERY_TERMS) ?? []
  return terms.length > 0
    ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    : undefined
}

const resultOverlapRatio = (
  left: Pick<LiteratureSearchResult, 'extractionId' | 'textStart' | 'textEnd'>,
  right: Pick<LiteratureSearchResult, 'extractionId' | 'textStart' | 'textEnd'>
): number => {
  if (left.extractionId !== right.extractionId) return 0
  const intersection = Math.max(
    0,
    Math.min(left.textEnd, right.textEnd) - Math.max(left.textStart, right.textStart)
  )
  const shorterLength = Math.min(left.textEnd - left.textStart, right.textEnd - right.textStart)
  return shorterLength > 0 ? intersection / shorterLength : 0
}

const withRelativeScore = <T extends { rank: number }>(
  candidate: T,
  bestRank: number
): T & { relativeScore: number } => {
  const bestMagnitude = Math.abs(bestRank)
  const candidateMagnitude = Math.abs(candidate.rank)
  const relativeScore =
    Number.isFinite(bestMagnitude) && bestMagnitude > 0
      ? Math.min(candidateMagnitude / bestMagnitude, 1)
      : 1
  return { ...candidate, relativeScore }
}

class LiteratureFullTextIndex {
  private constructor(private readonly client: PrismaClient) {}

  static async open(storageRoot: string): Promise<LiteratureFullTextIndex> {
    await mkdir(join(storageRoot, 'literature'), { recursive: true })
    const client = createLiteratureIndexClient(storageRoot)
    try {
      await migrateLiteratureIndex(client)
      return new LiteratureFullTextIndex(client)
    } catch (error) {
      await client.$disconnect()
      throw error
    }
  }

  async close(): Promise<void> {
    await this.client.$disconnect()
  }

  async deleteExtraction(extractionId: string): Promise<void> {
    if (!extractionId.trim()) throw new Error('Literature extraction identity is invalid.')
    await migrationSqlExecutor.execute(
      this.client,
      `DELETE FROM "LiteratureIndexDocument" WHERE "extractionId" = ?`,
      extractionId
    )
  }

  async replace(input: ReplaceLiteratureIndexInput): Promise<void> {
    if (
      !input.extractionId.trim() ||
      !HASH_PATTERN.test(input.documentChecksum) ||
      !HASH_PATTERN.test(input.extractorFingerprint) ||
      input.chunks.length > MAX_INDEX_CHUNKS ||
      input.chunks.some(
        (chunk) =>
          !Number.isSafeInteger(chunk.pageStart) ||
          !Number.isSafeInteger(chunk.pageEnd) ||
          chunk.pageStart < 1 ||
          chunk.pageEnd < chunk.pageStart ||
          !Number.isSafeInteger(chunk.textStart) ||
          !Number.isSafeInteger(chunk.textEnd) ||
          chunk.textStart < 0 ||
          chunk.textEnd < chunk.textStart ||
          !chunk.content.trim() ||
          chunk.content.length > MAX_CHUNK_CHARS ||
          (chunk.sectionTitle?.length ?? 0) > MAX_SECTION_TITLE_CHARS
      )
    ) {
      throw new Error('Literature index input is invalid.')
    }
    await this.client.$transaction(async (transaction) => {
      await migrationSqlExecutor.execute(
        transaction,
        `DELETE FROM "LiteratureIndexDocument" WHERE "extractionId" = ?`,
        input.extractionId
      )
      await migrationSqlExecutor.execute(
        transaction,
        `INSERT INTO "LiteratureIndexDocument" ("extractionId", "documentChecksum", "extractorFingerprint", "indexSchemaVersion", "chunkCount") VALUES (?, ?, ?, ?, ?)`,
        input.extractionId,
        input.documentChecksum,
        input.extractorFingerprint,
        LITERATURE_INDEX_SCHEMA_VERSION,
        input.chunks.length
      )
      for (const chunk of input.chunks) {
        await migrationSqlExecutor.execute(
          transaction,
          `INSERT INTO "LiteratureIndexChunk" ("extractionId", "pageStart", "pageEnd", "textStart", "textEnd", "sectionTitle", "content", "contentChecksum") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          input.extractionId,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.textStart,
          chunk.textEnd,
          chunk.sectionTitle ?? null,
          chunk.content,
          sha256(chunk.content)
        )
      }
    })
  }

  async search(input: SearchLiteratureIndexInput): Promise<LiteratureSearchResult[]> {
    if (input.extractionIds.length === 0 || input.extractionIds.length > 3) {
      log.info('Literature BM25 search skipped', {
        reason: 'invalid-extraction-count',
        extractionCount: input.extractionIds.length,
        bm25Used: false,
        bm25ResultCount: 0
      })
      return []
    }
    const query = normalizeSearchQuery(input.query)
    if (!query) {
      log.info('Literature BM25 search skipped', {
        reason: 'empty-query',
        extractionCount: input.extractionIds.length,
        queryLength: input.query.length,
        bm25Used: false,
        bm25ResultCount: 0
      })
      return []
    }
    const limit = Math.min(Math.max(input.limit ?? 8, 1), MAX_SEARCH_RESULTS)
    const candidateLimit = Math.min(limit * SEARCH_CANDIDATE_MULTIPLIER, MAX_SEARCH_RESULTS)
    const rows = await migrationSqlExecutor.query<
      Array<{
        extractionId: string
        pageStart: number
        pageEnd: number
        textStart: number
        textEnd: number
        sectionTitle: string | null
        content: string
        rank: number
      }>
    >(
      this.client,
      `SELECT chunk."extractionId", chunk."pageStart", chunk."pageEnd", chunk."textStart", chunk."textEnd", chunk."sectionTitle", chunk."content", bm25("LiteratureIndexChunkFts", 2.0, 1.0) AS "rank"
       FROM "LiteratureIndexChunkFts"
       JOIN "LiteratureIndexChunk" AS chunk ON chunk."id" = "LiteratureIndexChunkFts"."rowid"
       WHERE "LiteratureIndexChunkFts" MATCH ? AND chunk."extractionId" IN (${input.extractionIds.map(() => '?').join(', ')})
       ORDER BY "rank" ASC, chunk."id" ASC
       LIMIT ?`,
      query,
      ...input.extractionIds,
      candidateLimit
    )
    const candidates = rows.map(({ sectionTitle, ...row }) =>
      withRelativeScore(
        {
          ...row,
          ...(sectionTitle ? { sectionTitle } : {})
        },
        rows[0]?.rank ?? 0
      )
    )
    const qualified = candidates.filter(
      ({ relativeScore }, index) => index === 0 || relativeScore >= MIN_RELATIVE_BM25_SCORE
    )
    const results: LiteratureSearchResult[] = []
    let overlapFilteredCount = 0
    for (const candidate of qualified) {
      const overlapsSelected = results.some(
        (selected) => resultOverlapRatio(candidate, selected) >= MAX_RESULT_OVERLAP_RATIO
      )
      if (overlapsSelected) {
        overlapFilteredCount += 1
        continue
      }
      results.push(candidate)
      if (results.length === limit) break
    }
    log.info('Literature BM25 search completed', {
      extractionCount: input.extractionIds.length,
      queryLength: input.query.length,
      limit,
      candidateLimit,
      candidateCount: candidates.length,
      relativeScoreThreshold: MIN_RELATIVE_BM25_SCORE,
      qualityFilteredCount: candidates.length - qualified.length,
      overlapFilteredCount,
      bestRank: candidates[0]?.rank ?? null,
      lowestReturnedRelativeScore: results.at(-1)?.relativeScore ?? null,
      bm25Used: true,
      bm25ResultCount: results.length
    })
    return results
  }
}

export { LiteratureFullTextIndex, literatureIndexPath }
export type {
  LiteratureIndexChunk,
  LiteratureSearchResult,
  ReplaceLiteratureIndexInput,
  SearchLiteratureIndexInput
}
