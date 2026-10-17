import {
  CreateUploadRequest,
  type UploadCreated,
  type UploadDetail,
  type UploadFailure,
} from '@datasentinel/contracts';
import { Prisma, type PrismaClient } from '@datasentinel/db';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentRequest, recordAudit, type RequestMeta } from '../audit/audit.js';
import { CurrentPrincipal, type Principal } from '../auth/session.guard.js';
import { PRISMA } from '../db.js';
import { ProblemException } from '../problem.js';
import {
  UPLOAD_STORAGE,
  UPLOAD_URL_SECONDS,
  uploadObjectKey,
  type UploadStorage,
} from '../storage/storage.js';
import {
  CurrentWorkspace,
  isUuid,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';
import { UPLOAD_QUEUE, type UploadQueue } from './upload-queue.js';

/** Raw files are kept 30 days (D-08). */
const RETAIN_DAYS = 30;

const problem = (status: HttpStatus, code: string, title: string, detail?: string) =>
  new ProblemException(status, code, title, detail);

const uploadNotFound = () => problem(HttpStatus.NOT_FOUND, 'upload_not_found', 'Upload not found.');
const datasetExists = () =>
  problem(
    HttpStatus.CONFLICT,
    'dataset_exists',
    'A dataset with this name already exists in the source.',
    'Pick the existing dataset, or choose another name.',
  );

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** Keeps the last path part and drops control and direction-changing
 * characters. The result is for display only. */
export function cleanFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const clean = base
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 255);
  return clean === '' ? 'upload.csv' : clean;
}

/** A dataset's stable key from its name: "Daily Sales" → "daily-sales". */
export function datasetKey(name: string): string {
  const key = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return key === '' ? 'dataset' : key;
}

const failure = (code: string, message: string, hint: string): UploadFailure => ({
  code,
  message,
  hint,
  retryable: false,
});

const uploadSelect = {
  id: true,
  sourceId: true,
  datasetId: true,
  newDatasetName: true,
  filename: true,
  sizeBytes: true,
  status: true,
  error: true,
  rowCount: true,
  columnCount: true,
  createdAt: true,
  completedAt: true,
} as const;

type UploadRow = Prisma.UploadGetPayload<{ select: typeof uploadSelect }>;

const toDetail = (u: UploadRow): UploadDetail => ({
  id: u.id,
  sourceId: u.sourceId,
  datasetId: u.datasetId,
  newDatasetName: u.newDatasetName,
  filename: u.filename,
  sizeBytes: u.sizeBytes,
  status: u.status,
  error: (u.error as UploadFailure | null) ?? null,
  rowCount: u.rowCount,
  columnCount: u.columnCount,
  createdAt: u.createdAt.toISOString(),
  completedAt: u.completedAt?.toISOString() ?? null,
});

/** CSV upload lifecycle (docs/04 §3, D-41): start, send the file straight to
 * storage, complete, then read the parse status. */
@Controller('workspaces/:workspaceId')
export class UploadsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(UPLOAD_STORAGE) private readonly storage: UploadStorage,
    @Inject(UPLOAD_QUEUE) private readonly queue: UploadQueue,
  ) {}

  @RequireRole('engineer')
  @Post('sources/:sourceId/uploads')
  async start(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ): Promise<UploadCreated> {
    if (!isUuid(sourceId)) {
      throw problem(HttpStatus.NOT_FOUND, 'source_not_found', 'Data source not found.');
    }
    const source = await this.prisma.dataSource.findFirst({
      where: { id: sourceId, workspaceId: access.workspaceId },
      select: { id: true, type: true, status: true },
    });
    if (source === null) {
      throw problem(HttpStatus.NOT_FOUND, 'source_not_found', 'Data source not found.');
    }
    const input = CreateUploadRequest.safeParse(body);
    if (!input.success) {
      throw problem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'Send the file name, its size (at most 50 MB), its SHA-256, and one dataset choice.',
      );
    }
    if (source.type !== 'csv') {
      throw problem(HttpStatus.CONFLICT, 'source_not_csv', 'Only CSV sources accept uploads.');
    }
    if (source.status !== 'active') {
      throw problem(
        HttpStatus.CONFLICT,
        'source_not_active',
        'This source is paused or archived.',
        'Resume the source before uploading.',
      );
    }
    const { datasetId, newDatasetName, sizeBytes, checksumSha256 } = input.data;
    if (datasetId !== undefined) {
      const dataset = await this.prisma.dataset.findFirst({
        where: {
          id: datasetId,
          sourceId,
          workspaceId: access.workspaceId,
          status: { not: 'archived' },
        },
        select: { id: true },
      });
      if (dataset === null) {
        throw problem(HttpStatus.NOT_FOUND, 'dataset_not_found', 'Dataset not found.');
      }
    } else if (newDatasetName !== undefined) {
      const clash = await this.prisma.dataset.findFirst({
        where: { workspaceId: access.workspaceId, sourceId, stableKey: datasetKey(newDatasetName) },
        select: { id: true },
      });
      if (clash !== null) throw datasetExists();
    }

    const objectKey = uploadObjectKey(access.workspaceId);
    const now = Date.now();
    const upload = await this.prisma.$transaction(async (tx) => {
      const created = await tx.upload.create({
        data: {
          workspaceId: access.workspaceId,
          sourceId,
          datasetId: datasetId ?? null,
          newDatasetName: newDatasetName ?? null,
          objectKey,
          filename: cleanFilename(input.data.filename),
          sizeBytes,
          checksumSha256,
          createdByMembershipId: access.membershipId,
          uploadUrlExpiresAt: new Date(now + UPLOAD_URL_SECONDS * 1000),
          retainUntil: new Date(now + RETAIN_DAYS * 24 * 60 * 60 * 1000),
        },
        select: uploadSelect,
      });
      await recordAudit(tx, {
        action: 'upload.started',
        actor: { type: 'user', id: principal.userId },
        request,
        workspaceId: access.workspaceId,
        target: { type: 'upload', id: created.id },
        summary: { after: { sourceId, filename: created.filename, sizeBytes } },
      });
      return created;
    });
    const instructions = await this.storage.signUpload(objectKey, sizeBytes, checksumSha256);
    return { upload: toDetail(upload), instructions };
  }

  /** Safe to repeat: a queued upload is queued again (the job ID stops a
   * duplicate), and a finished one is returned unchanged. */
  @RequireRole('engineer')
  @Post('uploads/:uploadId/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  async complete(
    @CurrentWorkspace() access: WorkspaceAccess,
    @CurrentPrincipal() principal: Principal,
    @CurrentRequest() request: RequestMeta,
    @Param('uploadId') uploadId: string,
  ): Promise<UploadDetail> {
    const upload = await this.find(access.workspaceId, uploadId);
    const job = { workspaceId: access.workspaceId, uploadId: upload.id };
    if (upload.status === 'queued') {
      await this.queue.enqueueParse(job);
      return toDetail(upload);
    }
    if (upload.status !== 'awaiting_upload') return toDetail(upload);

    const stored = await this.storage.stat(upload.objectKey);
    if (stored === null) {
      if (upload.uploadUrlExpiresAt.getTime() > Date.now()) {
        throw problem(
          HttpStatus.CONFLICT,
          'upload_missing',
          'The file has not arrived in storage yet.',
          'Finish sending the file, then complete the upload.',
        );
      }
      return this.fail(
        upload.id,
        failure(
          'not_found',
          'The file never arrived before the upload link expired.',
          'Start a new upload.',
        ),
      );
    }
    if (
      stored.sizeBytes !== upload.sizeBytes ||
      (stored.sha256 !== null && stored.sha256 !== upload.checksumSha256)
    ) {
      return this.fail(
        upload.id,
        failure(
          'malformed',
          'The stored file does not match the declared size or checksum.',
          'Start a new upload with the same file.',
        ),
      );
    }

    const done = await this.prisma
      .$transaction(async (tx) => {
        // Only one completion can move it out of awaiting_upload.
        const moved = await tx.upload.updateMany({
          where: { id: upload.id, status: 'awaiting_upload' },
          data: { status: 'queued', completedAt: new Date() },
        });
        if (moved.count === 0) return null;
        if (upload.newDatasetName !== null) {
          const dataset = await tx.dataset.create({
            data: {
              workspaceId: access.workspaceId,
              sourceId: upload.sourceId,
              stableKey: datasetKey(upload.newDatasetName),
              name: upload.newDatasetName,
              ownerMembershipId: access.membershipId,
              locator: { format: 'csv' },
            },
            select: { id: true },
          });
          await tx.upload.update({
            where: { id: upload.id },
            data: { datasetId: dataset.id, newDatasetName: null },
          });
        }
        await recordAudit(tx, {
          action: 'upload.completed',
          actor: { type: 'user', id: principal.userId },
          request,
          workspaceId: access.workspaceId,
          target: { type: 'upload', id: upload.id },
          summary: { after: { status: 'queued' } },
        });
        return tx.upload.findUniqueOrThrow({ where: { id: upload.id }, select: uploadSelect });
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw datasetExists();
        throw error;
      });
    if (done === null) return this.detail(access, uploadId);
    await this.queue.enqueueParse(job);
    return toDetail(done);
  }

  /** The 20 newest uploads, for a dataset or a source (any member). An ID
   * that is malformed or from another workspace matches nothing. */
  @Get('uploads')
  async list(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Query('datasetId') datasetId?: string,
    @Query('sourceId') sourceId?: string,
  ): Promise<UploadDetail[]> {
    const only = (id: string | undefined) =>
      id === undefined ? undefined : { in: isUuid(id) ? [id] : [] };
    const rows = await this.prisma.upload.findMany({
      where: {
        workspaceId: access.workspaceId,
        datasetId: only(datasetId),
        sourceId: only(sourceId),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: uploadSelect,
    });
    return rows.map(toDetail);
  }

  @Get('uploads/:uploadId')
  async detail(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('uploadId') uploadId: string,
  ): Promise<UploadDetail> {
    return toDetail(await this.find(access.workspaceId, uploadId));
  }

  private async find(workspaceId: string, uploadId: string) {
    if (!isUuid(uploadId)) throw uploadNotFound();
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, workspaceId },
      select: { ...uploadSelect, objectKey: true, checksumSha256: true, uploadUrlExpiresAt: true },
    });
    if (upload === null) throw uploadNotFound();
    return upload;
  }

  private async fail(uploadId: string, error: UploadFailure): Promise<UploadDetail> {
    await this.prisma.upload.updateMany({
      where: { id: uploadId, status: 'awaiting_upload' },
      data: { status: 'failed', error: { ...error } },
    });
    return toDetail(
      await this.prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, select: uploadSelect }),
    );
  }
}
