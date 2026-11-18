import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CELL_H, CELL_W, UNITS_PER_PT, guidesFor, needsReference, referenceCircle, unitsToBoxPt } from '../../shared/layout';
import { keyKind } from '../../shared/unicode';
import { api } from '../lib/api';
import { processScreenCell } from '../lib/workers';
import { Button, Empty, Icon, Slider, Switch, Tip } from '../ui';
import { GlyphView } from '../ui/GlyphView';
import { errorMessage, toast } from '../ui/toast';
import type { WorkspaceCtx } from './Workspace';

interface P {
  x: number; // points within the cell box
  y: number;
  p: number; // pressure 0..1
}
type Stroke = P[];

const RENDER_PX_PER_PT = 6;

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number, width: number, color: string) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (s.length === 1) {
      const p = s[0]!;
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, (width * (0.6 + 0.8 * p.p) * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1]!;
      const b = s[i]!;
      const prev = s[i - 2] ?? a;
      ctx.lineWidth = width * (0.6 + 0.8 * ((a.p + b.p) / 2)) * scale;
      ctx.beginPath();
      // Smooth through midpoints.
      const m0 = { x: (prev.x + a.x) / 2, y: (prev.y + a.y) / 2 };
      const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.moveTo((i === 1 ? a.x : m0.x) * scale, (i === 1 ? a.y : m0.y) * scale);
      ctx.quadraticCurveTo(a.x * scale, a.y * scale, (i === s.length - 1 ? b.x : m1.x) * scale, (i === s.length - 1 ? b.y : m1.y) * scale);
      ctx.stroke();
    }
  }
}

export function WritePad({ ctx, onlyKey }: { ctx: WorkspaceCtx; onlyKey: string | null }) {
  const { detail } = ctx;
  const [rewriteAll, setRewriteAll] = useState(false);
  const queue = useMemo(() => {
    if (onlyKey) return [onlyKey];
    const per = detail.project.samplesPerChar;
    const out: string[] = [];
    for (const k of ctx.writeKeys) {
      const have = (ctx.samplesByKey.get(k) ?? []).filter((s) => s.status === 'ok').length;
      const need = rewriteAll ? per : Math.max(0, per - have);
      for (let i = 0; i < need; i++) out.push(k);
    }
    return out;
    // Freeze the queue for this session so it does not shift while writing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyKey, rewriteAll, ctx.writeKeys.join('\u0001')]);
  const [index, setIndex] = useState(0);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [pen, setPen] = useState(2.2);
  const [saving, setSaving] = useState(false);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const key = queue[index];

  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !key) return;
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    const g = c.getContext('2d')!;
    const scale = c.width / CELL_W;
    g.clearRect(0, 0, c.width, c.height);
    // Guides
    g.strokeStyle = '#C9DCF7';
    for (const gd of guidesFor(key)) {
      const y = unitsToBoxPt(gd.y) * scale;
      g.lineWidth = gd.kind === 'baseline' || gd.kind === 'headline' ? 2 * dpr : 1 * dpr;
      g.setLineDash(gd.kind === 'ascender' || gd.kind === 'descender' ? [4 * dpr, 4 * dpr] : []);
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(c.width, y);
      g.stroke();
    }
    g.setLineDash([]);
    if (needsReference(key)) {
      const ref = referenceCircle(key);
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath();
      g.arc((ref.cx / UNITS_PER_PT) * scale, unitsToBoxPt(ref.cy) * scale, (ref.r / UNITS_PER_PT) * scale, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    drawStrokes(g, drawing.current ? [...strokes, drawing.current] : strokes, scale, pen, '#0A0A0A');
  }, [key, strokes, pen]);

  useEffect(() => {
    redraw();
    const ro = new ResizeObserver(redraw);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  const toPt = (e: React.PointerEvent): P => {
    const r = canvasRef.current!.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    return { x: ((e.clientX - r.left) / r.width) * CELL_W, y: ((e.clientY - r.top) / r.height) * CELL_H, p: pressure };
  };

  const moveCursor = (e: React.PointerEvent) => {
    const el = cursorRef.current;
    const r = padRef.current?.getBoundingClientRect();
    if (!el || !r) return;
    const size = (pen * (r.width / CELL_W)) * (e.pointerType === 'pen' ? 0.6 + 0.8 * (e.pressure || 0.5) : 1);
    el.style.left = `${e.clientX - r.left}px`;
    el.style.top = `${e.clientY - r.top}px`;
    el.style.width = el.style.height = `${Math.max(6, size)}px`;
    el.style.opacity = '1';
  };

  const undo = () => setStrokes((s) => s.slice(0, -1));
  const clear = () => setStrokes([]);

  const save = async () => {
    if (!key) return;
    if (!strokes.length) {
      setIndex((i) => i + 1);
      return;
    }
    setSaving(true);
    try {
      const W = Math.round(CELL_W * RENDER_PX_PER_PT);
      const H = Math.round(CELL_H * RENDER_PX_PER_PT);
      const off = new OffscreenCanvas(W, H);
      const g = off.getContext('2d', { willReadFrequently: true })!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, W, H);
      drawStrokes(g as unknown as CanvasRenderingContext2D, strokes, RENDER_PX_PER_PT, pen, '#000');
      const res = await processScreenCell(key, g.getImageData(0, 0, W, H), RENDER_PX_PER_PT);
      if (!res.sample) {
        toast.error('Nothing to save', 'Write the character, then continue.');
        return;
      }
      if (res.flags.includes('edge')) toast.info('Touching the edge', 'Part of the character may be cut off. Undo to write it a little smaller.');
      await api.addSamples(detail.project.id, null, [res.sample]);
      setLastPath(res.sample.path);
      setStrokes([]);
      setIndex((i) => i + 1);
      void ctx.reload();
    } catch (e) {
      toast.error('Could not save this character', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'Enter' && !saving) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!key)
    return (
      <div className="card">
        <Empty
          icon="check"
          title={onlyKey ? 'Saved' : 'Everything is written'}
          body={onlyKey ? 'The new version replaces the flagged one.' : 'Every character has its samples. Preview the font, or write them all again for more variety.'}
          action={
            <div className="row gap-2">
              {!onlyKey ? (
                <Button
                  onClick={() => {
                    setRewriteAll(true);
                    setIndex(0);
                  }}
                >
                  Write all again
                </Button>
              ) : null}
              <a className="btn btn-primary" href={`/fonts/${detail.project.id}/adjust`}>
                Preview the font
              </a>
            </div>
          }
        />
      </div>
    );

  const kind = keyKind(key).kind;
  return (
    <div className="pad-wrap">
      <div className="stack gap-3">
        <div
          ref={padRef}
          className="pad"
          onPointerDown={(e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            (e.target as Element).setPointerCapture(e.pointerId);
            drawing.current = [toPt(e)];
            moveCursor(e);
            redraw();
          }}
          onPointerMove={(e) => {
            moveCursor(e);
            if (!drawing.current) return;
            const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
            for (const ev of events) drawing.current.push(toPt(ev as unknown as React.PointerEvent));
            redraw();
          }}
          onPointerUp={() => {
            if (drawing.current) setStrokes((s) => [...s, drawing.current!]);
            drawing.current = null;
          }}
          onPointerCancel={() => {
            drawing.current = null;
            redraw();
          }}
          onPointerLeave={() => cursorRef.current && (cursorRef.current.style.opacity = '0')}
        >
          <canvas ref={canvasRef} aria-label={`Writing area for ${key}`} />
          <div ref={cursorRef} className="pen-cursor" style={{ opacity: 0 }} />
        </div>
        <div className="row gap-2" style={{ justifyContent: 'center' }}>
          <Tip label="Undo (Ctrl+Z)">
            <Button icon onClick={undo} disabled={!strokes.length} aria-label="Undo">
              <Icon name="undo" />
            </Button>
          </Tip>
          <Button onClick={clear} disabled={!strokes.length}>
            Clear
          </Button>
          <Button variant="primary" size="lg" loading={saving} onClick={save} style={{ minWidth: 180 }}>
            {strokes.length ? 'Save and next' : 'Skip'} <Icon name="arrowRight" />
          </Button>
        </div>
      </div>
      <aside className="card panel">
        <div className="stack gap-1">
          <span className="muted small tabular">
            {index + 1} of {queue.length}
          </span>
          <div className="pad-target" lang={/[ऀ-ॿ]/.test(key) ? 'hi' : undefined}>
            {kind === 'mark' || kind === 'spacing-mark' || kind === 'rakar' ? '◌' + key : key.replace('‍', '')}
          </div>
          <span className="muted small" style={{ textAlign: 'center' }}>
            {kind === 'mark' || kind === 'rakar' || kind === 'reph' ? 'Write the mark where it sits around the dotted circle.' : 'Sit the letter on the bold line.'}
          </span>
        </div>
        <Slider label="Pen width" value={pen} min={0.8} max={5} step={0.1} onChange={setPen} format={(v) => `${v.toFixed(1)} pt`} />
        {lastPath ? (
          <div className="stack gap-2">
            <span className="label">Last saved</span>
            <div style={{ height: 90, color: 'var(--black)' }}>
              <GlyphView path={lastPath} />
            </div>
          </div>
        ) : null}
        {!onlyKey ? <Switch label="Write all again" hint="Include characters you already wrote" checked={rewriteAll} onChange={(v) => (setRewriteAll(v), setIndex(0))} /> : null}
        <span className="hint">Enter saves, Ctrl+Z undoes. A stylus responds to pressure.</span>
      </aside>
    </div>
  );
}
