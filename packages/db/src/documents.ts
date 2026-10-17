import type { PrismaClient } from './generated/client.js';

export type ChunkHit = {
  chunkId: string;
  documentId: string;
  documentName: string;
  sectionPath: string | null;
  startLine: number;
  endLine: number;
  /** The start of the chunk's text, plain. */
  snippet: string;
  rank: number;
};

/** Full-text search over a workspace's active documents (D-105). The query
 * goes through `websearch_to_tsquery`, which accepts any text without
 * raising errors; every row is filtered by workspace, so one workspace can
 * never see another's chunks. Results are best first. */
export async function searchDocumentChunks(
  prisma: PrismaClient,
  workspaceId: string,
  query: string,
  options: { limit?: number; snippetChars?: number } = {},
): Promise<ChunkHit[]> {
  const q = query.trim().slice(0, 200);
  if (q === '') return [];
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const snippet = options.snippetChars ?? 300;
  return prisma.$queryRaw<ChunkHit[]>`
    SELECT c.id AS "chunkId", c.document_id AS "documentId", d.name AS "documentName",
           c.section_path AS "sectionPath", c.start_line AS "startLine", c.end_line AS "endLine",
           left(c.text, ${snippet}) AS snippet,
           ts_rank_cd(c.search, query)::float8 AS rank
      FROM document_chunks c
      JOIN documents d ON d.workspace_id = c.workspace_id AND d.id = c.document_id
      CROSS JOIN websearch_to_tsquery('english', ${q}) AS query
     WHERE c.workspace_id = ${workspaceId}::uuid
       AND d.status <> 'archived'
       AND c.search @@ query
     ORDER BY rank DESC, c.id
     LIMIT ${limit}`;
}
