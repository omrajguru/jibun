import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../../shared/types';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { Button, Empty, ErrorBox, Icon, Progress } from '../ui';

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    fn()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

export function relTime(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function Library() {
  const { data, error, reload } = useLoad(api.projects);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Library</div>
          <h1 className="display">Your fonts</h1>
        </div>
        <Button variant="primary" size="lg" onClick={() => navigate('/new')}>
          <Icon name="plus" /> New font
        </Button>
      </div>
      {error ? <ErrorBox error={error} retry={reload} /> : null}
      {!data && !error ? (
        <div className="font-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 180 }} />
          ))}
        </div>
      ) : null}
      {data && !data.length ? (
        <div className="card">
          <Empty
            title="Start your first font"
            body="Pick the characters you want, write them on paper or on screen, and Jibun builds an installable font."
            action={
              <Button variant="primary" onClick={() => navigate('/new')}>
                New font
              </Button>
            }
          />
        </div>
      ) : null}
      {data?.length ? (
        <div className="font-list">
          {data.map((p) => (
            <FontCard key={p.id} p={p} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FontCard({ p }: { p: ProjectSummary }) {
  const pct = p.characterCount ? p.capturedCount / p.characterCount : 0;
  return (
    <Link to={`/fonts/${p.id}`} className="card font-card">
      <div className="stack gap-1">
        <div className="name">{p.name}</div>
        <div className="muted small">Edited {relTime(p.updatedAt)}</div>
      </div>
      <div className="stack gap-2">
        <div className="row small" style={{ justifyContent: 'space-between' }}>
          <span className="tabular">
            {p.capturedCount} of {p.characterCount} ready
          </span>
          {p.flaggedCount ? <span className="pill blue">{p.flaggedCount} to review</span> : null}
        </div>
        <Progress value={Math.min(1, pct)} />
      </div>
      <div className="row gap-2 small muted">
        {p.lastBuild?.status === 'done' ? <span className="pill green">Exported {relTime(p.lastBuild.finishedAt ?? p.lastBuild.createdAt)}</span> : <span className="pill">Not exported yet</span>}
      </div>
    </Link>
  );
}
