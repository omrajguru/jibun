import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { MIN_PASSWORD_LENGTH } from '../../shared/password';
import { Button } from '../ui';

export function Login() {
  const params = new URLSearchParams(location.search);
  const rawNext = params.get('next') ?? '/';
  // Only same-origin relative paths are allowed as a return target.
  const next = rawNext.startsWith('/') && !/[\\\u0000-\u001f]/.test(rawNext) && !rawNext.startsWith('//') ? rawNext : '/';
  const [signup, setSignup] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'google' | null>(null);
  const [google, setGoogle] = useState(false);
  const [error, setError] = useState<string | null>(params.get('error') ? 'Sign-in failed. Please try again.' : null);

  useEffect(() => {
    api.authMethods().then((m) => setGoogle(m.google)).catch(() => {});
  }, []);

  return (
    <div className="login">
      <div className="login-art">
        <div className="brand" style={{ color: 'white' }}>
          Jibun
        </div>
        <div className="kanji" aria-hidden>
          自分
        </div>
        <p style={{ color: 'var(--g400)', maxWidth: 360 }}>Your handwriting, installed as a font.</p>
      </div>
      <div className="login-form">
        <div className="stack gap-2">
          <h1 className="display" style={{ fontSize: 48 }}>
            {signup ? 'Create an account' : 'Welcome back'}
          </h1>
          <p className="muted">{signup ? 'Create a private library for your fonts.' : 'Sign in to open your font library.'}</p>
        </div>
        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : null}
        <form
          className="stack gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy('password');
            setError(null);
            try {
              if (signup) await api.signUp(name, email, password);
              else await api.signInPassword(email, password);
              location.replace(next);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setPassword('');
            } finally {
              setBusy(null);
            }
          }}
        >
          {signup && (
            <div className="field">
              <label className="label" htmlFor="name">Name</label>
              <input id="name" className="input" autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label className="label" htmlFor="email">
              Email
            </label>
            <input id="email" className="input" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">
              Password
            </label>
            <input id="password" className="input" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? MIN_PASSWORD_LENGTH : undefined} maxLength={256} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {signup && <p className="hint">Use at least {MIN_PASSWORD_LENGTH} characters for your password.</p>}
          <Button variant="primary" size="lg" type="submit" loading={busy === 'password'} disabled={!!busy}>
            {signup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
        {google ? (
          <>
            <div className="row gap-3 muted small">
              <span className="grow" style={{ height: 1, background: 'var(--g200)' }} />
              or
              <span className="grow" style={{ height: 1, background: 'var(--g200)' }} />
            </div>
            <Button
              size="lg"
              loading={busy === 'google'}
              disabled={!!busy}
              onClick={async () => {
                setBusy('google');
                setError(null);
                try {
                  await api.signInGoogle(next);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                  setBusy(null);
                }
              }}
            >
              Continue with Google
            </Button>
          </>
        ) : null}
        <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => {
          setSignup(!signup);
          setError(null);
          setPassword('');
        }}>
          {signup ? 'Already have an account? Sign in' : 'New to Jibun? Create an account'}
        </button>
      </div>
    </div>
  );
}
