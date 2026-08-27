import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunInputFile } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { extractPdfText } from '../uploads/attachment-media'
import { LiteratureDocumentReader } from './document-reader'
import { LiteratureFullTextIndex } from './full-text-index'

vi.mock('../uploads/attachment-media', () => ({ extractPdfText: vi.fn() }))

const checksum = 'a'.repeat(64)
const secondChecksum = 'b'.repeat(64)
const input = {
  inputFileVersionId: 'version-1',
  sourceKind: 'upload-version',
  sourceFileId: 'upload-1',
  sourceVersionNumber: 1,
  sourceProjectId: 'project-1',
  sourceSessionId: 'session-1',
  filename: 'paper.pdf',
  contentType: 'application/pdf',
  sizeBytes: 42,
  checksum,
  storageKey: 'uploads/version-1.pdf',
  association: 'turn-attached'
} satisfies NotebookRunInputFile
const secondInput = {
  ...input,
  inputFileVersionId: 'version-2',
  sourceFileId: 'upload-2',
  filename: 'second.pdf',
  checksum: secondChecksum,
  storageKey: 'uploads/version-2.pdf'
} satisfies NotebookRunInputFile

const session = (withContext = true): PersistedChatSession =>
  ({
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'Summarize the paper.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        ...(withContext
          ? {
              pdfContext: {
                version: 1,
                bindings: [
                  {
                    version: 1,
                    bindingId: 'binding-1',
                    sourceKind: 'upload-version',
                    sourceFileId: 'upload-1',
                    sourceVersionId: 'version-1',
                    sourceSessionId: 'session-1',
                    name: 'paper.pdf',
                    mimeType: 'application/pdf',
                    sizeBytes: 42,
                    checksum,
                    linkedAt: 1
                  },
                  {
                    version: 1,
                    bindingId: 'binding-2',
                    sourceKind: 'upload-version',
                    sourceFileId: 'upload-2',
                    sourceVersionId: 'version-2',
                    sourceSessionId: 'session-1',
                    name: 'second.pdf',
                    mimeType: 'application/pdf',
                    sizeBytes: 42,
                    checksum: secondChecksum,
                    linkedAt: 2
                  }
                ],
                activeBindingId: 'binding-1',
                readingPosition: { pageNumber: 3, pageCount: 3 }
              }
            }
          : {})
      }
    ]
  }) as unknown as PersistedChatSession

describe('LiteratureDocumentReader', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'literature-reader-'))
    vi.mocked(extractPdfText).mockResolvedValue({
      text: [
        '--- Page 1 ---',
        'Prior work discussed unrelated observations.',
        '--- Page 2 ---',
        'The method uses a retrieval evaluator.',
        '--- Page 3 ---',
        'The evaluator identifies incorrect retrieved documents.'
      ].join('\n'),
      pageCount: 3,
      truncated: false
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('reads only the current message PDF snapshot and uses BM25 for a query', async () => {
    const loadSessionForContinuation = vi.fn(async () => session())
    const resolveVersion = vi.fn(async ({ inputFileVersionId }) =>
      inputFileVersionId === 'version-2' ? secondInput : input
    )
    const resolveContent = vi.fn(async (resolved) =>
      join(root, resolved.inputFileVersionId === 'version-2' ? 'second.pdf' : 'paper.pdf')
    )
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation },
      inputs: { resolveVersion, resolveContent }
    })

    const result = await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { query: 'incorrect retrieved documents' }
    })

    expect(result).toMatchObject({
      scope: 'relevant-passages',
      documents: [
        { id: 'binding-1', name: 'paper.pdf', pageCount: 3 },
        { id: 'binding-2', name: 'second.pdf', pageCount: 3 }
      ]
    })
    expect((result as { passages: unknown[] }).passages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: 'binding-1', pageStart: 3 }),
        expect.objectContaining({ documentId: 'binding-2', pageStart: 3 })
      ])
    )
    expect(resolveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ inputFileVersionId: 'version-1' })
    )
  })

  it('indexes long pages with a small overlap between adjacent chunks', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: `--- Page 1 ---\n${'a'.repeat(5_200)}\n--- Page 2 ---\ncontinuation`,
      pageCount: 2,
      truncated: false
    })
    const replace = vi.spyOn(LiteratureFullTextIndex.prototype, 'replace')
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
    })

    await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { documentIds: ['binding-1'], query: 'aaaa' }
    })

    const chunks = (replace.mock.calls[0]?.[0].chunks ?? []).filter(
      ({ pageStart }) => pageStart === 1
    )
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.textEnd - (chunks[1]?.textStart ?? 0)).toBe(250)
  })

  it('reads sequential batches from the active document and binds the cursor to it', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: `--- Page 1 ---\n${'a'.repeat(17_000)}\n--- Page 2 ---\nend`,
      pageCount: 2,
      truncated: false
    })
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      inputs: {
        resolveVersion: vi.fn(async ({ inputFileVersionId }) =>
          inputFileVersionId === 'version-2' ? secondInput : input
        ),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
    })

    const first = (await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: {}
    })) as { document: { id: string }; nextCursor: string }

    expect(first.document.id).toBe('binding-1')
    await expect(
      reader.readCurrent({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-1',
        input: { documentId: 'binding-2', cursor: first.nextCursor }
      })
    ).rejects.toThrow('cursor is invalid')
  })

  it('fails closed when the active message has no linked PDF snapshot', async () => {
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session(false)) },
      inputs: { resolveVersion: vi.fn(), resolveContent: vi.fn() }
    })

    await expect(
      reader.readCurrent({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-1',
        input: {}
      })
    ).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
  })
})
