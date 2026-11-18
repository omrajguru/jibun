import { useEffect, useMemo, useRef, useState } from 'react';
import type { BuildReport } from '../../shared/font/build';
import { DEFAULT_SETTINGS, type BuildInput, type FontSettings, type GlyphAdjust } from '../../shared/types';
import { api } from '../lib/api';
import { buildPreview, loadFontFace } from '../lib/workers';
import { Button, Icon, Select, Slider, Spinner, Switch, useDebounced } from '../ui';
import { errorMessage, toast } from '../ui/toast';
import type { WorkspaceCtx } from './Workspace';

const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.\nSphinx of black quartz, judge my vow.';

export function Adjust({ ctx }: { ctx: WorkspaceCtx }) {
  const { detail } = ctx;
  const pid = detail.project.id;
  const [settings, setSettings] = useState<FontSettings>(detail.project.settings);
  const [name, setName] = useState(detail.project.name);
  const [adjusts, setAdjusts] = useState<Record<string, GlyphAdjust | null>>(() => Object.fromEntries(detail.characters.map((c) => [c.key, c.adjust])));
  const [text, setText] = useState(() => localStorageGet(`jibun-preview-${pid}`) ?? SAMPLE_TEXT);
  const [size, setSize] = useState(48);
  const [family, setFamily] = useState<string | null>(null);
  const [report, setReport] = useState<BuildReport | null>(null);
  const [building, setBuilding] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [glyph, setGlyph] = useState<string | undefined>(detail.characters[0]?.key);
  const [ligSeq, setLigSeq] = useState('');
  const [ligOverlap, setLigOverlap] = useState(40);

  // Build preview input from current (unsaved) state.
  const input: BuildInput = useMemo(
    () => ({
      settings,
      characters: detail.characters.map((c) => ({ key: c.key, adjust: adjusts[c.key] ?? null })),
      samples: detail.characters.flatMap((c) => (ctx.samplesByKey.get(c.key) ?? []).map((s) => ({ key: s.key, path: s.path }))),
      ligatures: detail.ligatures,
    }),
    [settings, adjusts, detail.characters, detail.ligatures, ctx.samplesByKey],
  );
  const debounced = useDebounced(input, 250);
  const ver = useRef(0);
  useEffect(() => {
    if (!debounced.samples.length) return;
    const v = ++ver.current;
    setBuilding(true);
    buildPreview(debounced)
      .then(async ({ ttf, report }) => {
        if (v !== ver.current) return;
        const fam = await loadFontFace(ttf);
        if (v !== ver.current) return;
        setFamily(fam);
        setReport(report);
        setPreviewError(null);
      })
      .catch((e) => v === ver.current && setPreviewError(errorMessage(e)))
      .finally(() => v === ver.current && setBuilding(false));
  }, [debounced]);

  // Persist settings and adjustments (debounced).
  const dSettings = useDebounced(settings, 600);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    api.updateProject(pid, { settings: dSettings }).catch((e) => toast.error('Could not save settings', errorMessage(e)));
  }, [dSettings, pid]);
  const dName = useDebounced(name, 800);
  useEffect(() => {
    if (dName.trim() && dName !== detail.project.name) api.updateProject(pid, { name: dName }).then(() => ctx.reload()).catch((e) => toast.error('Could not rename', errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dName]);
  const pendingAdjust = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const setAdjust = (key: string, patch: GlyphAdjust) => {
    setAdjusts((a) => {
      const next = { ...(a[key] ?? {}), ...patch };
      const t = pendingAdjust.current.get(key);
      if (t) clearTimeout(t);
      pendingAdjust.current.set(
        key,
        setTimeout(() => api.setAdjust(pid, key, next).catch((e) => toast.error('Could not save', errorMessage(e))), 600),
      );
      return { ...a, [key]: next };
    });
  };

  useEffect(() => {
    try {
      localStorage.setItem(`jibun-preview-${pid}`, text);
    } catch {
      /* storage unavailable */
    }
  }, [text, pid]);

  const set = (patch: Partial<FontSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const ga = (glyph && adjusts[glyph]) || {};
  const captured = detail.characters.filter((c) => ctx.samplesByKey.has(c.key));

  if (!detail.samples.length)
    return (
      <div className="card card-pad muted" style={{ textAlign: 'center' }}>
        Write a few characters first, then the preview appears here.
      </div>
    );

  return (
    <div className="adjust-layout">
      <div className="stack gap-4">
        <div className="row gap-3 wrap" style={{ justifyContent: 'space-between' }}>
          <div className="row gap-2 small muted">
            {building ? <Spinner /> : null}
            {report ? (
              <span className="tabular">
                {report.glyphCount} glyphs · {report.kerningPairs} kerning pairs · {report.alternates} alternates
                {report.missing.length ? ` · ${report.missing.length} missing` : ''}
              </span>
            ) : null}
          </div>
          <div style={{ width: 220 }}>
            <Slider label="Preview size" value={size} min={16} max={120} onChange={setSize} format={(v) => `${v}px`} />
          </div>
        </div>
        {previewError ? <div className="error-box">{previewError}</div> : null}
        <textarea
          className="preview-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label="Preview text"
          style={{ fontFamily: family ? `"${family}", var(--font-ui)` : undefined, fontSize: size, fontFeatureSettings: '"kern" 1, "calt" 1, "liga" 1', opacity: family ? 1 : 0.4 }}
        />
        {report?.missing.length ? (
          <p className="small muted">
            Not in the font yet: <span style={{ color: 'var(--black)' }}>{report.missing.slice(0, 60).join(' ')}</span>
            {report.missing.length > 60 ? ' …' : ''}
          </p>
        ) : null}

        <div className="card panel">
          <h3>Ligatures</h3>
          <p className="small muted">Join two or more captured glyphs into one, like “ff” or “th”. The overlap pulls them together.</p>
          <div className="row gap-3 wrap" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 140 }}>
              <label className="label" htmlFor="lig">
                Characters
              </label>
              <input id="lig" className="input" value={ligSeq} maxLength={6} placeholder="th" onChange={(e) => setLigSeq(e.target.value)} />
            </div>
            <div className="grow" style={{ minWidth: 180 }}>
              <Slider label="Overlap" value={ligOverlap} min={-100} max={300} step={5} onChange={setLigOverlap} />
            </div>
            <Button
              disabled={Array.from(ligSeq).length < 2}
              onClick={async () => {
                const missing = Array.from(ligSeq).filter((ch) => !ctx.samplesByKey.has(ch));
                if (missing.length) return toast.error('Capture these first', missing.join(' '));
                try {
                  ctx.setDetail(await api.addLigature(pid, ligSeq, ligOverlap));
                  setLigSeq('');
                } catch (e) {
                  toast.error('Could not add ligature', errorMessage(e));
                }
              }}
            >
              <Icon name="plus" /> Add
            </Button>
          </div>
          {detail.ligatures.length ? (
            <div className="row gap-2 wrap">
              {detail.ligatures.map((l) => (
                <span key={l.id} className="pill" style={{ height: 32, fontSize: 14 }}>
                  <span style={{ fontFamily: family ? `"${family}"` : undefined, fontSize: 20 }}>{l.sequence}</span>
                  <span className="muted small">{l.overlap}</span>
                  <button className="btn btn-ghost btn-sm btn-icon" style={{ width: 22, height: 22 }} aria-label={`Remove ${l.sequence}`} onClick={async () => ctx.setDetail(await api.deleteLigature(pid, l.id))}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <aside className="stack gap-4">
        <div className="card panel">
          <div className="field">
            <label className="label" htmlFor="rename-input">
              Font name
            </label>
            <input
              id="rename-input"
              className="input"
              value={name}
              maxLength={60}
              onChange={(e) => {
                setName(e.target.value);
                set({ familyName: e.target.value || 'My Handwriting' });
              }}
            />
          </div>
          <h3>Whole font</h3>
          <Slider label="Spacing" value={settings.tracking} min={-80} max={200} onChange={(v) => set({ tracking: v })} />
          <Slider label="Word space" value={settings.spaceWidth} min={100} max={800} step={10} onChange={(v) => set({ spaceWidth: v })} />
          <Slider label="Baseline" value={settings.baselineShift} min={-150} max={150} onChange={(v) => set({ baselineShift: v })} />
          <Slider label="Size" value={settings.scale} min={0.6} max={1.6} step={0.01} onChange={(v) => set({ scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Switch label="Kerning" hint="Tightens pairs like To and AV" checked={settings.kerning} onChange={(v) => set({ kerning: v })} />
          {settings.kerning ? <Slider label="Kerning strength" value={settings.kerningStrength} min={0.2} max={1.6} step={0.05} onChange={(v) => set({ kerningStrength: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
          <Switch label="Natural variation" hint="Rotate between your samples of each letter" checked={settings.alternates} onChange={(v) => set({ alternates: v })} />
          <Switch label="Compose accented letters" hint="Build é, ñ, ấ from letters and accents" checked={settings.autoCompose} onChange={(v) => set({ autoCompose: v })} />
          <Button variant="ghost" size="sm" onClick={() => setSettings({ ...DEFAULT_SETTINGS, familyName: settings.familyName })}>
            Reset to defaults
          </Button>
        </div>

        <div className="card panel">
          <h3>One character</h3>
          <Select value={glyph} onChange={setGlyph} label="Character" options={captured.map((c) => ({ value: c.key, label: `${c.key.replace('‍', '')}  ${adjusts[c.key] ? '•' : ''}` }))} />
          {glyph ? (
            <>
              <Slider label="Space before" value={ga.lsb ?? 0} min={-150} max={250} onChange={(v) => setAdjust(glyph, { lsb: v })} />
              <Slider label="Space after" value={ga.rsb ?? 0} min={-150} max={250} onChange={(v) => setAdjust(glyph, { rsb: v })} />
              <Slider label="Baseline" value={ga.baseline ?? 0} min={-200} max={200} onChange={(v) => setAdjust(glyph, { baseline: v })} />
              <Slider label="Size" value={ga.scale ?? 1} min={0.5} max={1.8} step={0.01} onChange={(v) => setAdjust(glyph, { scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <Button variant="ghost" size="sm" onClick={() => setAdjust(glyph, { lsb: 0, rsb: 0, baseline: 0, scale: 1 })}>
                Reset this character
              </Button>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
