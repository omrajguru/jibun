import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectDetail, SampleRow } from '../../shared/types';
import { decomposition, keysToWrite } from '../../shared/unicode';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { Button, ErrorBox, Icon, Menu, Spinner, useConfirm } from '../ui';
import { errorMessage, toast } from '../ui/toast';
import { Adjust } from './Adjust';
import { Capture } from './Capture';
import { Export } from './Export';
import { Review } from './Review';

export type Tab = 'capture' | 'review' | 'adjust' | 'export';

export interface WorkspaceCtx {
  detail: ProjectDetail;
  reload: () => Promise<void>;
  setDetail: (d: ProjectDetail) => void;
  /** keys the person has to write (accented letters may be composed) */
  writeKeys: string[];
  /** per key, samples ordered best first */
  samplesByKey: Map<string, SampleRow[]>;
  /** state of every character */
  status: (key: string) => 'ok' | 'flagged' | 'composed' | 'missing';
}

export function useWorkspace(detail: ProjectDetail | null) {
  return useMemo(() => {
    if (!detail) return null;
    const samplesByKey = new Map<string, SampleRow[]>();
    for (const s of detail.samples) {
      if (s.status === 'rejected') continue;
      const arr = samplesByKey.get(s.key) ?? [];
      arr.push(s);
      samplesByKey.set(s.key, arr);
    }
    for (const arr of samplesByKey.values()) arr.sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'ok' ? -1 : 1));
    const keys = detail.characters.map((c) => c.key);
    const { write } = keysToWrite(keys, detail.project.settings.autoCompose);
    const writeSet = new Set(write);
    const status = (key: string): 'ok' | 'flagged' | 'composed' | 'missing' => {
      const arr = samplesByKey.get(key);
      if (arr?.some((s) => s.status === 'ok')) return 'ok';
      if (arr?.length) return 'flagged';
      if (!writeSet.has(key) && detail.project.settings.autoCompose) {
        const d = decomposition(key);
        if (d && [d.base, ...d.marks].every((k) => samplesByKey.get(k)?.length)) return 'composed';
      }
      return 'missing';
    };
    return { writeKeys: write, samplesByKey, status };
  }, [detail]);
}

export function Workspace({ id, tab }: { id: string; tab: Tab }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const confirm = useConfirm();
  const reload = useCallback(async () => {
    try {
      setDetail(await api.project(id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const ws = useWorkspace(detail);

  if (error && !detail)
    return (
      <div className="page">
        <ErrorBox error={error} retry={reload} />
      </div>
    );
  if (!detail || !ws)
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center', minHeight: 300 }}>
        <Spinner />
      </div>
    );

  const flagged = detail.characters.filter((c) => ws.status(c.key) === 'flagged').length;
  const ctx: WorkspaceCtx = { detail, reload, setDetail, ...ws };
  const tabs: [Tab, string, number?][] = [
    ['capture', 'Write'],
    ['review', 'Review', flagged],
    ['adjust', 'Preview & adjust'],
    ['export', 'Export'],
  ];
  const done = detail.characters.filter((c) => ['ok', 'composed', 'flagged'].includes(ws.status(c.key))).length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack gap-2">
          <Link to="/" className="eyebrow row gap-1" style={{ color: 'var(--g500)' }}>
            <Icon name="arrowLeft" size={14} /> All fonts
          </Link>
          <h1 className="display">{detail.project.name}</h1>
          <span className="muted small tabular">
            {done} of {detail.characters.length} characters ready
          </span>
        </div>
        <div className="row gap-2">
          <nav className="tabs-list" aria-label="Font sections">
            {tabs.map(([t, label, count]) => (
              <Link key={t} to={`/fonts/${id}/${t}`} className="tab row" aria-current={tab === t ? 'page' : undefined} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
                {label}
                {count ? <span className="count">{count}</span> : null}
              </Link>
            ))}
          </nav>
          <Menu
            trigger={
              <Button icon aria-label="More">
                <Icon name="more" />
              </Button>
            }
            items={[
              {
                label: 'Rename font',
                onSelect: () => {
                  const el = document.getElementById('rename-input') as HTMLInputElement | null;
                  navigate(`/fonts/${id}/adjust`);
                  setTimeout(() => (document.getElementById('rename-input') as HTMLInputElement | null)?.focus(), 50);
                  void el;
                },
              },
              'sep',
              {
                label: 'Delete font',
                danger: true,
                onSelect: async () => {
                  const ok = await confirm({ title: 'Delete this font?', body: 'Every captured glyph, sheet and export of this font is removed for good.', confirm: 'Delete font', danger: true });
                  if (!ok) return;
                  try {
                    await api.deleteProject(id);
                    toast.success('Font deleted');
                    navigate('/', true);
                  } catch (e) {
                    toast.error('Could not delete the font', errorMessage(e));
                  }
                },
              },
            ]}
          />
        </div>
      </div>
      {tab === 'capture' ? <Capture ctx={ctx} /> : null}
      {tab === 'review' ? <Review ctx={ctx} /> : null}
      {tab === 'adjust' ? <Adjust ctx={ctx} /> : null}
      {tab === 'export' ? <Export ctx={ctx} /> : null}
    </div>
  );
}
