import { randomUUID } from 'node:crypto'

import {
  type FilterSessionPdfContextCandidatesRequest,
  type FilterSessionPdfContextCandidatesResult,
  MAX_SESSION_PDF_CONTEXTS,
  type LinkSessionPdfContextRequest,
  type SessionPdfBinding,
  type SessionPdfContext,
  type SessionPdfContextSource,
  type SessionRuntimeContext,
  type UnlinkSessionPdfContextRequest
} from '../../shared/session-persistence'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import { createLogger, errorLogFields } from '../logger'
import { inspectPdfPageCount } from '../uploads/attachment-media'
import type { SessionPersistenceCoordinator } from './coordinator'

const log = createLogger('literature-reading-context')

type SessionPdfContextOwnerOptions = Readonly<{
  inputs: Pick<ImmutableInputAuthority, 'resolveVersion' | 'resolveContent'>
  sessions: Pick<
    SessionPersistenceCoordinator,
    'readSessionRuntimeContext' | 'patchSessionRuntimeContext'
  >
}>

const isPdf = (name: string, contentType: string | undefined): boolean =>
  contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
  name.toLowerCase().endsWith('.pdf')

class SessionPdfContextOwner {
  private readonly pageCounts = new Map<string, Promise<number>>()

  constructor(private readonly options: SessionPdfContextOwnerOptions) {}

  async filterCandidates(
    request: FilterSessionPdfContextCandidatesRequest
  ): Promise<FilterSessionPdfContextCandidatesResult> {
    const sources: SessionPdfContextSource[] = []
    const seen = new Set<string>()
    for (const source of request.sources) {
      const identity = `${source.sourceKind}:${source.sourceVersionId}`
      if (seen.has(identity)) continue
      seen.add(identity)
      const input = await this.options.inputs.resolveVersion({
        projectId: request.projectId,
        sourceKind: source.sourceKind,
        inputFileVersionId: source.sourceVersionId
      })
      if (!input || !isPdf(input.filename, input.contentType)) continue
      try {
        if ((await this.pageCount(input)) > 1) sources.push(source)
      } catch (error) {
        log.warn('PDF context candidate inspection failed', {
          sourceKind: source.sourceKind,
          ...errorLogFields(error)
        })
      }
    }
    log.info('PDF context candidates filtered', {
      requestedCount: request.sources.length,
      eligibleCount: sources.length
    })
    return { sources }
  }

  async link(request: LinkSessionPdfContextRequest): Promise<SessionRuntimeContext> {
    log.info('PDF context link requested', {
      projectId: request.projectId,
      sessionId: request.sessionId,
      sourceCount: request.sources.length,
      expectedRevision: request.expectedRevision
    })
    if (request.sources.length < 1 || request.sources.length > MAX_SESSION_PDF_CONTEXTS) {
      throw new Error(`PDF context accepts up to ${MAX_SESSION_PDF_CONTEXTS} documents.`)
    }
    if (
      request.sources.some(
        ({ sourceKind }) => sourceKind !== 'artifact-version' && sourceKind !== 'upload-version'
      )
    ) {
      throw new Error('PDF context source must be an immutable Artifact or Upload Version.')
    }
    const current = await this.options.sessions.readSessionRuntimeContext(
      request.projectId,
      request.sessionId
    )
    const currentBindings = current.pdfContext?.bindings ?? []
    const currentIdentities = new Set(
      currentBindings.map(({ sourceKind, sourceVersionId }) => `${sourceKind}:${sourceVersionId}`)
    )
    const requestedSources = request.sources.filter(
      ({ sourceKind, sourceVersionId }) =>
        !currentIdentities.has(`${sourceKind}:${sourceVersionId}`)
    )
    if (requestedSources.length === 0) return current

    const bindings: SessionPdfBinding[] = []
    for (const source of requestedSources) {
      const input = await this.options.inputs.resolveVersion({
        projectId: request.projectId,
        sourceKind: source.sourceKind,
        inputFileVersionId: source.sourceVersionId
      })
      if (!input) throw new Error('PDF context Version is unavailable in this Project.')
      if (!isPdf(input.filename, input.contentType)) {
        throw new Error('Only PDF files can be linked to a Session.')
      }
      const pageCount = await this.pageCount(input)
      if (pageCount <= 1) {
        if (request.excludeSinglePage) continue
        throw new Error('Only multi-page PDF files can be linked to a Session.')
      }
      bindings.push({
        version: 1,
        bindingId: randomUUID(),
        sourceKind: input.sourceKind,
        sourceFileId: input.sourceFileId,
        sourceVersionId: input.inputFileVersionId,
        sourceSessionId: input.sourceSessionId,
        name: input.filename,
        mimeType: 'application/pdf',
        sizeBytes: input.sizeBytes,
        checksum: input.checksum,
        linkedAt: Date.now()
      })
    }
    if (bindings.length === 0) return current
    if (currentBindings.length + bindings.length > MAX_SESSION_PDF_CONTEXTS) {
      throw new Error(`A Session can link up to ${MAX_SESSION_PDF_CONTEXTS} PDF documents.`)
    }
    const pdfContext: SessionPdfContext = {
      version: 1,
      bindings: [...currentBindings, ...bindings]
    }
    const runtimeContext = await this.options.sessions.patchSessionRuntimeContext({
      projectId: request.projectId,
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      patch: { pdfContext }
    })
    log.info('PDF context linked', {
      projectId: request.projectId,
      sessionId: request.sessionId,
      linkedCount: bindings.length,
      totalCount: pdfContext.bindings.length,
      runtimeContextRevision: runtimeContext.revision
    })
    return runtimeContext
  }

  async unlink(request: UnlinkSessionPdfContextRequest): Promise<SessionRuntimeContext> {
    log.info('PDF context unlink requested', {
      projectId: request.projectId,
      sessionId: request.sessionId,
      bindingId: request.bindingId,
      expectedRevision: request.expectedRevision
    })
    const current = await this.options.sessions.readSessionRuntimeContext(
      request.projectId,
      request.sessionId
    )
    const bindings = current.pdfContext?.bindings ?? []
    if (!bindings.some(({ bindingId }) => bindingId === request.bindingId)) {
      throw new Error('PDF context binding changed; reload and try again.')
    }
    const remaining = bindings.filter(({ bindingId }) => bindingId !== request.bindingId)
    const runtimeContext = await this.options.sessions.patchSessionRuntimeContext({
      projectId: request.projectId,
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      patch: {
        pdfContext: remaining.length > 0 ? { version: 1, bindings: remaining } : undefined
      }
    })
    log.info('PDF context unlinked', {
      projectId: request.projectId,
      sessionId: request.sessionId,
      bindingId: request.bindingId,
      runtimeContextRevision: runtimeContext.revision
    })
    return runtimeContext
  }

  private pageCount(input: NotebookRunInputFile): Promise<number> {
    const cached = this.pageCounts.get(input.checksum)
    if (cached) return cached
    const pending = this.options.inputs
      .resolveContent(input)
      .then((path) => inspectPdfPageCount(path))
      .catch((error) => {
        this.pageCounts.delete(input.checksum)
        throw error
      })
    if (this.pageCounts.size >= 256) {
      const oldest = this.pageCounts.keys().next().value
      if (oldest) this.pageCounts.delete(oldest)
    }
    this.pageCounts.set(input.checksum, pending)
    return pending
  }
}

export { SessionPdfContextOwner }
export type { SessionPdfContextOwnerOptions }
