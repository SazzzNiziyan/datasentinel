import type {
  AiSettings,
  IncidentEvidenceItem,
  InvestigationReportItem,
  Role,
} from '@datasentinel/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { InvestigationPanel } from '../../src/incidents/InvestigationPanel.tsx';
import { reply, routeApi } from '../api.ts';

const SETTINGS = 'GET /workspaces/w1/ai-settings';
const LIST = 'GET /workspaces/w1/incidents/i1/investigations';
const CREATE = 'POST /workspaces/w1/incidents/i1/investigations';
const FEEDBACK = (id: string) => `POST /workspaces/w1/incidents/i1/investigations/${id}/feedback`;

const settings = (extra: Partial<AiSettings> = {}): AiSettings => ({
  available: true,
  enabled: true,
  provider: 'Acme AI',
  region: 'EU',
  retention: 'none',
  ...extra,
});

const evidence = (id: string): IncidentEvidenceItem => ({
  id,
  kind: 'check_run',
  referenceId: `ref-${id}`,
  observedAt: '2026-10-17T10:00:00.000Z',
  summary: {},
});
const EVIDENCE = [evidence('e1'), evidence('e2')];

const item = (
  version: number,
  extra: Partial<InvestigationReportItem> = {},
): InvestigationReportItem => ({
  id: `r${version}`,
  version,
  status: 'ready',
  failureCode: null,
  report: {
    schemaVersion: 1,
    summary: `Summary ${version}`,
    facts: [{ statement: 'Orders stopped', evidenceIds: ['e1', 'e2'] }],
    hypotheses: [{ statement: 'Feed is down', confidence: 'medium', evidenceIds: ['e2'] }],
    suggestedChecks: [{ description: 'Look at the feed log' }],
    limitations: ['Cannot see the upstream system'],
    confidence: 'low',
  },
  templateVersion: 1,
  schemaVersion: 1,
  providerName: 'Acme AI',
  model: 'm-1',
  excerptCount: 2,
  createdAt: '2026-10-17T10:00:00.000Z',
  completedAt: '2026-10-17T10:01:00.000Z',
  feedback: { mine: null, helpful: 0, notHelpful: 0 },
  ...extra,
});

function renderAs(role: Role, pollMs = 20) {
  render(
    <InvestigationPanel
      workspaceId="w1"
      incidentId="i1"
      role={role}
      evidence={EVIDENCE}
      pollMs={pollMs}
    />,
  );
}

describe('Investigation panel', () => {
  it('says AI is off and makes no investigations request', async () => {
    const calls = routeApi({ [SETTINGS]: () => settings({ enabled: false }) });
    renderAs('admin');
    expect(await screen.findByText('AI investigation is off for this workspace.')).toBeVisible();
    expect(screen.getByText('Turn it on in Settings.')).toBeVisible();
    expect(calls.some((c) => c.key.includes('investigations'))).toBe(false);
  });

  it('treats an unavailable deployment as off, without the settings hint for analysts', async () => {
    const calls = routeApi({ [SETTINGS]: () => settings({ available: false, enabled: false }) });
    renderAs('analyst');
    expect(await screen.findByText('AI investigation is off for this workspace.')).toBeVisible();
    expect(screen.queryByText('Turn it on in Settings.')).toBeNull();
    expect(calls.some((c) => c.key.includes('investigations'))).toBe(false);
  });

  it('generates a report, polls while pending, and stops once ready', async () => {
    const pending = item(1, { status: 'pending', report: null, completedAt: null });
    let lists = 0;
    const calls = routeApi({
      [SETTINGS]: () => settings(),
      [LIST]: () => {
        lists += 1;
        if (lists === 1) return [];
        return lists < 4 ? [pending] : [item(1)];
      },
      [CREATE]: () => reply(202, pending),
    });
    renderAs('analyst');
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
    expect(await screen.findByText(/Writing the report/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Regenerate report' })).toBeDisabled();
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeVisible();
    expect(calls.filter((c) => c.key === CREATE)[0]?.body).toBeUndefined();
    // One poll may already be in flight when the report turns ready; after
    // that the count must hold still.
    await new Promise((r) => setTimeout(r, 120));
    const total = calls.filter((c) => c.key === LIST).length;
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.filter((c) => c.key === LIST).length).toBe(total);
  });

  it('shows the plain reason for a failed report and retries', async () => {
    const calls = routeApi({
      [SETTINGS]: () => settings(),
      [LIST]: () => [item(1, { status: 'failed', failureCode: 'timeout', report: null })],
      [CREATE]: () => item(2, { status: 'pending', report: null }),
    });
    renderAs('analyst');
    expect(await screen.findByText('The AI provider took too long to answer')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.some((c) => c.key === CREATE)).toBe(true));
  });

  it('shows distinct sections, references, confidence, and the footer for a ready report', async () => {
    routeApi({ [SETTINGS]: () => settings(), [LIST]: () => [item(1)] });
    renderAs('viewer');
    expect(
      await screen.findByText('AI-generated advice. Check it against the evidence.'),
    ).toBeVisible();
    for (const name of [
      'Summary',
      'Facts (from the evidence)',
      'Possible explanations (not facts)',
      'Suggested checks (read-only)',
      'What this report cannot know',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeVisible();
    }
    expect(screen.getByText(/Evidence 1, 2/)).toBeVisible();
    expect(screen.getByText('(Evidence 2)')).toBeVisible();
    expect(screen.getByText('Medium confidence')).toBeVisible();
    expect(screen.getByText('Overall confidence: Low')).toBeVisible();
    expect(
      screen.getByText(/Version 1 · Acme AI m-1 · prompt v1 · 2 document excerpts used · /),
    ).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders hostile report text literally', async () => {
    const hostile = '<b>x</b> https://evil.example';
    const base = item(1);
    routeApi({
      [SETTINGS]: () => settings(),
      [LIST]: () => [item(1, { report: { ...base.report!, summary: hostile } })],
    });
    renderAs('viewer');
    const text = await screen.findByText(hostile);
    expect(text.querySelector('b')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('switches between report versions', async () => {
    routeApi({ [SETTINGS]: () => settings(), [LIST]: () => [item(2), item(1)] });
    renderAs('viewer');
    expect(await screen.findByText('Summary 2')).toBeVisible();
    const select = screen.getByLabelText('Report version');
    expect(within(select).getAllByRole('option')[1]).toHaveTextContent(/^Version 1, .*, Ready$/);
    await userEvent.selectOptions(select, 'r1');
    expect(screen.getByText('Summary 1')).toBeVisible();
    expect(screen.queryByText('Summary 2')).toBeNull();
  });

  it('posts feedback and reflects the pressed state', async () => {
    const calls = routeApi({
      [SETTINGS]: () => settings(),
      [LIST]: () => [item(1)],
      [FEEDBACK('r1')]: () => item(1, { feedback: { mine: 'helpful', helpful: 1, notHelpful: 0 } }),
    });
    renderAs('analyst');
    const helpful = await screen.findByRole('button', { name: 'Helpful' });
    expect(helpful).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(helpful);
    expect(await screen.findByText('Thanks for the feedback.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Not helpful' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(/1 found this helpful/)).toBeVisible();
    expect(calls.find((c) => c.key === FEEDBACK('r1'))?.body).toEqual({ rating: 'helpful' });
  });

  it('shows server errors for generating', async () => {
    routeApi({
      [SETTINGS]: () => settings(),
      [LIST]: () => [],
      [CREATE]: () =>
        reply(429, {
          code: 'investigation_limit',
          title: 'Limit',
          detail: 'Too many reports today.',
        }),
    });
    renderAs('analyst');
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many reports today.');
  });

  it('shows the conflict error when a report is already running', async () => {
    routeApi({
      [SETTINGS]: () => settings(),
      [LIST]: () => [],
      [CREATE]: () =>
        reply(409, { code: 'investigation_running', title: 'Busy', detail: 'One is running.' }),
    });
    renderAs('analyst');
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('One is running.');
  });
});
