import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LiteratureFullTextIndex } from './full-text-index'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('LiteratureFullTextIndex', () => {
  let root: string
  let index: LiteratureFullTextIndex

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'literature-index-'))
    index = await LiteratureFullTextIndex.open(root)
  })

  afterEach(async () => {
    await index.close()
    await rm(root, { recursive: true, force: true })
  })

  it('replaces PDF chunks and retrieves matching passages with page locators', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 45,
          sectionTitle: 'Introduction',
          content: 'Prior work discussed unrelated observations.'
        },
        {
          pageStart: 3,
          pageEnd: 3,
          textStart: 46,
          textEnd: 102,
          sectionTitle: 'Methods',
          content: 'The cohort used a randomized controlled study design.'
        }
      ]
    })

    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'randomized study' })
    ).resolves.toEqual([
      expect.objectContaining({
        extractionId: 'extraction-1',
        pageStart: 3,
        sectionTitle: 'Methods',
        content: 'The cohort used a randomized controlled study design.'
      })
    ])
  })

  it('deletes stale FTS rows when an extraction is replaced', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 13,
          content: 'legacy phrase'
        }
      ]
    })
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 2,
          pageEnd: 2,
          textStart: 0,
          textEnd: 11,
          content: 'current text'
        }
      ]
    })

    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'legacy' })
    ).resolves.toEqual([])
    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'current' })
    ).resolves.toHaveLength(1)

    await index.deleteExtraction('extraction-1')
    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'current' })
    ).resolves.toEqual([])
  })

  it('filters weak matches relative to the best BM25 candidate', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 66,
          content: 'corrective retrieval augmented generation retrieval corrective generation'
        },
        {
          pageStart: 2,
          pageEnd: 2,
          textStart: 67,
          textEnd: 91,
          content: 'corrective background note'
        },
        {
          pageStart: 3,
          pageEnd: 3,
          textStart: 92,
          textEnd: 119,
          content: 'unrelated control material'
        }
      ]
    })

    const results = await index.search({
      extractionIds: ['extraction-1'],
      query: 'corrective retrieval augmented generation'
    })

    expect(results).toEqual([
      expect.objectContaining({
        pageStart: 1,
        relativeScore: 1
      })
    ])
  })

  it('removes substantially overlapping candidates from the final result set', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 80,
          content: 'retrieval evaluator identifies incorrect documents and corrects retrieval'
        },
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 20,
          textEnd: 100,
          content: 'retrieval evaluator identifies incorrect documents before generation'
        },
        {
          pageStart: 2,
          pageEnd: 2,
          textStart: 101,
          textEnd: 170,
          content: 'retrieval evaluation also improves generation on benchmark datasets'
        }
      ]
    })

    const results = await index.search({
      extractionIds: ['extraction-1'],
      query: 'retrieval evaluator generation'
    })

    expect(results.filter(({ pageStart }) => pageStart === 1)).toHaveLength(1)
    expect(results.some(({ pageStart }) => pageStart === 2)).toBe(true)
  })
})
