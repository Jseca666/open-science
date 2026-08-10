import { describe, expect, it } from 'vitest'

import type {
  Finding as PrismaFinding,
  Review as PrismaReview,
  ReviewFindingDisposition as PrismaReviewFindingDisposition
} from '@prisma/client'

import type { CreateReviewInput, ReviewerLogEntry, TurnScope } from '../../shared/reviewer'
import { reviewPersistenceCodec } from './persistence-codec'

const scope = (turnMessageId = 'turn-1'): TurnScope => ({
  turnMessageId,
  blocks: [
    {
      id: `message:${turnMessageId}`,
      kind: 'message' as const,
      sourceId: turnMessageId,
      blockIndex: 0,
      contentHash: 'hash-1'
    }
  ],
  artifactVersionIds: ['artifact-1']
})

const reviewRow = (patch: Partial<PrismaReview> = {}): PrismaReview => ({
  id: 'review-1',
  codecVersion: 1,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'turn-1',
  scope: JSON.stringify(scope()),
  lifecycle: 'complete',
  outcome: 'pass',
  errorMessage: null,
  model: 'model-1',
  reviewerLog: '[]',
  createdAt: new Date('2026-08-10T00:00:00.000Z'),
  updatedAt: new Date('2026-08-10T00:00:01.000Z'),
  ...patch
})

const findingRow = (patch: Partial<PrismaFinding> = {}): PrismaFinding => ({
  id: 'finding-1',
  reviewId: 'review-1',
  status: 'fail',
  resolution: 'open',
  claim: 'claim',
  evidence: 'evidence',
  locator: JSON.stringify({
    blockRef: { messageId: 'turn-1', blockIndex: 0 },
    contentHash: 'hash-1'
  }),
  artifactVersionId: null,
  artifactBindingState: 'legacy_unverified',
  sortIndex: 0,
  reflagCount: 0,
  ...patch
})

const dispositionRow = (
  patch: Partial<PrismaReviewFindingDisposition> = {}
): PrismaReviewFindingDisposition => ({
  id: 'disposition-1',
  sourceFindingId: 'finding-1',
  causeReviewId: null,
  sequence: 1,
  trigger: 'review_submission',
  outcome: 'resolved',
  note: null,
  assessedArtifactVersionId: null,
  createdAt: new Date('2026-08-10T00:00:02.000Z'),
  ...patch
})

const createInput = (reviewerLog: ReviewerLogEntry[] = []): CreateReviewInput => ({
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'turn-1',
  scope: scope(),
  reviewerLog
})

describe('review persistence codec', () => {
  it('writes the current version and rejects invalid in-memory JSON shapes', () => {
    expect(reviewPersistenceCodec.encodeReview(createInput())).toMatchObject({
      codecVersion: 1,
      lifecycle: 'running',
      outcome: null
    })
    expect(reviewPersistenceCodec.encodeReviewPatch({ lifecycle: 'complete' })).toMatchObject({
      codecVersion: 1,
      lifecycle: 'complete'
    })
    expect(() =>
      reviewPersistenceCodec.encodeReview({
        ...createInput(),
        scope: null as never
      })
    ).toThrow('Review scope is invalid')
    expect(() =>
      reviewPersistenceCodec.encodeReview(
        createInput([{ kind: 'message', text: 42 } as unknown as ReviewerLogEntry])
      )
    ).toThrow('Reviewer log is invalid')
    expect(() =>
      reviewPersistenceCodec.encodeReview({
        ...createInput(),
        lifecycle: 'future-lifecycle' as never
      })
    ).toThrow('Review lifecycle is invalid')
    expect(() =>
      reviewPersistenceCodec.encodeFinding(
        {
          status: 'fail',
          claim: 'claim',
          evidence: 'evidence',
          locator: null as never
        },
        0
      )
    ).toThrow('Finding locator is invalid')
    expect(() =>
      reviewPersistenceCodec.encodeFinding(
        { status: 'future-status' as never, claim: 'claim', evidence: 'evidence' },
        0
      )
    ).toThrow('Finding status is invalid')
  })

  it('fails closed when critical Review fields have valid JSON with invalid shapes', () => {
    const row = reviewRow({
      scope: 'null',
      reviewerLog: '42',
      lifecycle: 'complete',
      outcome: 'pass'
    })
    const decoded = reviewPersistenceCodec.decodeReview(row)

    expect(decoded).toMatchObject({
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] },
      lifecycle: 'error',
      outcome: null,
      reviewerLog: [],
      errorMessage: 'Stored Review scope is invalid.'
    })
    expect(reviewPersistenceCodec.decodeReviewScope(row)).toBeUndefined()
  })

  it('migrates legacy split tool entries and isolates unknown log entries', () => {
    const decoded = reviewPersistenceCodec.decodeReview(
      reviewRow({
        reviewerLog: JSON.stringify([
          { kind: 'thought', text: 'old thought' },
          { kind: 'tool_call', toolName: 'read_turn', title: 'read_turn()' },
          { kind: 'tool_result', status: 'ok', rawOutput: '[block-0]' },
          { kind: 'tool_call', toolName: 42 },
          { kind: 'tool_result', rawOutput: 'must be discarded with the invalid call' },
          { kind: 'tool_result', rawOutput: 'orphan result without a tool identity' },
          { kind: 'unknown_future_kind', data: 'discard me' },
          { kind: 'message', text: 'done' }
        ])
      })
    )

    expect(decoded.reviewerLog).toEqual([
      { kind: 'thought', text: 'old thought' },
      {
        kind: 'tool',
        toolName: 'read_turn',
        title: 'read_turn()',
        rawOutput: '[block-0]',
        status: 'ok'
      },
      { kind: 'message', text: 'done' }
    ])
  })

  it.each([
    ['claude-code', { kind: 'tool', toolName: 'Bash', rawInput: 'python -V' }],
    ['opencode', { kind: 'tool', toolName: 'read_turn', title: 'Read turn' }],
    ['codex-response', { kind: 'thought', text: 'Inspect the evidence.' }],
    [
      'codex-bridge',
      {
        kind: 'tool',
        toolName: 'mcp__open-science-reviewer__submit_findings',
        status: 'ok'
      }
    ]
  ] as const)('round-trips normalized %s reviewer log entries', (_route, entry) => {
    const encoded = reviewPersistenceCodec.encodeReview(createInput([entry as ReviewerLogEntry]))
    const decoded = reviewPersistenceCodec.decodeReview(
      reviewRow({ codecVersion: encoded.codecVersion, reviewerLog: encoded.reviewerLog })
    )
    expect(decoded.reviewerLog).toEqual([entry])
  })

  it('preserves a finding while degrading its malformed locator and unknown enums', () => {
    const decoded = reviewPersistenceCodec.decodeFinding(
      findingRow({
        locator: 'null',
        status: 'future-status',
        resolution: 'future-resolution',
        artifactBindingState: 'future-binding'
      }),
      1
    )

    expect(decoded).toMatchObject({
      id: 'finding-1',
      status: 'warn',
      resolution: 'open',
      artifactBindingState: 'legacy_unverified'
    })
    expect(decoded.locator).toBeUndefined()
  })

  it('isolates dispositions with unknown audit enums', () => {
    expect(() =>
      reviewPersistenceCodec.encodeDisposition('future-trigger' as never, 'resolved')
    ).toThrow('Finding disposition trigger is invalid')
    expect(() =>
      reviewPersistenceCodec.encodeDisposition('review_submission', 'future-outcome' as never)
    ).toThrow('Finding disposition outcome is invalid')
    expect(reviewPersistenceCodec.decodeDisposition(dispositionRow())).toMatchObject({
      trigger: 'review_submission',
      outcome: 'resolved'
    })
    expect(
      reviewPersistenceCodec.decodeDisposition(dispositionRow({ trigger: 'future-trigger' }))
    ).toBeUndefined()
    expect(
      reviewPersistenceCodec.decodeDisposition(dispositionRow({ outcome: 'future-outcome' }))
    ).toBeUndefined()
    expect(
      reviewPersistenceCodec.decodeDispositions([
        dispositionRow(),
        dispositionRow({ id: 'invalid-disposition', trigger: 'future-trigger' })
      ])
    ).toHaveLength(1)
  })
})
