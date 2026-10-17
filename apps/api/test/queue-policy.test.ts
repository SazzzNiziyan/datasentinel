import {
  DISCOVER_TABLES_JOB,
  FAILED_JOB_RETENTION,
  jobOptions,
  JOB_POLICIES,
  PARSE_UPLOAD_JOB,
  PROFILE_DATASET_JOB,
  RETRY_BASE_DELAY_MS,
  RUN_CHECK_JOB,
  TEST_CONNECTION_JOB,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('queue retry policy', () => {
  it('covers every job a producer adds, with sane attempts', () => {
    assert.deepEqual(
      Object.keys(JOB_POLICIES).sort(),
      [
        DISCOVER_TABLES_JOB,
        PARSE_UPLOAD_JOB,
        PROFILE_DATASET_JOB,
        RUN_CHECK_JOB,
        TEST_CONNECTION_JOB,
      ].sort(),
    );
    for (const policy of Object.values(JOB_POLICIES)) {
      assert.ok(Number.isInteger(policy.attempts) && policy.attempts >= 1 && policy.attempts <= 5);
    }
  });

  it('retries with doubling backoff only when there is more than one attempt', () => {
    const check = jobOptions(RUN_CHECK_JOB, 'check-1');
    assert.equal(check.attempts, 3);
    assert.deepEqual(check.backoff, { type: 'exponential', delay: RETRY_BASE_DELAY_MS });
    assert.equal(check.jobId, 'check-1');
    const test = jobOptions(TEST_CONNECTION_JOB, 't1');
    assert.equal(test.attempts, 1);
    assert.equal('backoff' in test, false);
    assert.equal(jobOptions(DISCOVER_TABLES_JOB, 'x').attempts, 1);
  });

  it('keeps terminally failed jobs for seven days, except where the job ID repeats', () => {
    assert.deepEqual(FAILED_JOB_RETENTION, { age: 604_800, count: 1000 });
    for (const name of [RUN_CHECK_JOB, TEST_CONNECTION_JOB, PARSE_UPLOAD_JOB]) {
      assert.deepEqual(jobOptions(name, 'id').removeOnFail, FAILED_JOB_RETENTION, name);
    }
    // A kept job would make the queue ignore the next job with the same ID.
    assert.equal(jobOptions(PROFILE_DATASET_JOB, 'profile-d').removeOnFail, true);
    assert.deepEqual(jobOptions(DISCOVER_TABLES_JOB, 'x').removeOnFail, { age: 60 });
  });

  it('refuses a job without a deliberate policy', () => {
    assert.throws(() => jobOptions('surprise', 'id'), /No retry policy/);
  });
});
