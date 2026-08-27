import { createHash } from 'node:crypto'

import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type {
  MessagePdfContextSnapshot,
  PersistedChatSession,
  SessionPdfBinding
} from '../../shared/session-persistence'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import { createLogger, errorLogFields } from '../logger'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { extractPdfText } from '../uploads/attachment-media'
import { LiteratureFullTextIndex, type LiteratureIndexChunk } from './full-text-index'
import type { LiteratureReadDocumentRequest } from './mcp-server'

const log = createLogger('literature-reading-context')
const EXTRACTOR_FINGERPRINT = createHash('sha256')
  .update('open-science-pdfjs-selectable-text-v1')
  .digest('hex')
const DOCUMENT_BATCH_CHARS = 16_000
const INDEX_CHUNK_CHARS = 5_000
const INDEX_CHUNK_OVERLAP_CHARS = 250
const SEARCH_RESULT_LIMIT = 8
const PAGE_MARKER = /^--- Page (\d+) ---$/gm

type LiteratureDocumentReaderOptions = Readonly<{
  storageRoot: string
  inputs: Pick<ImmutableInputAuthority, 'resolveVersion' | 'resolveContent'>
  sessions: Pick<SessionPersistenceCoordinator, 'loadSessionForContinuation'>
}>

type ReadCurrentLiteratureRequest = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId: string
  input: LiteratureReadDocumentRequest
}>

type ExtractedDocument = Readonly<{
  context: SessionPdfBinding
  text: string
  pageCount: number
  truncated: boolean
}>

const activeMessages = (session: PersistedChatSession): PersistedChatSession['messages'] =>
  session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages

const pageSections = (text: string): Array<{ page: number; text: string; start: number }> => {
  const markers = [...text.matchAll(PAGE_MARKER)]
  if (markers.length === 0) return [{ page: 1, text, start: 0 }]
  return markers.map((marker, index) => {
    const start = marker.index
    const end = markers[index + 1]?.index ?? text.length
    return { page: Number(marker[1]), text: text.slice(start, end).trim(), start }
  })
}

const indexChunks = (text: string): LiteratureIndexChunk[] =>
  pageSections(text).flatMap(({ page, text: pageText, start }) => {
    const chunks: LiteratureIndexChunk[] = []
    for (
      let offset = 0;
      offset < pageText.length;
      offset += INDEX_CHUNK_CHARS - INDEX_CHUNK_OVERLAP_CHARS
    ) {
      const rawContent = pageText.slice(offset, offset + INDEX_CHUNK_CHARS)
      const content = rawContent.trim()
      if (!content) continue
      const leadingWhitespace = rawContent.length - rawContent.trimStart().length
      const textStart = start + offset + leadingWhitespace
      chunks.push({
        pageStart: page,
        pageEnd: page,
        textStart,
        textEnd: textStart + content.length,
        content
      })
    }
    return chunks
  })

const encodeCursor = (documentId: string, offset: number): string =>
  Buffer.from(JSON.stringify({ documentId, offset })).toString('base64url')

const cursorOffset = (cursor: string | undefined, documentId: string): number => {
  if (!cursor) return 0
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Literature read cursor is invalid.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Literature read cursor is invalid.')
  }
  const { documentId: cursorDocumentId, offset } = value as Record<string, unknown>
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Literature read cursor is invalid.')
  }
  if (cursorDocumentId !== documentId) throw new Error('Literature read cursor is invalid.')
  return offset
}

class LiteratureDocumentReader {
  private readonly extracted = new Map<string, Promise<Omit<ExtractedDocument, 'context'>>>()
  private readonly indexed = new Set<string>()

  constructor(private readonly options: LiteratureDocumentReaderOptions) {}

  async readCurrent(request: ReadCurrentLiteratureRequest): Promise<unknown> {
    const context = await this.resolveCurrentContext(request)
    if (request.input.query) {
      const bindings = this.selectSearchBindings(context, request.input.documentIds)
      return this.search(
        await Promise.all(
          bindings.map((binding) => this.resolveDocument(request.projectId, binding))
        ),
        request.input.query
      )
    }
    const binding = this.selectSequentialBinding(context, request.input.documentId)
    return this.readBatch(
      await this.resolveDocument(request.projectId, binding),
      request.input.cursor
    )
  }

  private async resolveCurrentContext(
    request: ReadCurrentLiteratureRequest
  ): Promise<MessagePdfContextSnapshot> {
    const session = await this.options.sessions.loadSessionForContinuation(
      request.projectId,
      request.sessionId
    )
    const message = activeMessages(session).find(({ id }) => id === request.promptMessageId)
    const context = message?.role === 'user' ? message.pdfContext : undefined
    if (!context) {
      throw new Error(
        'NO_LINKED_PDF_CONTEXT: The current message has no linked PDF context snapshot.'
      )
    }
    return context
  }

  private selectSearchBindings(
    context: MessagePdfContextSnapshot,
    documentIds: readonly string[] | undefined
  ): readonly SessionPdfBinding[] {
    if (!documentIds) return context.bindings
    if (new Set(documentIds).size !== documentIds.length) {
      throw new Error('Literature document selection contains duplicates.')
    }
    return documentIds.map((documentId) => {
      const binding = context.bindings.find(({ bindingId }) => bindingId === documentId)
      if (!binding) throw new Error('Literature document selection is not linked to this message.')
      return binding
    })
  }

  private selectSequentialBinding(
    context: MessagePdfContextSnapshot,
    documentId: string | undefined
  ): SessionPdfBinding {
    const selectedId = documentId ?? context.activeBindingId ?? context.bindings[0]?.bindingId
    const binding = context.bindings.find(({ bindingId }) => bindingId === selectedId)
    if (!binding) throw new Error('Literature document selection is not linked to this message.')
    return binding
  }

  private async resolveDocument(
    projectId: string,
    context: SessionPdfBinding
  ): Promise<ExtractedDocument> {
    const cached = this.extracted.get(context.checksum)
    const extraction = cached ?? this.extract(projectId, context)
    if (!cached) this.extracted.set(context.checksum, extraction)
    try {
      return { context, ...(await extraction) }
    } catch (error) {
      this.extracted.delete(context.checksum)
      throw error
    }
  }

  private async extract(
    projectId: string,
    context: SessionPdfBinding
  ): Promise<Omit<ExtractedDocument, 'context'>> {
    const input = await this.options.inputs.resolveVersion({
      projectId,
      sourceKind: context.sourceKind,
      inputFileVersionId: context.sourceVersionId,
      expectedSourceFileId: context.sourceFileId
    })
    if (!input || input.checksum !== context.checksum) {
      throw new Error('LINKED_PDF_UNAVAILABLE: The immutable linked PDF Version is unavailable.')
    }
    const path = await this.options.inputs.resolveContent(input)
    const extraction = await extractPdfText(path)
    if (!extraction.text) {
      throw new Error('PDF_TEXT_UNAVAILABLE: The linked PDF has no selectable text.')
    }
    if (extraction.pageCount <= 1) {
      throw new Error('PDF_PAGE_COUNT_UNSUPPORTED: Linked literature must have multiple pages.')
    }
    log.info('Literature PDF extraction ready', {
      sourceKind: context.sourceKind,
      pageCount: extraction.pageCount,
      extractedChars: extraction.text.length,
      extractorTruncated: extraction.truncated
    })
    return extraction
  }

  private readBatch(document: ExtractedDocument, cursor: string | undefined): unknown {
    const offset = cursorOffset(cursor, document.context.bindingId)
    if (offset > document.text.length) throw new Error('Literature read cursor is out of range.')
    const end = Math.min(document.text.length, offset + DOCUMENT_BATCH_CHARS)
    const content = document.text.slice(offset, end)
    const pages = pageSections(content).map(({ page }) => page)
    const nextCursor =
      end < document.text.length ? encodeCursor(document.context.bindingId, end) : null
    log.info('Literature document batch read', {
      scope: 'full-document',
      pageCount: document.pageCount,
      returnedChars: content.length,
      nextCursorPresent: nextCursor !== null,
      fullDocumentReturned: nextCursor === null && offset === 0
    })
    return {
      scope: 'full-document',
      document: {
        id: document.context.bindingId,
        name: document.context.name,
        checksum: document.context.checksum,
        pageCount: document.pageCount,
        extractionTruncated: document.truncated
      },
      passage: {
        pageStart: pages[0] ?? 1,
        pageEnd: pages.at(-1) ?? document.pageCount,
        text: content
      },
      nextCursor
    }
  }

  private async search(documents: readonly ExtractedDocument[], query: string): Promise<unknown> {
    const descriptors = documents.map((document) => ({
      document,
      extractionId: createHash('sha256')
        .update(`${document.context.checksum}:${EXTRACTOR_FINGERPRINT}`)
        .digest('hex')
    }))
    const byExtractionId = new Map(
      descriptors.map(({ document, extractionId }) => [extractionId, document] as const)
    )
    const index = await LiteratureFullTextIndex.open(this.options.storageRoot)
    try {
      for (const { document, extractionId } of descriptors) {
        if (this.indexed.has(extractionId)) continue
        const chunks = indexChunks(document.text)
        await index.replace({
          extractionId,
          documentChecksum: document.context.checksum,
          extractorFingerprint: EXTRACTOR_FINGERPRINT,
          chunks
        })
        this.indexed.add(extractionId)
        log.info('Literature index prepared', {
          pageCount: document.pageCount,
          indexedChunkCount: chunks.length,
          chunkChars: INDEX_CHUNK_CHARS,
          chunkOverlapChars: INDEX_CHUNK_OVERLAP_CHARS
        })
      }
      const passages = await index.search({
        extractionIds: descriptors.map(({ extractionId }) => extractionId),
        query,
        limit: SEARCH_RESULT_LIMIT
      })
      log.info('Literature retrieval completed', {
        retrievalMode: 'bm25',
        documentCount: documents.length,
        bm25Used: true,
        bm25ResultCount: passages.length
      })
      return {
        scope: 'relevant-passages',
        documents: documents.map((document) => ({
          id: document.context.bindingId,
          name: document.context.name,
          checksum: document.context.checksum,
          pageCount: document.pageCount
        })),
        passages: passages.map((passage) => {
          const document = byExtractionId.get(passage.extractionId)
          if (!document) throw new Error('Literature search returned an unknown document.')
          return {
            documentId: document.context.bindingId,
            documentName: document.context.name,
            pageStart: passage.pageStart,
            pageEnd: passage.pageEnd,
            textStart: passage.textStart,
            textEnd: passage.textEnd,
            relevance: {
              bm25Rank: passage.rank,
              relativeScore: passage.relativeScore
            },
            ...(passage.sectionTitle ? { sectionTitle: passage.sectionTitle } : {}),
            content: passage.content
          }
        })
      }
    } catch (error) {
      log.warn('Literature BM25 search failed', errorLogFields(error))
      throw error
    } finally {
      await index.close()
    }
  }
}

export { LiteratureDocumentReader }
export type { LiteratureDocumentReaderOptions, ReadCurrentLiteratureRequest }
