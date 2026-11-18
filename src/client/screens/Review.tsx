import { useMemo, useState } from 'react';
import type { SampleFlag, SampleRow } from '../../shared/types';
import { decomposition } from '../../shared/unicode';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { Button, Checkbox, Dialog, Empty, Icon, Select } from '../ui';
import { GlyphView } from '../ui/GlyphView';
import { errorMessage, toast } from '../ui/toast';
import { makeSheet } from './Capture';
import type { WorkspaceCtx } from './Workspace';

const FLAG_TEXT: Record<SampleFlag, string> = {
  empty: 'The cell looked empty.',
  edge: 'The writing touches the edge of the box, so part of it may be cut off.',
  noise: 'There were stray marks near the character.',
  faint: 'The ink is very light.',
  tiny: 'The character is much smaller than expected.',
  unaligned: 'The page could not be aligned precisely.',
};

type Filter = 'all' | 'flagged' | 'missing';

export function Review({ ctx }: { ctx: WorkspaceCtx }) {
  const { detail } = ctx;
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(detail.characters.filter((c) => ctx.status(c.key) === 'flagged').map((c) => c.key)));
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    return detail.characters.filter((c) => {
      const s = ctx.status(c.key);
      return filter === 'all' || (filter === 'flagged' ? s === 'flagged' : s === 'missing');
    });
  }, [detail.characters, filter, ctx]);

  const counts = useMemo(() => {
    const c = { ok: 0, flagged: 0, composed: 0, missing: 0 };
    for (const ch of detail.characters) c[ctx.status(ch.key)]++;
    return c;
  }, [detail.characters, ctx]);

  if (!detail.samples.length)
    return (
      <div className="card">
        <Empty
          title="Nothing to review yet"
          body="Once you upload a filled page or write on screen, every glyph shows up here."
          action={
            <Button variant="primary" onClick={() => navigate(`/fonts/${detail.project.id}/capture`)}>
              Start writing
            </Button>
          }
        />
      </div>
    );

  const openSamples = open ? (ctx.samplesByKey.get(open) ?? []) : [];

  return (
    <div className="stack gap-5">
      <div className="stats">
        <div className="stat">
          <div className="n tabular">{counts.ok}</div>
          <div className="l">Written</div>
        </div>
        <div className="stat">
          <div className="n tabular">{counts.composed}</div>
          <div className="l">Composed for you</div>
        </div>
        <div className="stat" style={counts.flagged ? { borderColor: 'var(--blue)' } : undefined}>
          <div className="n tabular">{counts.flagged}</div>
          <div className="l">To review</div>
        </div>
        <div className="stat">
          <div className="n tabular">{counts.missing}</div>
          <div className="l">Not written</div>
        </div>
      </div>

      <div className="row wrap gap-3" style={{ justifyContent: 'space-between' }}>
        <Select<Filter>
          value={filter}
          onChange={setFilter}
          label="Show"
          options={[
            { value: 'all', label: 'All characters' },
            { value: 'flagged', label: 'To review' },
            { value: 'missing', label: 'Not written' },
          ]}
        />
        <div className="row gap-2">
          {counts.missing ? (
            <Button
              onClick={() =>
                setSelected((s) => {
                  const n = new Set(s);
                  for (const c of detail.characters) if (ctx.status(c.key) === 'missing' && ctx.writeKeys.includes(c.key)) n.add(c.key);
                  return n;
                })
              }
            >
              Add missing to sheet
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!selected.size}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await makeSheet(ctx, 'rewrite', [...selected]);
              setBusy(false);
            }}
          >
            <Icon name="printer" /> Rewrite sheet ({selected.size})
          </Button>
        </div>
      </div>

      {list.length ? (
        <div className="glyph-grid">
          {list.map((c) => {
            const st = ctx.status(c.key);
            const s = ctx.samplesByKey.get(c.key)?.[0];
            let composedPath: string[] = [];
            if (st === 'composed') {
              const d = decomposition(c.key)!;
              composedPath = [d.base, ...d.marks].map((k) => ctx.samplesByKey.get(k)?.[0]?.path ?? '');
            }
            return (
              <button key={c.key} className={`glyph-tile ${st}`} onClick={() => setOpen(c.key)} aria-label={`${c.key}: ${st}`}>
                <span className="key">{c.key.replace('‍', '')}</span>
                {s ? <GlyphView path={s.path} /> : st === 'composed' ? <GlyphView path={composedPath.join(' ')} color="var(--g500)" /> : <span className="ghost">{c.key.replace('‍', '')}</span>}
                {selected.has(c.key) ? <span className="badge" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <Empty icon="check" title="All clear" body="Nothing matches this filter." />
        </div>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open ? `“${open.replace('‍', '')}”` : ''} description={describe(open, ctx)}>
        {open ? (
          <div className="stack gap-5" style={{ marginTop: 16 }}>
            {openSamples.length ? (
              <div className="row gap-3 wrap">
                {openSamples.map((s, i) => (
                  <SampleCard key={s.id} s={s} first={i === 0} ctx={ctx} />
                ))}
              </div>
            ) : null}
            {openSamples.some((s) => s.status === 'flagged') ? (
              <ul className="stack gap-1 small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {[...new Set(openSamples.flatMap((s) => s.flags))].map((f) => (
                  <li key={f}>{FLAG_TEXT[f]}</li>
                ))}
              </ul>
            ) : null}
            <Checkbox
              checked={selected.has(open)}
              onChange={(v) =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (v) n.add(open);
                  else n.delete(open);
                  return n;
                })
              }
              label="Put on the rewrite sheet"
            />
            <div className="dialog-actions" style={{ marginTop: 0 }}>
              <Button onClick={() => navigate(`/fonts/${detail.project.id}/capture?route=screen&key=${encodeURIComponent(open)}`)}>
                <Icon name="pen" /> Redo on screen
              </Button>
              <Button variant="primary" onClick={() => setOpen(null)}>
                Done
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function describe(key: string | null, ctx: WorkspaceCtx) {
  if (!key) return '';
  const st = ctx.status(key);
  if (st === 'flagged') return 'Jibun is unsure about this one. Keep it, remove it, or write it again.';
  if (st === 'composed') return 'Built automatically from the plain letter and its accent. Write it yourself to override.';
  if (st === 'missing') return 'Not written yet.';
  return 'Captured. The first sample is the main glyph; others become alternates.';
}

function SampleCard({ s, first, ctx }: { s: SampleRow; first: boolean; ctx: WorkspaceCtx }) {
  const [busy, setBusy] = useState(false);
  const act = async (status: 'ok' | 'rejected') => {
    setBusy(true);
    try {
      await api.setSampleStatus(ctx.detail.project.id, s.id, status);
      await ctx.reload();
      toast.success(status === 'ok' ? 'Kept' : 'Removed');
    } catch (e) {
      toast.error('Could not update', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack gap-2" style={{ width: 150, padding: 10, borderColor: s.status === 'flagged' ? 'var(--blue)' : undefined }}>
      <div style={{ height: 130 }}>
        <GlyphView path={s.path} guides />
      </div>
      <div className="row gap-1 small" style={{ justifyContent: 'space-between' }}>
        <span className="muted">{first ? 'Main' : 'Alternate'}</span>
        <span className={`pill ${s.status === 'flagged' ? 'blue' : ''}`}>{s.status === 'flagged' ? 'Unsure' : s.source === 'screen' ? 'Screen' : 'Scan'}</span>
      </div>
      <div className="row gap-1">
        {s.status === 'flagged' ? (
          <Button size="sm" className="grow" disabled={busy} onClick={() => act('ok')}>
            Keep
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="grow" disabled={busy} onClick={() => act('rejected')}>
          Remove
        </Button>
      </div>
    </div>
  );
}
