import type {
  Finding as PrismaFinding,
  Review as PrismaReview,
  ReviewFindingDisposition as PrismaReviewFindingDisposition
} from '@prisma/client'

import type {
  CheckStatus,
  CreateReviewInput,
  FindingLocator,
  FindingResolution,
  NewCheck,
  Review,
  ReviewCheck,
  ReviewFindingDisposition,
  ReviewFindingDispositionOutcome,
  ReviewFindingDispositionTrigger,
  ReviewerLogEntry,
  ReviewLifecycle,
  ReviewOutcome,
  ScopeBlock,
  TurnScope,
  UpdateReviewPatch
} from '../../shared/reviewer'
import { createLogger } from '../logger'

const CURRENT_REVIEW_CODEC_VERSION = 1
const LEGACY_REVIEW_CODEC_VERSION = 0
const INVALID_SCOPE_MESSAGE = 'Stored Review scope is invalid.'

const log = createLogger('reviewer:persistence-codec')

type VersionedPrismaReview = PrismaReview & { codecVersion?: number }
type ReviewScopeRow = Pick<PrismaReview, 'id' | 'scope' | 'turnMessageId'> & {
  codecVersion?: number
}

type EncodedReview = {
  codecVersion: number
  scope: string
  lifecycle: ReviewLifecycle
  outcome: ReviewOutcome | null
  errorMessage: string | null
  model: string
  reviewerLog: string
}

type EncodedFinding = {
  status: CheckStatus
  resolution: FindingResolution
  claim: string
  evidence: string
  locator: string
  artifactVersionId: string | null
  artifactBindingState: 'scope_validated' | 'legacy_unverified'
  sortIndex: number
}

type ReviewPersistenceCodec = {
  readonly currentVersion: number
  encodeReview(input: CreateReviewInput): EncodedReview
  encodeReviewPatch(patch: UpdateReviewPatch): Record<string, unknown>
  encodeFinding(check: NewCheck, sortIndex: number): EncodedFinding
  encodeDisposition(
    trigger: ReviewFindingDispositionTrigger,
    outcome: ReviewFindingDispositionOutcome
  ): { trigger: ReviewFindingDispositionTrigger; outcome: ReviewFindingDispositionOutcome }
  decodeReviewScope(row: ReviewScopeRow): TurnScope | undefined
  decodeReview(row: VersionedPrismaReview): Review
  decodeFinding(row: PrismaFinding, codecVersion?: number): ReviewCheck
  decodeDisposition(row: PrismaReviewFindingDisposition): ReviewFindingDisposition | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asOptionalString = (value: unknown): string | undefined =>
  value === undefined ? undefined : asString(value)

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const parseJson = (value: string): { valid: true; value: unknown } | { valid: false } => {
  try {
    return { valid: true, value: JSON.parse(value) as unknown }
  } catch {
    return { valid: false }
  }
}

const emptyScope = (turnMessageId: string): TurnScope => ({
  turnMessageId,
  blocks: [],
  artifactVersionIds: []
})

const decodeScopeBlock = (value: unknown): ScopeBlock | undefined => {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const sourceId = asString(value.sourceId)
  const contentHash = asString(value.contentHash)
  const blockIndex = asFiniteNumber(value.blockIndex)
  if (
    id === undefined ||
    (value.kind !== 'message' && value.kind !== 'activity') ||
    sourceId === undefined ||
    blockIndex === undefined ||
    !Number.isSafeInteger(blockIndex) ||
    blockIndex < 0 ||
    contentHash === undefined
  ) {
    return undefined
  }
  return { id, kind: value.kind, sourceId, blockIndex, contentHash }
}

const decodeScopeValue = (value: unknown): TurnScope | undefined => {
  if (!isRecord(value)) return undefined
  const turnMessageId = asString(value.turnMessageId)
  if (!turnMessageId || !Array.isArray(value.blocks) || !Array.isArray(value.artifactVersionIds)) {
    return undefined
  }
  const blocks = value.blocks.map(decodeScopeBlock)
  if (blocks.some((block) => block === undefined)) return undefined
  if (!value.artifactVersionIds.every((id): id is string => typeof id === 'string')) {
    return undefined
  }
  const agentFrameId = asOptionalString(value.agentFrameId)
  const messageBranchId = asOptionalString(value.messageBranchId)
  if (
    (value.agentFrameId !== undefined && agentFrameId === undefined) ||
    (value.messageBranchId !== undefined && messageBranchId === undefined)
  ) {
    return undefined
  }
  return {
    turnMessageId,
    ...(agentFrameId ? { agentFrameId } : {}),
    ...(messageBranchId ? { messageBranchId } : {}),
    blocks: blocks as ScopeBlock[],
    artifactVersionIds: value.artifactVersionIds
  }
}

const decodeLocatorValue = (value: unknown): FindingLocator | undefined => {
  if (!isRecord(value) || !isRecord(value.blockRef)) return undefined
  const blockIndex = asFiniteNumber(value.blockRef.blockIndex)
  const messageId = asOptionalString(value.blockRef.messageId)
  const activityId = asOptionalString(value.blockRef.activityId)
  const contentHash = asString(value.contentHash)
  if (
    blockIndex === undefined ||
    !Number.isSafeInteger(blockIndex) ||
    blockIndex < 0 ||
    contentHash === undefined ||
    (value.blockRef.messageId !== undefined && messageId === undefined) ||
    (value.blockRef.activityId !== undefined && activityId === undefined)
  ) {
    return undefined
  }
  return {
    blockRef: {
      ...(messageId ? { messageId } : {}),
      ...(activityId ? { activityId } : {}),
      blockIndex
    },
    contentHash
  }
}

const decodeToolFields = (
  value: Record<string, unknown>,
  fallbackToolName?: string
): ReviewerLogEntry & { kind: 'tool' } => {
  const exitCode =
    value.exitCode === null
      ? null
      : asFiniteNumber(value.exitCode) !== undefined && Number.isSafeInteger(value.exitCode)
        ? (value.exitCode as number)
        : undefined
  return {
    kind: 'tool',
    toolName: asString(value.toolName) ?? fallbackToolName ?? 'tool',
    ...(asString(value.title) !== undefined ? { title: value.title as string } : {}),
    ...(asString(value.rawInput) !== undefined ? { rawInput: value.rawInput as string } : {}),
    ...(asString(value.rawOutput) !== undefined ? { rawOutput: value.rawOutput as string } : {}),
    ...(value.status === 'ok' || value.status === 'error' ? { status: value.status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {})
  }
}

const decodeCurrentLogEntry = (value: unknown): ReviewerLogEntry | undefined => {
  if (!isRecord(value)) return undefined
  if (value.kind === 'thought' || value.kind === 'message') {
    const text = asString(value.text)
    return text === undefined ? undefined : { kind: value.kind, text }
  }
  if (
    value.kind === 'tool' &&
    typeof value.toolName === 'string' &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.rawInput === undefined || typeof value.rawInput === 'string') &&
    (value.rawOutput === undefined || typeof value.rawOutput === 'string') &&
    (value.status === undefined || value.status === 'ok' || value.status === 'error') &&
    (value.exitCode === undefined ||
      value.exitCode === null ||
      (typeof value.exitCode === 'number' &&
        Number.isFinite(value.exitCode) &&
        Number.isSafeInteger(value.exitCode)))
  ) {
    return decodeToolFields(value)
  }
  return undefined
}

const decodeReviewerLogValue = (
  value: unknown
): { entries: ReviewerLogEntry[]; discarded: boolean } => {
  if (!Array.isArray(value)) return { entries: [], discarded: true }
  const entries: ReviewerLogEntry[] = []
  let discarded = false
  for (let index = 0; index < value.length; index++) {
    const current = value[index]
    const decoded = decodeCurrentLogEntry(current)
    if (decoded) {
      entries.push(decoded)
      continue
    }
    if (isRecord(current) && current.kind === 'tool_call') {
      const next = value[index + 1]
      const merged =
        isRecord(next) && next.kind === 'tool_result' ? { ...current, ...next } : current
      entries.push(decodeToolFields(merged))
      if (merged !== current) index++
      continue
    }
    if (isRecord(current) && current.kind === 'tool_result') {
      entries.push(decodeToolFields(current))
      continue
    }
    discarded = true
  }
  return { entries, discarded }
}

const encodeScope = (scope: TurnScope): string => {
  const decoded = decodeScopeValue(scope)
  if (!decoded) throw new Error('Review scope is invalid.')
  return JSON.stringify(decoded)
}

const encodeReviewerLog = (reviewerLog: ReviewerLogEntry[]): string => {
  const decoded = decodeReviewerLogValue(reviewerLog)
  if (decoded.discarded || decoded.entries.length !== reviewerLog.length) {
    throw new Error('Reviewer log is invalid.')
  }
  return JSON.stringify(decoded.entries)
}

const encodeLocator = (locator: FindingLocator | undefined): string => {
  if (locator === undefined) return '{}'
  const decoded = decodeLocatorValue(locator)
  if (!decoded) throw new Error('Finding locator is invalid.')
  return JSON.stringify(decoded)
}

const codecVersionOf = (row: { codecVersion?: number }): number => {
  const value = row.codecVersion
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : LEGACY_REVIEW_CODEC_VERSION
}

const warnDecodeIssue = (
  rowKind: 'Review' | 'Finding' | 'ReviewFindingDisposition',
  rowId: string,
  field: string,
  codecVersion: number
): void => {
  log.warn('degraded invalid persisted reviewer data', { rowKind, rowId, field, codecVersion })
}

const decodeLifecycle = (value: string): ReviewLifecycle =>
  value === 'running' || value === 'complete' || value === 'error' ? value : 'error'

const decodeOutcome = (value: string | null): ReviewOutcome | null =>
  value === 'pass' || value === 'flagged' ? value : null

const decodeStatus = (value: string): CheckStatus =>
  value === 'pass' || value === 'warn' || value === 'fail' ? value : 'warn'

const decodeResolution = (value: string): FindingResolution =>
  value === 'resolved' || value === 'unaddressed' ? value : 'open'

const assertReviewEnums = (lifecycle: ReviewLifecycle, outcome: ReviewOutcome | null): void => {
  if (decodeLifecycle(lifecycle) !== lifecycle) throw new Error('Review lifecycle is invalid.')
  if (outcome !== null && decodeOutcome(outcome) !== outcome) {
    throw new Error('Review outcome is invalid.')
  }
}

const assertFindingEnums = (status: CheckStatus, resolution: FindingResolution): void => {
  if (decodeStatus(status) !== status) throw new Error('Finding status is invalid.')
  if (decodeResolution(resolution) !== resolution) throw new Error('Finding resolution is invalid.')
}

const encodeReview = (input: CreateReviewInput): EncodedReview => {
  const lifecycle = input.lifecycle ?? 'running'
  const outcome = input.outcome ?? null
  assertReviewEnums(lifecycle, outcome)
  return {
    codecVersion: CURRENT_REVIEW_CODEC_VERSION,
    scope: encodeScope(input.scope),
    lifecycle,
    outcome,
    errorMessage: input.errorMessage ?? null,
    model: input.model ?? '',
    reviewerLog: encodeReviewerLog(input.reviewerLog ?? [])
  }
}

const encodeReviewPatch = (patch: UpdateReviewPatch): Record<string, unknown> => {
  if (patch.lifecycle !== undefined && decodeLifecycle(patch.lifecycle) !== patch.lifecycle) {
    throw new Error('Review lifecycle is invalid.')
  }
  if (
    patch.outcome !== undefined &&
    patch.outcome !== null &&
    decodeOutcome(patch.outcome) !== patch.outcome
  ) {
    throw new Error('Review outcome is invalid.')
  }
  return {
    ...(patch.scope !== undefined ? { scope: encodeScope(patch.scope) } : {}),
    ...(patch.lifecycle !== undefined ? { lifecycle: patch.lifecycle } : {}),
    ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
    ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.reviewerLog !== undefined
      ? { reviewerLog: encodeReviewerLog(patch.reviewerLog) }
      : {})
  }
}

const encodeFinding = (check: NewCheck, sortIndex: number): EncodedFinding => {
  const resolution = check.resolution ?? 'open'
  assertFindingEnums(check.status, resolution)
  return {
    status: check.status,
    resolution,
    claim: check.claim,
    evidence: check.evidence,
    locator: encodeLocator(check.locator),
    artifactVersionId: check.artifactVersionId ?? null,
    artifactBindingState: check.artifactVersionId ? 'scope_validated' : 'legacy_unverified',
    sortIndex: check.sortIndex ?? sortIndex
  }
}

const decodeReviewScope = (row: ReviewScopeRow): TurnScope | undefined => {
  const parsedScope = parseJson(row.scope)
  const scope = parsedScope.valid ? decodeScopeValue(parsedScope.value) : undefined
  if (scope === undefined) {
    warnDecodeIssue('Review', row.id, 'scope', codecVersionOf(row))
  }
  return scope
}

const decodeReview = (row: VersionedPrismaReview): Review => {
  const codecVersion = codecVersionOf(row)
  const scope = decodeReviewScope(row)
  const parsedLog = parseJson(row.reviewerLog)
  const reviewerLog = parsedLog.valid
    ? decodeReviewerLogValue(parsedLog.value)
    : { entries: [], discarded: true }
  const storedLifecycle = decodeLifecycle(row.lifecycle)
  const storedOutcome = decodeOutcome(row.outcome)
  const invalidScope = scope === undefined
  const invalidLifecycle = storedLifecycle !== row.lifecycle
  const invalidOutcome = row.outcome !== null && storedOutcome === null

  if (reviewerLog.discarded) warnDecodeIssue('Review', row.id, 'reviewerLog', codecVersion)
  if (invalidLifecycle) warnDecodeIssue('Review', row.id, 'lifecycle', codecVersion)
  if (invalidOutcome) warnDecodeIssue('Review', row.id, 'outcome', codecVersion)
  if (codecVersion > CURRENT_REVIEW_CODEC_VERSION) {
    warnDecodeIssue('Review', row.id, 'codecVersion', codecVersion)
  }

  const failClosed = invalidScope || invalidLifecycle || invalidOutcome
  const existingError = row.errorMessage ?? undefined
  const errorMessage = invalidScope
    ? [existingError, INVALID_SCOPE_MESSAGE].filter(Boolean).join(' ')
    : existingError
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    turnMessageId: row.turnMessageId,
    scope: scope ?? emptyScope(row.turnMessageId),
    lifecycle: failClosed ? 'error' : storedLifecycle,
    outcome: failClosed ? null : storedOutcome,
    ...(errorMessage ? { errorMessage } : {}),
    model: row.model,
    reviewerLog: reviewerLog.entries,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}

const decodeFinding = (
  row: PrismaFinding,
  codecVersion = LEGACY_REVIEW_CODEC_VERSION
): ReviewCheck => {
  const parsedLocator = parseJson(row.locator)
  const emptyLocator =
    parsedLocator.valid &&
    isRecord(parsedLocator.value) &&
    Object.keys(parsedLocator.value).length === 0
  const locator = parsedLocator.valid ? decodeLocatorValue(parsedLocator.value) : undefined
  if (!emptyLocator && locator === undefined) {
    warnDecodeIssue('Finding', row.id, 'locator', codecVersion)
  }
  const status = decodeStatus(row.status)
  if (status !== row.status) warnDecodeIssue('Finding', row.id, 'status', codecVersion)
  const resolution = decodeResolution(row.resolution)
  if (resolution !== row.resolution) warnDecodeIssue('Finding', row.id, 'resolution', codecVersion)
  const artifactBindingState =
    row.artifactBindingState === 'scope_validated' ? 'scope_validated' : 'legacy_unverified'
  if (
    row.artifactBindingState !== 'scope_validated' &&
    row.artifactBindingState !== 'legacy_unverified'
  ) {
    warnDecodeIssue('Finding', row.id, 'artifactBindingState', codecVersion)
  }
  return {
    id: row.id,
    reviewId: row.reviewId,
    status,
    resolution,
    claim: row.claim,
    evidence: row.evidence,
    ...(locator ? { locator } : {}),
    ...(row.artifactVersionId ? { artifactVersionId: row.artifactVersionId } : {}),
    artifactBindingState,
    sortIndex: row.sortIndex,
    reflagCount: row.reflagCount ?? 0
  }
}

const DISPOSITION_TRIGGERS = new Set<ReviewFindingDispositionTrigger>([
  'review_submission',
  'loop_terminated',
  'correction_failed',
  'aborted'
])
const DISPOSITION_OUTCOMES = new Set<ReviewFindingDispositionOutcome>([
  'still_open',
  'resolved',
  'unaddressed'
])

const encodeDisposition = (
  trigger: ReviewFindingDispositionTrigger,
  outcome: ReviewFindingDispositionOutcome
): { trigger: ReviewFindingDispositionTrigger; outcome: ReviewFindingDispositionOutcome } => {
  if (!DISPOSITION_TRIGGERS.has(trigger)) throw new Error('Finding disposition trigger is invalid.')
  if (!DISPOSITION_OUTCOMES.has(outcome)) throw new Error('Finding disposition outcome is invalid.')
  return { trigger, outcome }
}

const decodeDisposition = (
  row: PrismaReviewFindingDisposition
): ReviewFindingDisposition | undefined => {
  const trigger = row.trigger as ReviewFindingDispositionTrigger
  const outcome = row.outcome as ReviewFindingDispositionOutcome
  if (!DISPOSITION_TRIGGERS.has(trigger)) {
    warnDecodeIssue('ReviewFindingDisposition', row.id, 'trigger', LEGACY_REVIEW_CODEC_VERSION)
    return undefined
  }
  if (!DISPOSITION_OUTCOMES.has(outcome)) {
    warnDecodeIssue('ReviewFindingDisposition', row.id, 'outcome', LEGACY_REVIEW_CODEC_VERSION)
    return undefined
  }
  return {
    id: row.id,
    sourceFindingId: row.sourceFindingId,
    ...(row.causeReviewId ? { causeReviewId: row.causeReviewId } : {}),
    sequence: row.sequence,
    trigger,
    outcome,
    ...(row.note ? { note: row.note } : {}),
    ...(row.assessedArtifactVersionId
      ? { assessedArtifactVersionId: row.assessedArtifactVersionId }
      : {}),
    createdAt: row.createdAt.getTime()
  }
}

const reviewPersistenceCodec: ReviewPersistenceCodec = {
  currentVersion: CURRENT_REVIEW_CODEC_VERSION,
  encodeReview,
  encodeReviewPatch,
  encodeFinding,
  encodeDisposition,
  decodeReviewScope,
  decodeReview,
  decodeFinding,
  decodeDisposition
}

export { reviewPersistenceCodec }
export type { ReviewPersistenceCodec }
