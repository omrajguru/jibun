import { useEffect, useState } from 'react';
import type { BuildSummary, ExportFormat } from '../../shared/types';
import { api, subscribe } from '../lib/api';
import { buildLocally } from '../lib/workers';
import { Button, Checkbox, Empty, Icon, Progress } from '../ui';
import { errorMessage, toast } from '../ui/toast';
import { formatBytes } from './History';
import { relTime, useLoad } from './Library';
import type { WorkspaceCtx } from './Workspace';

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'otf', label: 'OTF', hint: 'Best for installing on Mac and Windows' },
  { id: 'ttf', label: 'TTF', hint: 'Works everywhere, including older apps' },
  { id: 'woff2', label: 'WOFF2', hint: 'Compressed, for websites' },
];

export function Export({ ctx }: { ctx: WorkspaceCtx }) {
  const pid = ctx.detail.project.id;
  const [formats, setFormats] = useState<ExportFormat[]>(['otf', 'ttf', 'woff2']);
  const { data: builds, reload, setData } = useLoad(() => api.builds(pid), [pid]);
  const [active, setActive] = useState<BuildSummary | null>(null);

  // Live progress from the project's Durable Object, with polling as a fallback.
  useEffect(() => {
    const off = subscribe(pid, (e) => {
      if (e.type !== 'build' || !e.build) return;
      setActive(e.build);
      if (e.build.status === 'done' || e.build.status === 'failed') reload();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  const running = active && (active.status === 'queued' || active.status === 'running');
  useEffect(() => {
    if (!running || !active) return;
    const t = setInterval(async () => {
      try {
        const { build } = await api.getBuild(active.id);
        setActive((a) => (a && a.id === build.id && (build.status === 'done' || build.status === 'failed' || a.status === build.status) ? { ...build, progress: a.progress } : a));
        if (build.status === 'done' || build.status === 'failed') {
          setActive(build);
          reload();
        }
      } catch {
        /* keep waiting */
      }
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, active?.id]);

  // Fallback: if the server build fails or stalls, build the same font in the browser.
  const [local, setLocal] = useState(false);
  const buildInBrowser = async (replaces?: string) => {
    if (local) return;
    setLocal(true);
    const t = toast.progress('Building in your browser');
    try {
      const input = {
        settings: ctx.detail.project.settings,
        characters: ctx.detail.characters.map((c) => ({ key: c.key, adjust: c.adjust })),
        samples: ctx.detail.characters.flatMap((c) => (ctx.samplesByKey.get(c.key) ?? []).map((s) => ({ key: s.key, path: s.path }))),
        ligatures: ctx.detail.ligatures,
      };
      const { files, report } = await buildLocally(input, formats.length ? formats : ['otf', 'ttf', 'woff2']);
      const b = await api.uploadBuild(pid, files, report, replaces);
      setActive(b);
      reload();
      toast.dismiss(t);
      toast.success('Your font is ready', 'Download it below.');
    } catch (e) {
      toast.dismiss(t);
      toast.error('Export failed', errorMessage(e));
    } finally {
      setLocal(false);
    }
  };
  useEffect(() => {
    if (active?.status === 'done' && !local) toast.success('Your font is ready', 'Download it below.');
    if (active?.status === 'failed' && active.error !== 'Built in the browser instead') void buildInBrowser(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.status, active?.id]);
  useEffect(() => {
    if (!running || !active) return;
    const t = setTimeout(() => void buildInBrowser(active.id), 45000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, active?.id]);

  // Build here, with the same compiler the server uses, then store the files.
  // This is fast and does not depend on the Worker's CPU limits.
  const start = () => buildInBrowser();

  const latest = builds?.find((b) => b.status === 'done');

  return (
    <div className="stack gap-5">
      <div className="card card-pad stack gap-5">
        <div className="stack gap-2">
          <span className="section-title">Export {ctx.detail.project.settings.familyName}</span>
          <p className="muted">Every export is kept here, so you can download any version again.</p>
        </div>
        <div className="stack gap-3">
          {FORMATS.map((f) => (
            <Checkbox
              key={f.id}
              checked={formats.includes(f.id)}
              onChange={(v) => setFormats((s) => (v ? [...s, f.id] : s.filter((x) => x !== f.id)))}
              label={
                <span>
                  <strong style={{ fontWeight: 500 }}>{f.label}</strong> <span className="muted">· {f.hint}</span>
                </span>
              }
            />
          ))}
        </div>
        {running ? (
          <div className="stack gap-2">
            <span className="small muted">{active!.status === 'queued' ? 'Waiting for a builder…' : 'Building your font…'}</span>
            <Progress value={active!.progress ?? null} />
          </div>
        ) : null}
        <div className="row gap-2">
          <Button variant="primary" size="lg" disabled={!formats.length || !!running || local || !ctx.detail.samples.length} loading={!!running || local} onClick={start}>
            <Icon name="download" /> Export font
          </Button>
          {latest ? (
            <span className="small muted">
              Last export {relTime(latest.finishedAt ?? latest.createdAt)}, {latest.glyphCount} glyphs
            </span>
          ) : null}
        </div>
      </div>

      {builds && !builds.length ? (
        <div className="card">
          <Empty icon="download" title="No exports yet" body="Your exports appear here with every format you chose." />
        </div>
      ) : null}
      {builds?.length ? (
        <div className="card">
          {builds.map((b) => (
            <div key={b.id} className="row gap-4 wrap" style={{ padding: 16, borderBottom: '1px solid var(--g100)', justifyContent: 'space-between' }}>
              <div className="stack">
                <span style={{ fontWeight: 500 }}>{new Date(b.createdAt).toLocaleString()}</span>
                <span className="small muted">{b.status === 'done' ? `${b.glyphCount} glyphs` : b.status === 'failed' ? (b.error ?? 'Failed') : 'Building'}</span>
              </div>
              <div className="row gap-2 wrap">
                {b.files.map((f) => (
                  <a key={f.format} className="btn btn-sm" href={api.fileUrl(b.id, f.format)} download>
                    <Icon name="download" size={14} /> {f.format.toUpperCase()} <span className="muted">{formatBytes(f.size)}</span>
                  </a>
                ))}
                {b.status === 'failed' ? <span className="pill red">Failed</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
