import { useId, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../api/client.ts';
import { BrandMark } from '../app/BrandMark.tsx';
import { useSession } from '../app/session.ts';
import './SignInPage.css';

/** Email and password sign-in (D-28). Google and GitHub sign-in are added
 * when their OAuth apps exist. */
export function SignInPage() {
  const { state, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ title: string; detail?: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  if (state.status === 'signed_in') return <Navigate to={from} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email, password);
      void navigate(from, { replace: true });
    } catch (caught) {
      // The email stays; the password is cleared for the next try.
      setPassword('');
      setError(
        caught instanceof ApiError
          ? { title: caught.message, detail: caught.detail }
          : { title: 'Sign-in failed. Try again.' },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="sign-in">
      <title>Sign in – DataSentinel</title>
      <div className="sign-in__panel">
        <p className="sign-in__brand">
          <BrandMark />
          DataSentinel
        </p>
        <h1 className="sign-in__title">Sign in</h1>
        <form className="sign-in__form" onSubmit={(e) => void submit(e)} noValidate>
          <label className="sign-in__field">
            Email
            <input
              className="text-input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error === undefined ? undefined : errorId}
            />
          </label>
          <label className="sign-in__field">
            Password
            <input
              className="text-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={error === undefined ? undefined : errorId}
            />
          </label>
          {error !== undefined && (
            <div id={errorId} role="alert" className="sign-in__error">
              <p className="sign-in__error-title">{error.title}</p>
              {error.detail !== undefined && <p>{error.detail}</p>}
            </div>
          )}
          <button
            type="submit"
            className="button button--primary"
            aria-disabled={busy || undefined}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
