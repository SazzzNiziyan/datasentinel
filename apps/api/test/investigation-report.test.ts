import {
  checkInvestigationReport,
  InvestigationReport,
  REPORT_LIMITS,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const e1 = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60';
const e2 = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61';
const known = new Set([e1, e2]);

const good = () => ({
  schemaVersion: 1,
  summary: 'Orders stopped updating after the 02:00 load.',
  facts: [{ statement: 'The freshness check failed three times.', evidenceIds: [e1] }],
  hypotheses: [
    { statement: 'The nightly export did not run.', confidence: 'medium', evidenceIds: [e1, e2] },
  ],
  suggestedChecks: [{ description: 'Look at the export job history for last night.' }],
  limitations: ['The report cannot see the export job itself.'],
  confidence: 'medium',
});

describe('investigation report schema', () => {
  it('accepts a complete, evidence-linked report', () => {
    const check = checkInvestigationReport(good(), known);
    assert.equal(check.ok, true);
  });

  it('rejects unknown fields anywhere, so nothing extra can ride along', () => {
    const extras: Record<string, unknown>[] = [
      { ...good(), command: 'rm -rf /' },
      { ...good(), facts: [{ statement: 's', evidenceIds: [e1], extra: 1 }] },
      { ...good(), suggestedChecks: [{ description: 'd', run: 'sql' }] },
    ];
    for (const bad of extras) {
      assert.equal(InvestigationReport.safeParse(bad).success, false);
    }
  });

  it('requires a limitation, a known version, and evidence for every claim', () => {
    assert.equal(InvestigationReport.safeParse({ ...good(), limitations: [] }).success, false);
    assert.equal(InvestigationReport.safeParse({ ...good(), schemaVersion: 2 }).success, false);
    assert.equal(
      InvestigationReport.safeParse({ ...good(), facts: [{ statement: 's', evidenceIds: [] }] })
        .success,
      false,
    );
    assert.equal(
      InvestigationReport.safeParse({
        ...good(),
        hypotheses: [{ statement: 's', confidence: 'low', evidenceIds: ['not-a-uuid'] }],
      }).success,
      false,
    );
    assert.equal(
      InvestigationReport.safeParse({ ...good(), confidence: 'certain' }).success,
      false,
    );
  });

  it('keeps confidence honest', () => {
    const highOnOne = {
      ...good(),
      hypotheses: [{ statement: 's', confidence: 'high', evidenceIds: [e1, e1] }],
    };
    assert.equal(InvestigationReport.safeParse(highOnOne).success, false);
    const highOnTwo = {
      ...good(),
      hypotheses: [{ statement: 's', confidence: 'high', evidenceIds: [e1, e2] }],
    };
    assert.equal(InvestigationReport.safeParse(highOnTwo).success, true);
    const noFacts = { ...good(), facts: [], confidence: 'high' };
    assert.equal(InvestigationReport.safeParse(noFacts).success, false);
    assert.equal(InvestigationReport.safeParse({ ...noFacts, confidence: 'low' }).success, true);
  });

  it('allows plain text only: no links, markup, or control characters', () => {
    const withText = (summary: string) => ({ ...good(), summary });
    for (const bad of [
      'See https://evil.example/now',
      'Visit www.evil.example',
      'Load //evil.example/x',
      'Click <a href="x">here</a>',
      '<script>alert(1)</script>',
      'bell\u0007char',
      'tab\there',
      '',
      '   ',
    ]) {
      assert.equal(
        InvestigationReport.safeParse(withText(bad)).success,
        false,
        JSON.stringify(bad),
      );
    }
    assert.equal(
      InvestigationReport.safeParse(withText('Line one\nline two, 3 < 5 and 7 > 2')).success,
      true,
    );
  });

  it('enforces the size limits', () => {
    assert.equal(
      InvestigationReport.safeParse({ ...good(), summary: 'x'.repeat(REPORT_LIMITS.summary + 1) })
        .success,
      false,
    );
    const many = (n: number, make: (i: number) => unknown) =>
      Array.from({ length: n }, (_, i) => make(i));
    assert.equal(
      InvestigationReport.safeParse({
        ...good(),
        facts: many(REPORT_LIMITS.facts + 1, () => ({ statement: 's', evidenceIds: [e1] })),
      }).success,
      false,
    );
    assert.equal(
      InvestigationReport.safeParse({
        ...good(),
        limitations: many(REPORT_LIMITS.limitations + 1, () => 'l'),
      }).success,
      false,
    );
  });

  it('rejects evidence that is not this incident’s, without echoing model text', () => {
    const foreign = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5fff';
    const bad = { ...good(), facts: [{ statement: 'SECRET-MODEL-TEXT', evidenceIds: [foreign] }] };
    const check = checkInvestigationReport(bad, known);
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.equal(check.problems.length, 1);
      assert.match(check.problems[0] ?? '', /do not belong to this incident/);
      assert.equal(JSON.stringify(check.problems).includes('SECRET-MODEL-TEXT'), false);
      assert.equal(JSON.stringify(check.problems).includes(foreign), false);
    }
  });

  it('turns any malformed output into a few short problems, never a throw', () => {
    for (const junk of [null, undefined, 'text', 5, [], {}, { schemaVersion: 1 }]) {
      const check = checkInvestigationReport(junk, known);
      assert.equal(check.ok, false);
      if (!check.ok) assert.ok(check.problems.length >= 1 && check.problems.length <= 10);
    }
  });
});
