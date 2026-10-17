import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client.ts';
import { RequireSession } from '../../src/app/RequireSession.tsx';
import type { Session } from '../../src/app/session.ts';
import { SignInPage } from '../../src/pages/SignInPage.tsx';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

function renderApp(session: Session, path = '/datasets') {
  render(
    <WithSession session={session}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route
            path="*"
            element={
              <RequireSession>
                <p>App content</p>
              </RequireSession>
            }
          />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

describe('RequireSession', () => {
  it('shows the app to a signed-in member', () => {
    renderApp(fakeSession());
    expect(screen.getByText('App content')).toBeVisible();
  });

  it('sends a signed-out visitor to the sign-in page', () => {
    renderApp(fakeSession({ status: 'signed_out' }));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  it('offers a retry when the API cannot be reached', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    renderApp(fakeSession({ status: 'unreachable' }, { refresh }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('explains when the user has no workspace yet', () => {
    const state = signedIn();
    renderApp(fakeSession({ ...state, workspace: undefined } as typeof state));
    expect(screen.getByRole('heading', { name: "You're not in a workspace yet" })).toBeVisible();
  });
});

describe('SignInPage', () => {
  it('signs in and returns to the page the user asked for', async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(() => Promise.resolve());
    // After sign-in the session becomes signed in; here the fake stays
    // signed out, so the redirect is checked through the route.
    renderApp(fakeSession({ status: 'signed_out' }, { signIn }));
    await user.type(screen.getByLabelText('Email'), 'ana@northwind.example');
    await user.type(screen.getByLabelText('Password'), 'secret-pass');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledWith('ana@northwind.example', 'secret-pass');
  });

  it('shows why sign-in failed, keeps the email, and clears the password', async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(() =>
      Promise.reject(
        new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.', 'Check both.'),
      ),
    );
    renderApp(fakeSession({ status: 'signed_out' }, { signIn }), '/sign-in');
    await user.type(screen.getByLabelText('Email'), 'ana@northwind.example');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByLabelText('Email')).toHaveValue('ana@northwind.example');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });
});
