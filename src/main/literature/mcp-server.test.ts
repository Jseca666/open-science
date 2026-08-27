import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import {
  LITERATURE_MCP_SERVER_NAME,
  LITERATURE_READ_DOCUMENT_TOOL_NAME,
  createLiteratureMcpServer
} from './mcp-server'

describe('Literature MCP server', () => {
  it('exposes one linked-document read tool and forwards bounded retrieval input', async () => {
    const readDocument = vi.fn().mockResolvedValue({
      scope: 'relevant-passages',
      passages: [{ pageStart: 3, pageEnd: 3, text: 'Relevant evidence.' }]
    })
    const server = createLiteratureMcpServer({ readDocument })
    const client = new Client({ name: 'literature-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const tools = (await client.listTools()).tools
      expect(tools.map(({ name }) => name)).toEqual([LITERATURE_READ_DOCUMENT_TOOL_NAME])
      expect(tools[0]?.description).toContain('instead of Notebook')
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { query: 'retrieval evaluator' }
      })

      expect(readDocument).toHaveBeenCalledWith({ query: 'retrieval evaluator' })
      expect(result.structuredContent).toMatchObject({
        scope: 'relevant-passages',
        passages: [expect.objectContaining({ pageStart: 3 })]
      })
      expect(LITERATURE_MCP_SERVER_NAME).toBe('open-science-literature')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns a structured unavailable result when the current turn has no PDF snapshot', async () => {
    const server = createLiteratureMcpServer({
      readDocument: vi.fn(async () => {
        throw new Error('NO_LINKED_PDF_CONTEXT: No linked PDF is active for this message.')
      })
    })
    const client = new Client({ name: 'literature-error-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      await expect(
        client.callTool({ name: LITERATURE_READ_DOCUMENT_TOOL_NAME, arguments: {} })
      ).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'NO_LINKED_PDF_CONTEXT', message: expect.any(String) }
        }
      })
    } finally {
      await client.close()
      await server.close()
    }
  })
})
