import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildProviderInput, type IncidentFacts } from '../src/ai/facts.js';
import { assertRedacted, RedactionError, redactText } from '../src/ai/redact.js';

const e1 = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60';
const e2 = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61';

describe('text redaction', () => {
  it('replaces each kind of identifier and secret, and counts them', () => {
    const samples: [string, string, string][] = [
      ['email', 'Contact jane.doe+x@example.co.uk now', '[email]'],
      ['url', 'see postgres://reader:hunter2@db.internal:5432/prod?sslmode=x', '[url]'],
      ['url', 'at https://example.com/a?token=abc', '[url]'],
      ['secret', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk', '[secret]'],
      ['secret', 'key sk-abcdefghijklmnopqrstuv', '[secret]'],
      ['secret', 'key AKIAABCDEFGHIJKLMNOP', '[secret]'],
      ['secret', 'github_pat_' + 'A'.repeat(30), '[secret]'],
      ['secret', 'whsec_abcdefghij12345', '[secret]'],
      ['secret', 'dsp_' + 'a'.repeat(32) + '_' + 'B'.repeat(43), '[secret]'],
      ['secret', 'Authorization: Bearer abcdef123456789', 'Bearer [secret]'],
      ['secret', 'password = hunter2', 'password = [secret]'],
      ['secret', 'api_key: abc123xyz', 'api_key: [secret]'],
      ['secret', 'hash ' + 'a1'.repeat(20), '[secret]'],
      ['ip', 'from 192.168.10.42 today', '[ip]'],
      ['ip', 'from 2001:db8:85a3:0:0:8a2e:370:7334 today', '[ip]'],
      ['number', 'call +1 (555) 123-4567', '[number]'],
      ['number', 'card 4111 1111 1111 1111', '[number]'],
    ];
    for (const [kind, input, expected] of samples) {
      const { text, counts } = redactText(input);
      assert.ok(text.includes(expected), `${kind}: ${text}`);
      assert.ok((counts[kind as keyof typeof counts] ?? 0) >= 1, `${kind} counted: ${input}`);
    }
  });

  it('leaves ordinary words, short numbers, and placeholders alone', () => {
    for (const fine of [
      'Orders are stale after the 02:00 load',
      'null rate 25 percent over 3 runs',
      'column city, 4 rows',
      '[email] [secret] [url] [ip] [number]',
    ]) {
      assert.equal(redactText(fine).text, fine);
      assert.doesNotThrow(() => assertRedacted(fine));
    }
  });

  it('is repeatable, and the final check refuses what a rule would still match', () => {
    const once = redactText('mail a@b.co from 10.0.0.1 password=x1').text;
    assert.equal(redactText(once).text, once);
    assert.doesNotThrow(() => assertRedacted(once));
    for (const raw of ['a@b.co', '10.0.0.1', 'https://x.example/y', 'password=hunter2']) {
      assert.throws(() => assertRedacted(raw), RedactionError);
    }
  });
});

const facts = (): IncidentFacts => ({
  incident: {
    id: e1,
    title: 'Orders are fresh failed on orders',
    severity: 'critical',
    status: 'open',
    failureCount: 3,
    openedAt: '2026-10-17T10:00:00.000Z',
    datasetName: 'orders',
    sourceName: 'warehouse',
    sourceType: 'postgres',
  },
  rule: {
    name: 'Orders have a city',
    type: 'not_null',
    parameters: { column: 'city', maxNullPercent: 20 },
  },
  checks: [
    {
      id: e2,
      status: 'failed',
      finishedAt: '2026-10-17T10:05:00.000Z',
      expected: { maxNullPercent: 20 },
      actual: { rowCount: 12_345_678, nullPercent: 25 },
    },
  ],
  schemaChanges: [{ kind: 'removed', column: 'region' }],
  pipelineRuns: [{ name: 'orders_daily', status: 'failed', at: '2026-10-17T09:00:00.000Z' }],
  evidence: [
    { id: e1, kind: 'check_run' },
    { id: e2, kind: 'profile_snapshot' },
  ],
});

describe('provider input', () => {
  it('keeps typed facts, numbers, ids, and times exactly, and lists what can be cited', () => {
    const input = buildProviderInput(facts());
    const doc = JSON.parse(input.text) as {
      incident: { openedAt: string };
      checks: { actual: { rowCount: number }; evidenceId: string }[];
      rule: { parameters: { column: string } };
    };
    assert.equal(doc.incident.openedAt, '2026-10-17T10:00:00.000Z');
    assert.equal(doc.checks[0]?.actual.rowCount, 12_345_678);
    assert.equal(doc.checks[0]?.evidenceId, e2);
    assert.equal(doc.rule.parameters.column, 'city');
    assert.deepEqual(input.evidenceIds, [e1, e2]);
    assert.deepEqual(input.redactions, {});
  });

  it('scrubs hostile text in every free-text place and reports only counts', () => {
    const f = facts();
    const hostile =
      'x jane@example.com 10.1.2.3 postgres://u:hunter2@h/db password=hunter2 +1 555 123 4567';
    f.incident.title = hostile;
    f.incident.datasetName = hostile;
    f.incident.sourceName = hostile;
    f.rule.name = hostile;
    f.rule.parameters = { column: hostile, list: [hostile, 'ok'] };
    f.checks[0]!.actual = { note: hostile };
    f.schemaChanges = [{ kind: 'added', column: hostile }];
    f.pipelineRuns = [{ name: hostile, status: 'failed', at: '2026-10-17T09:00:00.000Z' }];
    f.evidence = [{ id: e1, kind: hostile }];
    const input = buildProviderInput(f);
    for (const leak of ['jane@example.com', '10.1.2.3', 'hunter2', 'postgres://', '555 123']) {
      assert.equal(input.text.includes(leak), false, leak);
    }
    assert.ok((input.redactions.email ?? 0) >= 9);
    assert.equal(JSON.stringify(input.redactions).includes('jane'), false);
  });

  it('cannot carry rows or unknown fields, and drops odd keys', () => {
    const f = {
      ...facts(),
      rows: [{ email: 'alice@example.com', ssn: '123-45-6789' }],
      sample: 'SECRET-ROW-VALUE',
    } as IncidentFacts;
    f.rule.parameters = { 'alice@example.com': 'x', 'bad key': 'y', ok_key: 'z' };
    const text = buildProviderInput(f).text;
    for (const leak of ['alice@example.com', '123-45-6789', 'SECRET-ROW-VALUE', 'bad key']) {
      assert.equal(text.includes(leak), false, leak);
    }
    assert.equal(text.includes('ok_key'), true);
  });

  it('refuses malformed ids and times instead of passing them on', () => {
    const f = facts();
    f.incident.id = 'jane@example.com';
    f.checks[0]!.id = 'not-a-uuid';
    f.checks[0]!.finishedAt = 'yesterday-ish';
    f.evidence = [
      { id: 'bad', kind: 'check_run' },
      { id: e2, kind: 'check_run' },
    ];
    const input = buildProviderInput(f);
    assert.equal(input.text.includes('jane@example.com'), false);
    assert.equal(input.text.includes('yesterday-ish'), false);
    assert.deepEqual(input.evidenceIds, [e2]);
  });

  it('caps long text and long lists', () => {
    const f = facts();
    f.incident.title = 'word '.repeat(200);
    f.checks = Array.from({ length: 30 }, () => ({ ...facts().checks[0]! }));
    f.evidence = Array.from({ length: 80 }, (_, i) => ({
      id: `0192f3a4-b5c6-7d8e-9f0a-${String(i).padStart(12, '0')}`,
      kind: 'check_run',
    }));
    const input = buildProviderInput(f);
    const doc = JSON.parse(input.text) as { incident: { title: string }; checks: unknown[] };
    assert.ok(doc.incident.title.length <= 200);
    assert.equal(doc.checks.length, 10);
    assert.equal(input.evidenceIds.length, 30);
  });
});
