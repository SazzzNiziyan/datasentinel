// Development check: adds one ping job and waits for the worker's answer.
// Run with the worker started: pnpm --filter @datasentinel/worker sample-job
import {
  PING_JOB,
  SYSTEM_QUEUE,
  type PingJobData,
  type PingJobResult,
} from '@datasentinel/contracts';
import { Queue, QueueEvents } from 'bullmq';

const connection = { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' };
const queue = new Queue<PingJobData>(SYSTEM_QUEUE, { connection });
const events = new QueueEvents(SYSTEM_QUEUE, { connection });

try {
  await events.waitUntilReady();
  const job = await queue.add(PING_JOB, { sentAt: new Date().toISOString() });
  const result = (await job.waitUntilFinished(events, 10_000)) as PingJobResult;
  console.log(`job ${job.id} answered`, result);
} finally {
  await events.close();
  await queue.close();
}
