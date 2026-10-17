import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { InvitePage } from '../../src/pages/InvitePage.tsx';
import { SettingsPage } from '../../src/pages/SettingsPage.tsx';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

type Answer = { status?: number; body: unknown };

/** Answers API calls by path; the network is otherwise off. */
function stubApi(routes: Record<string, Answer | Answer[]>) {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const entry = routes[path];
    const answer = Array.isArray(entry) ? entry.shift() : entry;
    if (answer === undefined) return Promise.reject(new TypeError('offline'));
    return Promise.resolve(
      new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
      }),
    );
  });
  return calls;
}

function renderAt(path: string, page: ReactNode, session = fakeSession({ status: 'signed_out' })) {
  render(
    <WithSession session={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/invite" element={page} />
          <Route path="/settings" element={page} />
          <Route path="/" element={<p>Home</p>} />
          <Route path="/sign-in" element={<p>Sign-in page</p>} />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

const preview = (hasAccount: boolean) => ({
  body: { workspaceName: 'Northwind', email: 'new@team.example', role: 'analyst', hasAccount },
});

describe('InvitePage', () => {
  it('lets a new person create an account and join', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      '/invitations/preview': preview(false),
      '/invitations/accept': { body: { id: 'w1' } },
    });
    renderAt('/invite#token=tok-123', <InvitePage />);
    expect(await screen.findByRole('heading', { name: 'Join Northwind' })).toBeVisible();
    expect(screen.getByText(/invited as Analyst/)).toBeVisible();
    await user.type(screen.getByLabelText('Your name'), 'New Person');
    await user.type(screen.getByLabelText(/Choose a password/), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Create account and join' }));
    expect(await screen.findByText('Home')).toBeVisible();
    expect(calls.at(-1)).toEqual({
      path: '/invitations/accept',
      body: { token: 'tok-123', displayName: 'New Person', password: 'a long enough password' },
    });
  });

  it('asks someone with an account to sign in first', async () => {
    stubApi({ '/invitations/preview': preview(true) });
    renderAt('/invite#token=tok-123', <InvitePage />);
    expect(await screen.findByRole('link', { name: 'Sign in to accept' })).toBeVisible();
  });

  it('explains an invalid link', async () => {
    stubApi({
      '/invitations/preview': {
        status: 404,
        body: {
          title: 'This invitation link is not valid.',
          code: 'invitation_invalid',
          status: 404,
        },
      },
    });
    renderAt('/invite#token=old', <InvitePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This invitation link is not valid.',
    );
  });
});

describe('Workspace settings for an admin', () => {
  it('creates an invite link and shows it once', async () => {
    const user = userEvent.setup();
    stubApi({
      '/workspaces/w1/members': { body: [] },
      '/workspaces/w1/invitations': [
        { body: [] },
        {
          status: 201,
          body: {
            id: 'i1',
            email: 'new@team.example',
            role: 'viewer',
            expiresAt: '2026-10-24T00:00:00.000Z',
            acceptUrl: 'http://localhost:5173/invite#token=abc',
          },
        },
        { body: [] },
      ],
    });
    renderAt('/settings', <SettingsPage />, fakeSession(signedIn('admin')));
    await user.type(await screen.findByLabelText('Email'), 'new@team.example');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(await screen.findByLabelText('Invite link')).toHaveValue(
      'http://localhost:5173/invite#token=abc',
    );
    // An admin cannot invite owners.
    expect(screen.queryByRole('option', { name: 'Owner' })).toBeNull();
  });
});
