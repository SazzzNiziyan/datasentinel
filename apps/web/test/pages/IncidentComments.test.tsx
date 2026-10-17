import type { IncidentCommentItem, IncidentDetail, Role } from '@datasentinel/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { IncidentDetailPage } from '../../src/incidents/IncidentDetailPage.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

const comment = (id: string, extra: Partial<IncidentCommentItem> = {}): IncidentCommentItem => ({
  id,
  authorMembershipId: 'm1',
  authorName: 'Ada',
  text: 'Hello',
  createdAt: '2026-10-17T10:00:00.000Z',
  ...extra,
});

const make = (comments: IncidentCommentItem[]): IncidentDetail => ({
  id: 'i1',
  title: 'Orders are stale',
  severity: 'critical',
  status: 'open',
  datasetId: 'd1',
  datasetName: 'Orders',
  ruleId: 'r1',
  ruleName: 'Orders keep arriving',
  ruleType: 'freshness',
  sourceId: 's1',
  assignedMembershipId: null,
  assigneeName: null,
  failureCount: 4,
  lastFailureAt: '2026-10-17T10:00:00.000Z',
  openedAt: '2026-10-17T09:00:00.000Z',
  resolvedAt: null,
  resolutionNote: null,
  latestCheck: null,
  relatedRuns: [],
  evidence: [],
  history: [],
  comments,
});

const GET = 'GET /workspaces/w1/incidents/i1';
const POST = 'POST /workspaces/w1/incidents/i1/comments';

function renderAs(role: Role) {
  render(
    <WithSession session={fakeSession(signedIn(role))}>
      <MemoryRouter initialEntries={['/incidents/i1']}>
        <Routes>
          <Route path="/incidents/:incidentId" element={<IncidentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

const posts = (calls: { key: string; body: unknown }[]) => calls.filter((c) => c.key === POST);

describe('Incident comments', () => {
  it('lists comments oldest first and shows the text literally', async () => {
    routeApi({
      [GET]: () =>
        make([
          comment('c1', { text: 'First one', authorName: 'Ada' }),
          comment('c2', { text: '<b>x</b>', authorName: 'Bo' }),
        ]),
    });
    renderAs('analyst');
    expect(await screen.findByRole('heading', { name: 'Comments' })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Ada');
    expect(items[0]).toHaveTextContent('First one');
    expect(items[1]).toHaveTextContent('Bo');
    expect(screen.getByText('<b>x</b>')).toBeInTheDocument();
    expect(items[1]?.querySelector('b')).toBeNull();
  });

  it('posts a trimmed comment, shows it, and clears the box', async () => {
    const calls = routeApi({
      [GET]: () => make([]),
      [POST]: () => comment('c9', { text: 'Looking at it', authorName: 'Me' }),
    });
    renderAs('analyst');
    expect(await screen.findByText('No comments yet.')).toBeInTheDocument();
    const box = screen.getByLabelText('Add a comment');
    await userEvent.type(box, '  Looking at it  ');
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(await screen.findByText('Looking at it')).toBeInTheDocument();
    expect(posts(calls)[0]?.body).toEqual({ text: 'Looking at it' });
    expect(box).toHaveValue('');
    expect(screen.queryByText('No comments yet.')).toBeNull();
  });

  it('refuses empty text without a request', async () => {
    const calls = routeApi({ [GET]: () => make([]) });
    renderAs('analyst');
    await userEvent.type(await screen.findByLabelText('Add a comment'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write a comment.');
    expect(posts(calls)).toHaveLength(0);
  });

  it('shows comments but no form to a viewer', async () => {
    routeApi({ [GET]: () => make([comment('c1', { text: 'Seen by all' })]) });
    renderAs('viewer');
    expect(await screen.findByText('Seen by all')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add a comment')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Post comment' })).toBeNull();
  });

  it('keeps the text and shows the error when posting fails', async () => {
    routeApi({
      [GET]: () => make([]),
      [POST]: () => reply(500, { code: 'boom', title: 'Failed', detail: 'Could not save it.' }),
    });
    renderAs('analyst');
    const box = await screen.findByLabelText('Add a comment');
    await userEvent.type(box, 'Keep me');
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save it.'));
    expect(box).toHaveValue('Keep me');
  });

  it('names a removed author "Former member"', async () => {
    routeApi({ [GET]: () => make([comment('c1', { authorName: null })]) });
    renderAs('viewer');
    expect(await screen.findByText(/Former member/)).toBeInTheDocument();
  });
});
