import * as RTooltip from '@radix-ui/react-tooltip';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './lib/api';
import { Link, match, navigate, usePath } from './lib/router';
import { History } from './screens/History';
import { Library } from './screens/Library';
import { Login } from './screens/Login';
import { NewFont } from './screens/NewFont';
import { Workspace } from './screens/Workspace';
import './styles.css';
import { ConfirmProvider, Icon, Menu, Spinner } from './ui';
import { Toaster } from './ui/toast';

function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  const path = usePath();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          Jibun <small>自分</small>
        </Link>
        <nav className="topnav" aria-label="Main">
          <Link to="/" className="nav-link" aria-current={path === '/' || path.startsWith('/fonts') || path.startsWith('/new') ? 'page' : undefined}>
            Fonts
          </Link>
          <Link to="/history" className="nav-link" aria-current={path.startsWith('/history') ? 'page' : undefined}>
            Exports
          </Link>
        </nav>
        <div className="spacer" />
        <Menu
          trigger={
            <button className="btn btn-ghost btn-sm" aria-label="Account">
              <span className="muted small">{email}</span>
              <Icon name="chevron" size={14} />
            </button>
          }
          items={[
            {
              label: 'Sign out',
              onSelect: async () => {
                await api.signOut();
                navigate('/login', true);
              },
            },
          ]}
        />
      </header>
      <main>{children}</main>
    </div>
  );
}

function App() {
  const path = usePath();
  const [session, setSession] = useState<{ email: string } | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (path.startsWith('/login')) return;
    api
      .session()
      .then((s) => {
        setSession(s);
        if (!s) navigate(`/login?next=${encodeURIComponent(path)}`, true);
      })
      .catch(() => setFailed(true));
    // Only on first load and when leaving the login page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.startsWith('/login')]);

  if (path.startsWith('/login')) return <Login />;
  if (failed)
    return (
      <div className="empty" style={{ minHeight: '100%', justifyContent: 'center' }}>
        <h3>Jibun is unreachable</h3>
        <p>Check your connection, then reload the page.</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  if (!session)
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Spinner />
      </div>
    );

  let screen: React.ReactNode;
  let m: Record<string, string> | null;
  if (match('/', path)) screen = <Library />;
  else if (match('/new', path)) screen = <NewFont />;
  else if (match('/history', path)) screen = <History />;
  else if ((m = match('/fonts/:id/:tab?', path))) screen = <Workspace key={m.id} id={m.id!} tab={(m.tab as 'capture') ?? 'capture'} />;
  else
    screen = (
      <div className="empty">
        <h3>Nothing here</h3>
        <Link to="/" className="btn">
          Back to your fonts
        </Link>
      </div>
    );
  return <Shell email={session.email}>{screen}</Shell>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RTooltip.Provider>
      <Toaster>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </Toaster>
    </RTooltip.Provider>
  </StrictMode>,
);
