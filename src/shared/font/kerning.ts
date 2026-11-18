/**
 * Automatic kerning from outline profiles.
 *
 * For every glyph we sample its left and right ink profile in horizontal bands.
 * For a pair, the visible gap in each band where both glyphs have ink is
 * (advanceA - rightA) + leftB. Pairs whose smallest gap differs from the
 * typical gap of the font are tightened or loosened, with a collision guard
 * that keeps a minimum distance after dilating the profiles vertically.
 */
import { flatten, type Outline } from './path';

const BAND = 20;
const Y_MIN = -400;
const Y_MAX = 1100;
const NB = Math.ceil((Y_MAX - Y_MIN) / BAND);

export interface Profile {
  left: Float64Array; // NaN when no ink in band
  right: Float64Array;
  advance: number;
}

export function profileOf(o: Outline, advance: number): Profile {
  const left = new Float64Array(NB).fill(NaN);
  const right = new Float64Array(NB).fill(NaN);
  const polys = o.map((c) => flatten(c, 10));
  for (let b = 0; b < NB; b++) {
    for (const f of [0.2, 0.5, 0.8]) {
      const y = Y_MIN + (b + f) * BAND;
      for (const poly of polys) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const p = poly[i]!;
          const q = poly[j]!;
          if (p.y > y !== q.y > y) {
            const x = p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y);
            if (!(x >= left[b]!)) left[b] = Number.isNaN(left[b]!) ? x : Math.min(left[b]!, x);
            if (!(x <= right[b]!)) right[b] = Number.isNaN(right[b]!) ? x : Math.max(right[b]!, x);
          }
        }
      }
    }
  }
  return { left, right, advance };
}

function dilate(arr: Float64Array, radius: number, mode: 'min' | 'max'): Float64Array {
  const out = new Float64Array(arr.length).fill(NaN);
  for (let i = 0; i < arr.length; i++) {
    let v = NaN;
    for (let k = Math.max(0, i - radius); k <= Math.min(arr.length - 1, i + radius); k++) {
      const a = arr[k]!;
      if (Number.isNaN(a)) continue;
      if (Number.isNaN(v)) v = a;
      else v = mode === 'min' ? Math.min(v, a) : Math.max(v, a);
    }
    out[i] = v;
  }
  return out;
}

export interface KernGlyph {
  id: number; // class or glyph id
  outline: Outline;
  advance: number;
}

/** Returns adjustments keyed by left id then right id. */
export function autoKern(glyphs: KernGlyph[], strength = 1): Map<number, Map<number, number>> {
  const result = new Map<number, Map<number, number>>();
  if (glyphs.length < 2 || strength <= 0) return result;
  const prof = glyphs.map((g) => profileOf(g.outline, g.advance));
  const dil = prof.map((p) => ({ left: dilate(p.left, 3, 'min'), right: dilate(p.right, 3, 'max') }));

  const minGap = (a: number, b: number): number | null => {
    const A = prof[a]!;
    const B = prof[b]!;
    let m = Infinity;
    let any = false;
    for (let i = 0; i < NB; i++) {
      const r = A.right[i]!;
      const l = B.left[i]!;
      if (Number.isNaN(r) || Number.isNaN(l)) continue;
      any = true;
      m = Math.min(m, A.advance - r + l);
    }
    return any ? m : null;
  };
  const collisionGap = (a: number, b: number): number | null => {
    const A = prof[a]!;
    const Ad = dil[a]!;
    const Bd = dil[b]!;
    let m = Infinity;
    let any = false;
    for (let i = 0; i < NB; i++) {
      const r = Ad.right[i]!;
      const l = Bd.left[i]!;
      if (Number.isNaN(r) || Number.isNaN(l)) continue;
      any = true;
      m = Math.min(m, A.advance - r + l);
    }
    return any ? m : null;
  };

  // Typical gap: median of the minimum gaps across all pairs with overlapping ink.
  const gaps: number[] = [];
  const n = glyphs.length;
  const stride = Math.max(1, Math.floor((n * n) / 40000));
  let k = 0;
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      if (k++ % stride) continue;
      const g = minGap(a, b);
      if (g !== null && Number.isFinite(g)) gaps.push(g);
    }
  if (!gaps.length) return result;
  gaps.sort((x, y) => x - y);
  const target = gaps[Math.floor(gaps.length / 2)]!;

  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const d = minGap(a, b);
      if (d === null) continue;
      let kern = (target - d) * strength;
      if (kern > 0) kern = Math.min(kern * 0.5, 40); // loosen gently
      else {
        const cg = collisionGap(a, b);
        if (cg !== null) kern = Math.max(kern, -(cg - target * 0.45));
        kern = Math.max(kern, -250);
        if (kern > 0) kern = 0;
      }
      kern = Math.round(kern / 5) * 5;
      if (Math.abs(kern) < 10) continue;
      const row = result.get(glyphs[a]!.id) ?? new Map<number, number>();
      row.set(glyphs[b]!.id, kern);
      result.set(glyphs[a]!.id, row);
    }
  }
  return result;
}
