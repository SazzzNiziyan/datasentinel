import type { InvitationPreview } from '@datasentinel/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, apiFetch } from '../api/client.ts';
import { BrandMark } from '../app/BrandMark.tsx';
import { roleLabel, useSession } from '../app/session.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingState } from '../components/LoadingState.tsx';
import './SignInPage.css';

type Preview =
  | { status: 'loading' }
  | { status: 'invalid'; message: string; detail?: string }
  | { status: 'ready'; invitation: InvitationPreview };

/** Opens an invite link (D-40). The token is after "#", so it never
 * reaches a server log; it is sent to the API only in request bodies. */
export function InvitePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { state, refresh } = useSession();
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    apiFetch<InvitationPreview>('/invitations/preview', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }).then(
      (invitation) => current && setPreview({ status: 'ready', invitation }),
      (caught: unknown) =>
        current &&
        setPreview({
          status: 'invalid',
          message:
            caught instanceof ApiError ? caught.message : 'This invitation link is not valid.',
          detail: caught instanceof ApiError ? caught.detail : undefined,
        }),
    );
    return () => {
      current = false;
    };
  }, [token]);

  async function accept(event?: FormEvent) {
    event?.preventDefault();
    setError(undefined);
    try {
      await apiFetch('/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ token, ...(displayName ? { displayName, password } : {}) }),
      });
      refresh();
      void navigate('/', { replace: true });
    } catch (caught) {
      setPassword('');
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Joining failed.');
    }
  }

  const signedIn = state.status === 'signed_in';

  return (
    <main className="sign-in">
      <title>Join a workspace – DataSentinel</title>
      <div className="sign-in__panel">
        <p className="sign-in__brand">
          <BrandMark />
          DataSentinel
        </p>
        {preview.status === 'loading' && <LoadingState label="Opening your invitation" />}
        {preview.status === 'invalid' && (
          <ErrorState title={preview.message} description={preview.detail ?? ''} />
        )}
        {preview.status === 'ready' && (
          <>
            <h1 className="sign-in__title">Join {preview.invitation.workspaceName}</h1>
            <p>
              You are invited as {roleLabel[preview.invitation.role]} with{' '}
              <strong>{preview.invitation.email}</strong>.
            </p>
            {error !== undefined && (
              <div role="alert" className="sign-in__error">
                <p className="sign-in__error-title">{error}</p>
              </div>
            )}
            {preview.invitation.hasAccount ? (
              signedIn ? (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void accept()}
                >
                  Join workspace
                </button>
              ) : (
                <Link
                  className="button button--primary"
                  to="/sign-in"
                  state={{ from: `/invite${location.hash}` }}
                >
                  Sign in to accept
                </Link>
              )
            ) : (
              <form className="sign-in__form" onSubmit={(e) => void accept(e)}>
                <label className="sign-in__field">
                  Your name
                  <input
                    className="text-input"
                    autoComplete="name"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label className="sign-in__field">
                  Choose a password (at least 12 characters)
                  <input
                    className="text-input"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <button type="submit" className="button button--primary">
                  Create account and join
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}
