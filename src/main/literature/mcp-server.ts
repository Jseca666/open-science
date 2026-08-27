import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const LITERATURE_MCP_SERVER_NAME = 'open-science-literature'
const LITERATURE_READ_DOCUMENT_TOOL_NAME = 'read_document'

type LiteratureReadDocumentRequest = Readonly<{
  documentId?: string
  documentIds?: readonly string[]
  query?: string
  cursor?: string
}>

type LiteratureMcpHandler = Readonly<{
  readDocument: (request: LiteratureReadDocumentRequest) => Promise<unknown>
}>

const createLiteratureMcpServer = (handler: LiteratureMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: LITERATURE_MCP_SERVER_NAME,
    version: '1.0.0'
  })
  server.registerTool(
    LITERATURE_READ_DOCUMENT_TOOL_NAME,
    {
      title: 'Read linked literature',
      description:
        'Read one to three multi-page PDFs explicitly linked to the current Open Science message. Omit query and provide documentId to read one document in bounded sequential batches, following nextCursor until null. Provide query to retrieve relevant passages across documentIds, or all linked documents when documentIds is omitted. Use this instead of Notebook, shell, filesystem, or Python for linked-PDF reading.',
      inputSchema: {
        documentId: z.string().trim().min(1).max(512).optional(),
        documentIds: z.array(z.string().trim().min(1).max(512)).min(1).max(3).optional(),
        query: z.string().trim().min(1).max(2_000).optional(),
        cursor: z.string().trim().min(1).max(128).optional()
      }
    },
    async (request) => {
      try {
        const result = await handler.readDocument(request)
        return {
          structuredContent: result as Record<string, unknown>,
          content: [{ type: 'text' as const, text: JSON.stringify(result) }]
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const known = /^([A-Z][A-Z_]+):\s*(.+)$/.exec(message)
        if (!known) throw error
        const result = { error: { code: known[1], message: known[2] } }
        return {
          isError: true,
          structuredContent: result,
          content: [{ type: 'text' as const, text: JSON.stringify(result) }]
        }
      }
    }
  )
  return server
}

export { LITERATURE_MCP_SERVER_NAME, LITERATURE_READ_DOCUMENT_TOOL_NAME, createLiteratureMcpServer }
export type { LiteratureMcpHandler, LiteratureReadDocumentRequest }
