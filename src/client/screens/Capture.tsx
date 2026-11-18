import { useMemo, useRef, useState } from 'react';
import type { PageRow } from '../../shared/types';
import { api } from '../lib/api';
import { downloadBytes, generateTemplatePdf } from '../lib/pdf';
import { isPdf, pdfToImages } from '../lib/pdf-pages';
import { navigate } from '../lib/router';
import { detect, extract, release } from '../lib/workers';
import { Button, Checkbox, Dialog, DropZone, Icon, Progress, Select } from '../ui';
import { errorMessage, toast } from '../ui/toast';
import type { WorkspaceCtx } from './Workspace';
import { WritePad } from './WritePad';

type Route = 'print' | 'upload' | 'screen';

interface Job {
  id: number;
  name: string;
  state: 'reading' | 'choose-page' | 'extracting' | 'saving' | 'done' | 'error';
  progress: number | null;
  message?: string;
  preview?: string;
  page?: PageRow;
}

function pageLabel(p: PageRow) {
  return `${p.kind === 'rewrite' ? 'Rewrite sheet' : 'Template'} · page ${p.pageNumber} of ${p.pageCount} · ${new Date(p.createdAt).toLocaleDateString()}`;
}

export function Capture({ ctx }: { ctx: WorkspaceCtx }) {
  const params = new URLSearchParams(location.search);
  const [route, setRoute] = useState<Route>((params.get('route') as Route) ?? 'print');
  const { detail } = ctx;
  const setRouteUrl = (r: Route) => {
    setRoute(r);
    history.replaceState(null, '', `/fonts/${detail.project.id}/capture?route=${r}`);
  };
  return (
    <div className="stack gap-6">
      <div className="tabs-list" role="tablist" aria-label="Input route" style={{ alignSelf: 'flex-start' }}>
        {(
          [
            ['print', 'Print and photograph'],
            ['upload', 'Upload a scan'],
            ['screen', 'Write on screen'],
          ] as const
        ).map(([r, l]) => (
          <button key={r} role="tab" className="tab" data-state={route === r ? 'active' : 'inactive'} aria-selected={route === r} onClick={() => setRouteUrl(r)}>
            {l}
          </button>
        ))}
      </div>
      {route === 'print' ? <PrintRoute ctx={ctx} /> : null}
      {route === 'upload' ? <UploadPanel ctx={ctx} title="Upload scans or photos" /> : null}
      {route === 'screen' ? <WritePad ctx={ctx} onlyKey={params.get('key')} /> : null}
    </div>
  );
}

export async function makeSheet(ctx: WorkspaceCtx, kind: 'template' | 'rewrite', keys: string[]) {
  const t = toast.progress(kind === 'rewrite' ? 'Preparing your rewrite sheet' : 'Preparing your template');
  try {
    const pages = await api.createPages(ctx.detail.project.id, kind, keys);
    const pdf = await generateTemplatePdf(pages, { fontName: ctx.detail.project.name, rewrite: kind === 'rewrite' });
    const batch = pages[0]!.id;
    const safe = ctx.detail.project.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'font';
    downloadBytes(pdf, `jibun-${safe}-${kind}.pdf`, 'application/pdf');
    api.uploadPdf(ctx.detail.project.id, batch, pdf).catch(() => {
      /* keeping a copy is optional */
    });
    toast.dismiss(t);
    toast.success(`${pages.length} ${pages.length === 1 ? 'page' : 'pages'} downloaded`, 'Print at 100% scale, without “fit to page”.');
    await ctx.reload();
  } catch (e) {
    toast.dismiss(t);
    toast.error('Could not make the sheet', errorMessage(e));
  }
}

function PrintRoute({ ctx }: { ctx: WorkspaceCtx }) {
  const [busy, setBusy] = useState(false);
  const remaining = ctx.writeKeys.filter((k) => ctx.status(k) === 'missing');
  const [onlyMissing, setOnlyMissing] = useState(remaining.length > 0 && remaining.length < ctx.writeKeys.length);
  const keys = onlyMissing ? remaining : ctx.writeKeys;
  return (
    <div className="stack gap-5">
      <div className="card card-pad row gap-5 wrap" style={{ justifyContent: 'space-between' }}>
        <div className="stack gap-2" style={{ maxWidth: 520 }}>
          <span className="section-title">1. Print the template</span>
          <p className="muted">
            {keys.length} characters, {ctx.detail.project.samplesPerChar > 1 ? `${ctx.detail.project.samplesPerChar} times each, ` : ''}on {ctx.detail.project.paper === 'a4' ? 'A4' : 'US Letter'}. The light blue
            lines disappear when the page is read, so write right over them.
          </p>
          {remaining.length > 0 && remaining.length < ctx.writeKeys.length ? <Checkbox checked={onlyMissing} onChange={setOnlyMissing} label={`Only the ${remaining.length} characters not written yet`} /> : null}
        </div>
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          disabled={!keys.length}
          onClick={async () => {
            setBusy(true);
            await makeSheet(ctx, 'template', keys);
            setBusy(false);
          }}
        >
          <Icon name="download" /> Download PDF
        </Button>
      </div>
      <UploadPanel ctx={ctx} title="2. Add photos of the filled pages" />
    </div>
  );
}

export function UploadPanel({ ctx, title }: { ctx: WorkspaceCtx; title: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [backup, setBackup] = useState(false);
  const [choose, setChoose] = useState<{ job: number; resolve: (p: PageRow | null) => void } | null>(null);
  const [chosen, setChosen] = useState<string | undefined>();
  const seq = useRef(0);
  const queue = useRef(Promise.resolve());
  const pages = ctx.detail.pages;
  const pageOptions = useMemo(() => pages.slice().reverse().map((p) => ({ value: p.id, label: pageLabel(p) })), [pages]);

  const update = (id: number, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const toDataUrl = (bmp: ImageBitmap) => {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return c.toDataURL('image/jpeg', 0.7);
  };

  const processPage = async (found: { handle: string; pageId: string | null }, id: number, file: Blob) => {
    let handle: string | null = found.handle;
    try {
      let page: PageRow | null = null;
      if (found.pageId) {
        page = pages.find((p) => p.id === found.pageId) ?? (await api.page(found.pageId).catch(() => null));
        if (!page) throw new Error('This sheet belongs to a font that no longer exists.');
        if (page.projectId !== ctx.detail.project.id) throw new Error('This sheet belongs to a different font. Open that font to add it.');
      } else {
        update(id, { state: 'choose-page', progress: null });
        page = await new Promise<PageRow | null>((resolve) => setChoose({ job: id, resolve }));
        if (!page) throw new Error('Skipped: no page chosen.');
      }
      update(id, { state: 'extracting', progress: 0, page });
      const res = await extract(handle, page.cells, page.paper, (d, t) => update(id, { progress: d / t }));
      handle = null;
      if (!res.samples.length) {
        update(id, { state: 'error', progress: null, message: 'No handwriting found on this page. Fill in the boxes, then add it again.' });
        return;
      }
      update(id, { state: 'saving', progress: null });
      for (let i = 0; i < res.samples.length; i += 100) await api.addSamples(ctx.detail.project.id, page.id, res.samples.slice(i, i + 100));
      if (backup && file.size <= 25_000_000)
        api.backupScan(ctx.detail.project.id, file.type ? file : new Blob([file], { type: 'image/png' }), page.id).catch(() => toast.error('Backup failed', 'The page was still processed.'));
      update(id, {
        state: 'done',
        progress: 1,
        message: `${res.samples.length} ${res.samples.length === 1 ? 'character' : 'characters'} read${res.flagged ? `, ${res.flagged} to review` : ''}${res.empty ? `, ${res.empty} empty ${res.empty === 1 ? 'cell' : 'cells'}` : ''}`,
      });
      await ctx.reload();
    } catch (e) {
      if (handle) release(handle);
      update(id, { state: 'error', progress: null, message: errorMessage(e) });
    }
  };

  const processFile = async (file: Blob, id: number, name: string) => {
    let found: Awaited<ReturnType<typeof detect>>;
    try {
      try {
        found = await detect(file, ctx.detail.project.paper);
      } catch (e) {
        if (e instanceof DOMException || /decode|source image|ImageBitmap/i.test(errorMessage(e)))
          throw new Error('This image format could not be opened here. Save it as JPEG or PNG and try again.');
        throw e;
      }
    } catch (e) {
      const msg = errorMessage(e);
      update(id, { state: 'error', progress: null, message: msg.includes('corner') ? `${msg} Retake the photo from straight above, in even light.` : msg });
      return;
    }
    // One image can hold several pages (for example two pages stacked in one scan).
    const ids = found.map((_, k) => {
      if (k === 0) return id;
      const nid = ++seq.current;
      setJobs((js) => [...js, { id: nid, name: `${name} · page ${k + 1} in this image`, state: 'reading', progress: null }]);
      return nid;
    });
    found.forEach((f, k) => update(ids[k]!, { preview: toDataUrl(f.preview) }));
    for (let k = 0; k < found.length; k++) await processPage(found[k]!, ids[k]!, file);
  };

  const enqueue = (blob: Blob, name: string) => {
    const id = ++seq.current;
    setJobs((js) => [...js, { id, name, state: 'reading', progress: null }]);
    // One page at a time keeps memory low on phones.
    queue.current = queue.current.then(() => processFile(blob, id, name));
  };

  const onFiles = (files: File[]) => {
    for (const f of files) {
      if (isPdf(f)) {
        // Each PDF page becomes its own job.
        const id = ++seq.current;
        setJobs((js) => [...js, { id, name: f.name, state: 'reading', progress: null, message: 'Opening PDF' }]);
        queue.current = queue.current.then(async () => {
          try {
            const pages = await pdfToImages(f, (n, t) => update(id, { progress: (n - 1) / t }));
            setJobs((js) => js.filter((j) => j.id !== id));
            pages.forEach((p, i) => enqueue(p, `${f.name} · page ${i + 1} of ${pages.length}`));
          } catch (e) {
            update(id, { state: 'error', progress: null, message: errorMessage(e) });
          }
        });
      } else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name)) {
        enqueue(f, f.name);
      } else {
        const id = ++seq.current;
        setJobs((js) => [...js, { id, name: f.name, state: 'error', progress: null, message: 'Add a photo, a scan image or a PDF.' }]);
      }
    }
  };

  return (
    <div className="stack gap-4">
      <div className="row wrap gap-3" style={{ justifyContent: 'space-between' }}>
        <span className="section-title" style={{ margin: 0 }}>
          {title}
        </span>
        <Checkbox checked={backup} onChange={setBackup} label="Keep a backup of each photo" />
      </div>
      <DropZone accept="image/*,application/pdf,.pdf" title="Drop photos, scans or a PDF here, or choose files" hint="Add every page at once, in any order. Files stay on this device; only the traced letters are saved." onFiles={onFiles} />
      {jobs.length ? (
        <div className="card">
          {jobs.map((j) => (
            <div key={j.id} className="row gap-4" style={{ padding: 16, borderBottom: '1px solid var(--g100)' }}>
              <div style={{ width: 48, height: 64, borderRadius: 6, background: 'var(--g100)', overflow: 'hidden', flex: 'none' }}>{j.preview ? <img src={j.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}</div>
              <div className="stack gap-2 grow">
                <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.page ? pageLabel(j.page) : j.name}</span>
                  <span className={`pill ${j.state === 'done' ? 'green' : j.state === 'error' ? 'red' : 'blue'}`}>
                    {{ reading: 'Finding the page', 'choose-page': 'Needs you', extracting: 'Reading cells', saving: 'Saving', done: 'Done', error: 'Could not read' }[j.state]}
                  </span>
                </div>
                {j.state === 'done' || j.state === 'error' ? <span className="small muted">{j.message}</span> : <Progress value={j.progress} />}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {jobs.some((j) => j.state === 'done') ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={() => navigate(`/fonts/${ctx.detail.project.id}/review`)}>
            Review glyphs <Icon name="arrowRight" />
          </Button>
        </div>
      ) : null}
      <Dialog
        open={!!choose}
        onOpenChange={(o) => {
          if (!o && choose) {
            choose.resolve(null);
            setChoose(null);
          }
        }}
        title="Which page is this?"
        description="The code in the corner could not be read. Pick the page this photo shows."
      >
        <div className="stack gap-4" style={{ marginTop: 16 }}>
          {pageOptions.length ? <Select value={chosen} onChange={setChosen} options={pageOptions} placeholder="Choose a page" label="Page" /> : <p className="muted">There are no printed sheets for this font yet.</p>}
          <div className="dialog-actions">
            <Button
              onClick={() => {
                choose?.resolve(null);
                setChoose(null);
              }}
            >
              Skip this photo
            </Button>
            <Button
              variant="primary"
              disabled={!chosen}
              onClick={() => {
                choose?.resolve(pages.find((p) => p.id === chosen) ?? null);
                setChoose(null);
              }}
            >
              Use this page
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
