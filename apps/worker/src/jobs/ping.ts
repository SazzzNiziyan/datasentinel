import type { PingJobData, PingJobResult } from '@datasentinel/contracts';

/** The sample job: answers so a round trip through Redis can be checked. */
export function handlePing(data: PingJobData): PingJobResult {
  return { pong: true, sentAt: data.sentAt };
}
