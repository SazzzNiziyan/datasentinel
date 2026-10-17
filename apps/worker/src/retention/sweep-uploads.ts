import type { PrismaClient } from '@datasentinel/db';

/** Removes one stored object; a missing key is not an error. */
export type RemoveObject = (key: string) => Promise<void>;

export interface SweepResult {
  removed: number;
  failed: number;
}

/** Raw upload retention (D-08): files whose retainUntil has passed are
 * removed from storage and marked, so each is handled once. Parsed results
 * (profiles, snapshots) stay; only the raw file goes. A failed removal is
 * counted, left unmarked, and retried on the next pass. */
export async function sweepExpiredUploads(
  prisma: PrismaClient,
  remove: RemoveObject,
  now: Date,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<SweepResult> {
  const due = await prisma.upload.findMany({
    where: {
      retainUntil: { lt: now },
      rawDeletedAt: null,
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    },
    select: { id: true, objectKey: true },
    orderBy: { retainUntil: 'asc' },
    take: options.limit ?? 100,
  });
  const result: SweepResult = { removed: 0, failed: 0 };
  for (const upload of due) {
    try {
      await remove(upload.objectKey);
      await prisma.upload.updateMany({
        where: { id: upload.id, rawDeletedAt: null },
        data: { rawDeletedAt: now },
      });
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
