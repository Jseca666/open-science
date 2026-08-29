import { describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  ArtifactFinalizationProofError,
  validateDurableMessageOwnership
} from './provenance-message-finalization'

const createContinuationFixture = (responseToMessageId: string | undefined) => {
  const prompt: PersistedChatSession['messages'][number] = {
    id: 'prompt-1',
    role: 'user',
    content: 'Create the report.',
    status: 'complete',
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  const finalMessage: PersistedChatSession['messages'][number] = {
    id: 'final-1',
    role: 'agent',
    content: 'The report is ready.',
    status: 'complete',
    ...(responseToMessageId ? { responseToMessageId } : {}),
    eventIds: [],
    createdAt: 3,
    updatedAt: 3
  }
  const conversationGraph = createLinearConversationGraph({
    sessionId: 'session-1',
    messages: [prompt, finalMessage],
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 3
  })
  const originalSegment = conversationGraph.runtimeSegments[0]
  originalSegment.endedAt = 2
  conversationGraph.runtimeSegments.push({
    ...originalSegment,
    id: 'runtime-continuation',
    startedAt: 2,
    endedAt: undefined
  })
  conversationGraph.messages[1].runtimeSegmentId = 'runtime-continuation'

  const session: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Artifact continuation',
    cwd: process.cwd(),
    status: 'idle',
    messages: [prompt, finalMessage],
    conversationGraph,
    createdAt: 1,
    updatedAt: 3
  }
  const context = {
    rootFrameId: conversationGraph.rootFrameId,
    agentFrameId: conversationGraph.activeFrameId,
    messageBranchId: conversationGraph.branches[0].id,
    runtimeSegmentId: originalSegment.id,
    promptMessageId: prompt.id,
    messageId: finalMessage.id
  }
  return { context, session }
}

describe('validateDurableMessageOwnership', () => {
  it('accepts a direct prompt continuation completed in a newer Runtime Segment', () => {
    const { context, session } = createContinuationFixture('prompt-1')

    expect(() => validateDurableMessageOwnership(session, context)).not.toThrow()
  })

  it('rejects an unrelated message from a newer Runtime Segment', () => {
    const { context, session } = createContinuationFixture(undefined)

    expect(() => validateDurableMessageOwnership(session, context)).toThrow(
      ArtifactFinalizationProofError
    )
  })
})
