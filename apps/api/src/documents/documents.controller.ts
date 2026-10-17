import {
  chunkDocument,
  CreateDocumentRequest,
  DOCUMENT_LIMITS,
  documentFormatFor,
  extractDocumentText,
  type DocumentHit,
  type DocumentSummary,
} from '@datasentinel/contracts';
import { Prisma, searchDocumentChunks, type PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';

const documentSelect = {
  id: true,
  name: true,
  format: true,
  sizeChars: true,
  chunkCount: true,
  sourceId: true,
  status: true,
  createdAt: true,
} as const;

type Row = Prisma.DocumentGetPayload<{ select: typeof documentSelect }>;

const toSummary = (d: Row): DocumentSummary => ({
  id: d.id,
  name: d.name,
  format: d.format,
  sizeChars: d.sizeChars,
  chunkCount: d.chunkCount,
  sourceId: d.sourceId,
  status: d.status === 'archived' ? 'archived' : 'active',
  createdAt: d.createdAt.toISOString(),
});

const notFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'document_not_found', 'Document not found.');

/** Pipeline documentation, read as text only (D-103, D-104). Engineers and
 * above add and remove documents; anyone in the workspace can list them and
 * analysts and above can search. Nothing in a document is ever fetched,
 * rendered, or executed. */
@Controller('workspaces/:workspaceId/documents')
export class DocumentsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @RequireRole('viewer')
  @Get()
  async list(@CurrentWorkspace() { workspaceId }: WorkspaceAccess): Promise<DocumentSummary[]> {
    const rows = await this.prisma.document.findMany({
      where: { workspaceId, status: { not: 'archived' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: documentSelect,
    });
    return rows.map(toSummary);
  }

  /** Full-text search over the workspace's active documents (D-105). */
  @RequireRole('analyst')
  @Get('search')
  async search(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Query('q') q: unknown,
  ): Promise<DocumentHit[]> {
    if (typeof q !== 'string' || q.trim() === '' || q.length > DOCUMENT_LIMITS.queryMax) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        `Search for 1 to ${DOCUMENT_LIMITS.queryMax} characters.`,
      );
    }
    return searchDocumentChunks(this.prisma, workspaceId, q, {
      limit: DOCUMENT_LIMITS.searchResults,
      snippetChars: DOCUMENT_LIMITS.snippetChars,
    });
  }

  @RequireRole('engineer')
  @Post()
  async create(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Body() body: unknown,
  ): Promise<DocumentSummary> {
    const input = CreateDocumentRequest.safeParse(body);
    if (!input.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Check the document.',
        input.error.issues[0]?.message,
      );
    }
    const format = documentFormatFor(input.data.name);
    if (format === null) {
      throw new ProblemException(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'unsupported_format',
        'Only .txt and .md files are supported.',
        'PDF, Word, and HTML files are not read.',
      );
    }
    const extracted = extractDocumentText(input.data.content);
    if (!extracted.ok) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'unreadable_document', extracted.reason);
    }
    const chunked = chunkDocument(extracted.text, format);
    if (!chunked.ok) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'unreadable_document', chunked.reason);
    }
    if (input.data.sourceId !== undefined) {
      const source = await this.prisma.dataSource.findFirst({
        where: { id: input.data.sourceId, workspaceId },
        select: { id: true },
      });
      if (source === null) {
        throw new ProblemException(HttpStatus.NOT_FOUND, 'source_not_found', 'Source not found.');
      }
    }
    const contentHash = createHash('sha256').update(extracted.text).digest('hex');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.document.create({
          data: {
            workspaceId,
            sourceId: input.data.sourceId ?? null,
            name: input.data.name,
            format,
            sizeChars: extracted.text.length,
            chunkCount: chunked.chunks.length,
            contentHash,
          },
          select: documentSelect,
        });
        await tx.documentChunk.createMany({
          data: chunked.chunks.map((c) => ({
            workspaceId,
            documentId: created.id,
            ordinal: c.ordinal,
            sectionTitle: c.sectionTitle,
            sectionPath: c.sectionPath,
            startLine: c.startLine,
            endLine: c.endLine,
            text: c.text,
          })),
        });
        await recordAudit(tx, {
          action: 'document.uploaded',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId,
          target: { type: 'document', id: created.id },
          summary: {
            after: {
              name: input.data.name,
              format,
              sizeChars: extracted.text.length,
              chunks: chunked.chunks.length,
              contentHash: contentHash.slice(0, 16),
            },
          },
        });
        return created;
      });
      return toSummary(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'document_exists',
          'This document is already stored.',
          'Archive the existing copy first to add it again.',
        );
      }
      throw error;
    }
  }

  /** Archives the document and removes its chunks, so it can no longer be
   * found or cited; the record stays for the audit trail. */
  @RequireRole('engineer')
  @Delete(':documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('documentId') documentId: string,
  ): Promise<void> {
    if (!isUuid(documentId)) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      const archived = await tx.document.updateMany({
        where: { id: documentId, workspaceId, status: { not: 'archived' } },
        data: { status: 'archived', archivedAt: new Date() },
      });
      if (archived.count === 0) throw notFound();
      await tx.documentChunk.deleteMany({ where: { workspaceId, documentId } });
      await recordAudit(tx, {
        action: 'document.archived',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId,
        target: { type: 'document', id: documentId },
        summary: {},
      });
    });
  }
}
