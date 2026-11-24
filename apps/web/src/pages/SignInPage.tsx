import { useId, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../api/client.ts';
import { BrandMark } from '../app/BrandMark.tsx';
import { useSession } from '../app/session.ts';
import './SignInPage.css';

const DEMO_EMAIL = 'recruiter@datasentinel.dev';
const DEMO_PASSWORD = 'DemoPassword2026!';

/** Email and password sign-in (D-28). Google and GitHub sign-in are added
 * when their OAuth apps exist. */
export function SignInPage() {
  const { state, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForgot, setShowForgot] = useState(false);
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

  async function loginAsDemo() {
    if (busy) return;
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    setBusy(true);
    setError(undefined);
    try {
      await signIn(DEMO_EMAIL, DEMO_PASSWORD);
      void navigate(from, { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? {
              title: caught.message,
              detail: `${caught.detail ?? ''} (Ensure ${DEMO_EMAIL} is created in your database).`,
            }
          : { title: `Demo sign-in failed. Check if ${DEMO_EMAIL} exists.` },
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
            <div className="sign-in__field-header">
              <span>Password</span>
              <button
                type="button"
                className="sign-in__link-btn"
                onClick={() => setShowForgot((prev) => !prev)}
              >
                {showForgot ? 'Hide help' : 'Forgot password?'}
              </button>
            </div>
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

          {showForgot && (
            <div className="sign-in__help-card" role="region" aria-label="Password recovery">
              <p className="sign-in__help-title">Need to reset your password?</p>
              <p className="sign-in__help-text">
                For security in this deployment, passwords are reset by the system operator. If you
                are the project owner, run this command in your terminal:
              </p>
              <code className="sign-in__help-code">
                pnpm --filter @datasentinel/api user:reset-password
              </code>
              <p className="sign-in__help-text">
                Or contact your workspace administrator to reissue an invitation.
              </p>
            </div>
          )}

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

        <div className="sign-in__demo-section">
          <div className="sign-in__divider">
            <span className="sign-in__divider-label">Recruiter & Reviewer Access</span>
          </div>
          <button
            type="button"
            className="button sign-in__demo-btn"
            disabled={busy}
            onClick={() => void loginAsDemo()}
          >
            ⚡ One-Click Recruiter Demo
          </button>
          <p className="sign-in__demo-caption">
            Autofills <code>{DEMO_EMAIL}</code> and signs into the demo workspace.
          </p>
        </div>
      </div>
    </main>
  );
}
