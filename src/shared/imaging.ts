/**
 * Scan and photo processing. Pure TypeScript so it runs in a Web Worker and in
 * tests. Pipeline:
 *   luminance -> illumination normalisation -> marker detection -> homography
 *   -> QR orientation -> canonical warp -> per-cell registration -> hysteresis
 *   threshold -> connected components -> glyph selection and quality flags.
 */
import { BOX_TOP_UNITS, CANON_PX_PER_PT, UNITS_PER_PT, pageLayout, type Paper, type PageLayout, type CellRect } from './layout';
import type { SampleFlag } from './types';

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// ------------------------------------------------------------------ basics

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const n = width * height;
  const data = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Rec. 601 luma; alpha composited over white.
    const a = rgba[j + 3]! / 255;
    const l = 0.299 * rgba[j]! + 0.587 * rgba[j + 1]! + 0.114 * rgba[j + 2]!;
    data[i] = Math.round(l * a + 255 * (1 - a));
  }
  return { data, width, height };
}

/** Area-average downscale so the long side is at most `maxSide` and (optionally) the area at most `maxPixels`. */
export function downscale(g: Gray, maxSide: number, maxPixels = Infinity): Gray {
  const long = Math.max(g.width, g.height);
  const s = Math.min(1, maxSide / long, Math.sqrt(maxPixels / (g.width * g.height)));
  if (s >= 1) return g;
  const W = Math.max(1, Math.round(g.width * s));
  const H = Math.max(1, Math.round(g.height * s));
  const out = new Uint8Array(W * H);
  const fx = g.width / W;
  const fy = g.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * g.width;
        for (let xx = x0; xx < x1; xx++) sum += g.data[row + xx]!;
      }
      out[y * W + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * Divide out uneven lighting: estimate the paper brightness with a blockwise
 * high percentile, dilate (so markers and ink do not darken the estimate),
 * smooth, and return 255 * gray / background.
 */
export function normalizeIllumination(g: Gray): Gray {
  const { width: W, height: H } = g;
  const block = Math.max(8, Math.round(Math.max(W, H) / 100));
  const bw = Math.ceil(W / block);
  const bh = Math.ceil(H / block);
  const bg = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let count = 0;
      for (let y = by * block; y < Math.min(H, (by + 1) * block); y++)
        for (let x = bx * block; x < Math.min(W, (bx + 1) * block); x++) {
          hist[g.data[y * W + x]!]!++;
          count++;
        }
      // 90th percentile
      let acc = 0;
      let v = 255;
      for (let i = 0; i < 256; i++) {
        acc += hist[i]!;
        if (acc >= count * 0.9) {
          v = i;
          break;
        }
      }
      bg[by * bw + bx] = v;
    }
  const dil = maxFilter(bg, bw, bh, 3);
  const smooth = boxBlur(boxBlur(dil, bw, bh, 2), bw, bh, 2);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const b =
        (smooth[y0 * bw + x0]! * (1 - tx) + smooth[y0 * bw + x1]! * tx) * (1 - ty) + (smooth[y1 * bw + x0]! * (1 - tx) + smooth[y1 * bw + x1]! * tx) * ty;
      const v = (255 * g.data[y * W + x]!) / Math.max(24, b);
      out[y * W + x] = v > 255 ? 255 : Math.round(v);
    }
  }
  return { data: out, width: W, height: H };
}

function maxFilter(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, a[y * w + k]!);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]!);
      out[y * w + x] = m;
    }
  return out;
}

function boxBlur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        s += a[y * w + k]!;
        n++;
      }
      tmp[y * w + x] = s / n;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        s += tmp[k * w + x]!;
        n++;
      }
      out[y * w + x] = s / n;
    }
  return out;
}

// ------------------------------------------------------------------ components

export interface Component {
  label: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  /** second central moments */
  mxx: number;
  myy: number;
  mxy: number;
}

/** 8-connected labelling of pixels where `mask[i]` is non-zero. Returns labels (0 = background) and stats. */
export function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) {
      if (a < b) parent[b] = a;
      else parent[a] = b;
    }
  };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let l = 0;
      const nb = [x > 0 ? labels[i - 1]! : 0, y > 0 && x > 0 ? labels[i - w - 1]! : 0, y > 0 ? labels[i - w]! : 0, y > 0 && x < w - 1 ? labels[i - w + 1]! : 0];
      for (const n of nb) {
        if (!n) continue;
        if (!l) l = n;
        else if (n !== l) union(l, n);
      }
      if (!l) {
        l = next++;
        parent.push(l);
      }
      labels[i] = l;
    }
  }
  const remap = new Int32Array(next);
  const acc: { area: number; sx: number; sy: number; sxx: number; syy: number; sxy: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  let count = 0;
  for (let l = 1; l < next; l++) {
    const r = find(l);
    if (!remap[r]) {
      remap[r] = ++count;
      acc.push({ area: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    }
    remap[l] = remap[r]!;
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i]!;
      if (!l) continue;
      const m = remap[l]!;
      labels[i] = m;
      const a = acc[m - 1]!;
      a.area++;
      a.sx += x;
      a.sy += y;
      a.sxx += x * x;
      a.syy += y * y;
      a.sxy += x * y;
      if (x < a.x0) a.x0 = x;
      if (y < a.y0) a.y0 = y;
      if (x > a.x1) a.x1 = x;
      if (y > a.y1) a.y1 = y;
    }
  const comps = acc.map((a, k) => {
    const cx = a.sx / a.area;
    const cy = a.sy / a.area;
    return {
      label: k + 1,
      area: a.area,
      x0: a.x0,
      y0: a.y0,
      x1: a.x1,
      y1: a.y1,
      cx,
      cy,
      mxx: a.sxx / a.area - cx * cx,
      myy: a.syy / a.area - cy * cy,
      mxy: a.sxy / a.area - cx * cy,
    };
  });
  return { labels, comps };
}

// ------------------------------------------------------------------ homography

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Homography mapping src[i] -> dst[i] for four point pairs (DLT with Gaussian elimination). */
export function homography(src: Point[], dst: Point[]): Mat3 {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Solve 8x8 system A[:, :8] h = A[:, 8]
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    if (Math.abs(A[p]![c]!) < 1e-12) throw new Error('degenerate homography');
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k <= n; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  const h = A.map((row, i) => row[n]! / row[i]!);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

export function applyH(H: Mat3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Bilinear warp: output pixel (x, y) samples source at H * (x, y). */
export function warp(src: Gray, H: Mat3, W: number, Hh: number, fill = 255): Gray {
  const out = new Uint8Array(W * Hh);
  const sw = src.width;
  const sh = src.height;
  const d = src.data;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w = H[6] * px + H[7] * py + H[8];
      const sx = (H[0] * px + H[1] * py + H[2]) / w - 0.5;
      const sy = (H[3] * px + H[4] * py + H[5]) / w - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        out[y * W + x] = fill;
        continue;
      }
      const tx = sx - x0;
      const ty = sy - y0;
      const i = y0 * sw + x0;
      const v = (d[i]! * (1 - tx) + d[i + 1]! * tx) * (1 - ty) + (d[i + sw]! * (1 - tx) + d[i + sw + 1]! * tx) * ty;
      out[y * W + x] = Math.round(v);
    }
  }
  return { data: out, width: W, height: Hh };
}

// ------------------------------------------------------------------ markers

export interface MarkerCandidate {
  x: number;
  y: number;
  area: number;
}

export function findMarkerCandidates(norm: Gray): MarkerCandidate[] {
  const { width: W, height: H } = norm;
  const long = Math.max(W, H);
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = norm.data[i]! < 110 ? 1 : 0;
  const { comps } = labelComponents(mask, W, H);
  const minSide = Math.max(4, long * 0.0022);
  const maxSide = long * 0.06;
  const out: MarkerCandidate[] = [];
  for (const c of comps) {
    if (c.area < minSide * minSide || c.area > maxSide * maxSide) continue;
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    if (c.area / (bw * bh) < 0.45) continue;
    const tr = c.mxx + c.myy;
    const det = c.mxx * c.myy - c.mxy * c.mxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = tr / 2 - disc;
    if (l2 <= 0 || l1 / l2 > 3.2) continue;
    const norm2 = tr / c.area; // 1/6 for a solid square, 1/(2pi) for a disc
    if (norm2 < 0.13 || norm2 > 0.215) continue;
    out.push({ x: c.cx + 0.5, y: c.cy + 0.5, area: c.area });
  }
  return out;
}

function cross(o: Point, a: Point, b: Point) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function quadArea(q: Point[]) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!;
    const r = q[(i + 1) % q.length]!;
    a += p.x * r.y - r.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Order four points clockwise in image space starting top-left (by x+y). */
export function orderQuad(pts: Point[]): [Point, Point, Point, Point] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // atan2 with y down sorts clockwise visually; rotate so the first is top-left
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    if (p.x + p.y < best) {
      best = p.x + p.y;
      start = i;
    }
  });
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]!) as [Point, Point, Point, Point];
}

function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function pointInQuad(p: Point, q: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const s = Math.sign(cross(q[i]!, q[(i + 1) % q.length]!, p));
    if (s === 0) continue;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

interface QuadChoice {
  quad: [Point, Point, Point, Point];
  /** rotation whose QR corner holds the most finder-pattern candidates */
  rot: 0 | 1 | 2 | 3;
  /** number of QR finder patterns found where this page's QR should be (0-3) */
  evidence: number;
  area: number;
  markers: MarkerCandidate[];
  intruders: number;
}

/**
 * Rank every plausible quadrilateral of marker candidates. A quad is confirmed
 * by finding the QR code's finder patterns exactly where the template puts
 * them, which also yields the page rotation and rejects quads that mix the
 * corners of two different pages.
 */
export function rankMarkerQuads(cands: MarkerCandidate[], layout: PageLayout): QuadChoice[] {
  const m = layout.markers;
  const expectedAspect = (m[3].y - m[0].y) / (m[1].x - m[0].x);
  const dst = canonMarkers(layout);
  const S = CANON_PX_PER_PT;
  const qr = layout.qr;
  const pad = qr.size * 0.15;
  const inQr = (p: Point) => p.x >= (qr.x - pad) * S && p.x <= (qr.x + qr.size + pad) * S && p.y >= (qr.y - pad) * S && p.y <= (qr.y + qr.size + pad) * S;
  const top = cands.slice().sort((a, b) => b.area - a.area).slice(0, 24);
  const out: QuadChoice[] = [];
  const n = top.length;
  const len = (p: Point, r: Point) => Math.hypot(p.x - r.x, p.y - r.y);
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const set = [top[a]!, top[b]!, top[c]!, top[d]!];
          const areas = set.map((s) => s.area);
          if (Math.max(...areas) / Math.min(...areas) > 5) continue;
          const q = orderQuad(set);
          let sign = 0;
          let convex = true;
          for (let i = 0; i < 4; i++) {
            const s = Math.sign(cross(q[i]!, q[(i + 1) % 4]!, q[(i + 2) % 4]!));
            if (s === 0 || (sign && s !== sign)) {
              convex = false;
              break;
            }
            sign = s;
          }
          if (!convex) continue;
          const w = (len(q[0], q[1]) + len(q[3], q[2])) / 2;
          const h = (len(q[0], q[3]) + len(q[1], q[2])) / 2;
          const aspect = Math.max(w, h) / Math.min(w, h);
          if (aspect / expectedAspect > 1.6 || expectedAspect / aspect > 1.6) continue;
          const area = quadArea(q);
          const markerArea = areas.reduce((s2, x) => s2 + x, 0) / 4;
          if (area / markerArea < 60) continue;
          let bestRot: 0 | 1 | 2 | 3 = 0;
          let evidence = 0;
          for (let rot = 0; rot < 4; rot++) {
            const src = [0, 1, 2, 3].map((k) => q[(k + rot) % 4]!);
            let toCanon: Mat3;
            try {
              toCanon = homography(src, dst);
            } catch {
              continue;
            }
            let count = 0;
            for (const cand of cands) {
              if (set.includes(cand) || cand.area >= markerArea * 0.5) continue;
              if (inQr(applyH(toCanon, cand))) count++;
            }
            if (count > evidence) {
              evidence = count;
              bestRot = rot as 0 | 1 | 2 | 3;
            }
          }
          // Another page's corner marker inside this quad means it spans two pages.
          let intruders = 0;
          for (const cand of cands) if (!set.includes(cand) && cand.area >= markerArea * 0.5 && cand.area <= markerArea * 2 && pointInQuad(cand, q)) intruders++;
          out.push({ quad: q, rot: bestRot, evidence: Math.min(3, evidence), area, markers: set, intruders });
        }
  // Confirmed quads first, then quads without foreign markers inside, then the largest.
  return out.sort((x, y) => (y.evidence >= 2 ? 1 : 0) - (x.evidence >= 2 ? 1 : 0) || x.intruders - y.intruders || y.area - x.area);
}

/** Back-compat helper: the best single quad. */
export function chooseMarkerQuad(cands: MarkerCandidate[], expectedAspect: number): [Point, Point, Point, Point] | null {
  void expectedAspect;
  return rankMarkerQuads(cands, pageLayout('a4'))[0]?.quad ?? null;
}

// ------------------------------------------------------------------ page detection

export interface DetectedPage {
  rotation: 0 | 1 | 2 | 3;
  pageId: string | null;
  /** canonical normalised image of the page */
  canon: Gray;
  layout: PageLayout;
  corners: Point[];
  /** kept so the page can be re-warped for a different paper size */
  source: { norm: Gray; quad: Point[]; rot: number };
}

export type QrDecoder = (rgba: Uint8ClampedArray, width: number, height: number) => string | null;

function canonMarkers(layout: PageLayout): Point[] {
  return layout.markers.map((m) => ({ x: m.x * CANON_PX_PER_PT, y: m.y * CANON_PX_PER_PT }));
}

function grayToRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i]!;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export class DetectionError extends Error {
  constructor(
    message: string,
    public readonly code: 'no-markers' | 'no-qr' | 'paper',
  ) {
    super(message);
  }
}

function pageHomography(layout: PageLayout, quad: Point[], rot: number): Mat3 {
  return homography(canonMarkers(layout), [0, 1, 2, 3].map((k) => quad[(k + rot) % 4]!));
}

function readQr(gray: Gray, norm: Gray, H: Mat3, layout: PageLayout, decodeQr: QrDecoder): string | null {
  const q = layout.qr;
  const pad = 14;
  const qx = Math.round((q.x - pad) * CANON_PX_PER_PT);
  const qy = Math.round((q.y - pad) * CANON_PX_PER_PT);
  const qs = Math.round((q.size + pad * 2) * CANON_PX_PER_PT);
  const T: Mat3 = [H[0], H[1], H[0] * qx + H[1] * qy + H[2], H[3], H[4], H[3] * qx + H[4] * qy + H[5], H[6], H[7], H[6] * qx + H[7] * qy + H[8]];
  const text = decodeQr(grayToRgba(warp(gray, T, qs, qs)), qs, qs) ?? decodeQr(grayToRgba(warp(norm, T, qs, qs)), qs, qs);
  return text === null ? null : parseQrId(text);
}

function warpPage(norm: Gray, layout: PageLayout, H: Mat3): Gray {
  return warp(norm, H, Math.round(layout.width * CANON_PX_PER_PT), Math.round(layout.height * CANON_PX_PER_PT));
}

/** Re-warp a detected page for another paper size (when the sheet says it is A4 but was detected as Letter, say). */
export function rewarpForPaper(det: DetectedPage, paper: Paper): DetectedPage {
  if (det.layout.paper === paper) return det;
  const layout = pageLayout(paper);
  const H = pageHomography(layout, det.source.quad, det.source.rot);
  return { ...det, layout, canon: warpPage(det.source.norm, layout, H) };
}

/**
 * Find every template page in a photo or scan (several pages may share one
 * image, side by side or stacked). Pages whose QR code is unreadable are still
 * returned, with `pageId` null, so the person can say which page it is.
 */
export function detectPages(gray: Gray, decodeQr: QrDecoder, paperHint: Paper = 'a4'): DetectedPage[] {
  const norm = normalizeIllumination(gray);
  const cands = findMarkerCandidates(norm);
  const papers: Paper[] = paperHint === 'a4' ? ['a4', 'letter'] : ['letter', 'a4'];
  let best: DetectedPage[] = [];
  for (const paper of papers) {
    const layout = pageLayout(paper);
    const found: DetectedPage[] = [];
    let pool = cands.slice();
    for (let guard = 0; guard < 12; guard++) {
      const ranked = rankMarkerQuads(pool, layout);
      const pick = ranked.find((r) => r.evidence >= 2) ?? (found.length === 0 ? ranked.find((r) => r.intruders === 0) ?? ranked[0] : undefined);
      if (!pick) break;
      // Try the evidenced rotation first, then the others.
      const rots = [pick.rot, ...[0, 1, 2, 3].filter((r) => r !== pick.rot)];
      let page: DetectedPage | null = null;
      for (const rot of pick.evidence >= 2 ? rots.slice(0, 1) : rots) {
        const H = pageHomography(layout, pick.quad, rot);
        const id = readQr(gray, norm, H, layout, decodeQr);
        if (id || rot === rots[rots.length - 1] || pick.evidence >= 2) {
          page = { rotation: rot as 0 | 1 | 2 | 3, pageId: id, canon: warpPage(norm, layout, H), layout, corners: pick.quad, source: { norm, quad: pick.quad, rot } };
          if (id) break;
        }
      }
      if (!page) break;
      if (!page.pageId && pick.evidence < 2) {
        // Unconfirmed: use the most upright rotation.
        const rot = [0, 1, 2, 3].sort((a, b) => portraitScore(pageHomography(layout, pick.quad, b), layout) - portraitScore(pageHomography(layout, pick.quad, a), layout))[0]!;
        const H = pageHomography(layout, pick.quad, rot);
        page = { ...page, rotation: rot as 0 | 1 | 2 | 3, canon: warpPage(norm, layout, H), source: { norm, quad: pick.quad, rot } };
      }
      found.push(page);
      // Remove everything inside this page before looking for another one.
      const expanded = pick.quad;
      pool = pool.filter((c) => !pick.markers.includes(c) && !pointInQuad(c, expanded));
      if (pick.evidence < 2) break;
    }
    const score = (ps: DetectedPage[]) => ps.filter((p) => p.pageId).length * 10 + ps.length;
    if (score(found) > score(best)) best = found;
    if (best.length && best.every((p) => p.pageId)) break;
  }
  if (!best.length) throw new DetectionError('Could not find the four corner markers. Make sure all four black squares of each page are visible.', 'no-markers');
  return best;
}

/** Single-page convenience wrapper. */
export function detectPage(gray: Gray, decodeQr: QrDecoder, paperHint: Paper = 'a4'): DetectedPage {
  return detectPages(gray, decodeQr, paperHint)[0]!;
}

function portraitScore(H: Mat3, layout: PageLayout): number {
  // Map the canonical top edge and left edge; a correct rotation keeps image "up" roughly up.
  const a = applyH(H, { x: 0, y: 0 });
  const b = applyH(H, { x: layout.width * CANON_PX_PER_PT, y: 0 });
  const c = applyH(H, { x: 0, y: layout.height * CANON_PX_PER_PT });
  const topVec = { x: b.x - a.x, y: b.y - a.y };
  const downVec = { x: c.x - a.x, y: c.y - a.y };
  // Score by how much "down" points down and "right" points right.
  return downVec.y / Math.hypot(downVec.x, downVec.y) + topVec.x / Math.hypot(topVec.x, topVec.y);
}

function parseQrId(text: string): string | null {
  const PREFIX = 'jibun:1:';
  if (!text.startsWith(PREFIX)) return null;
  const id = text.slice(PREFIX.length);
  return /^[A-Za-z0-9_-]{6,40}$/.test(id) ? id : null;
}

// ------------------------------------------------------------------ cells

export interface GlyphBitmap {
  width: number;
  height: number;
  /** 1 = ink */
  data: Uint8Array;
  /** position of the bitmap's top-left within the cell box, in pixels */
  originX: number;
  originY: number;
  pxPerPt: number;
}

export interface CellResult {
  flags: SampleFlag[];
  confidence: number;
  bitmap: GlyphBitmap | null;
  /** registration offset applied (px) */
  offset: Point;
}

export const STRONG = 140;
export const WEAK = 188;

/** Find the small translation that best aligns the printed box border. */
export function registerCell(canon: Gray, box: { x: number; y: number; w: number; h: number }, radius: number): Point {
  const { width: W, height: H, data } = canon;
  const samples: [number, number][] = [];
  for (let x = Math.round(box.x); x <= Math.round(box.x + box.w); x++) {
    samples.push([x, Math.round(box.y)], [x, Math.round(box.y + box.h)]);
  }
  for (let y = Math.round(box.y); y <= Math.round(box.y + box.h); y++) {
    samples.push([Math.round(box.x), y], [Math.round(box.x + box.w), y]);
  }
  const scores: { dx: number; dy: number; s: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      let s = 0;
      for (const [x, y] of samples) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const v = data[yy * W + xx]!;
        // Only faint lines count: ignore real ink that could pull the box.
        s += v < STRONG ? 0 : 255 - v;
      }
      scores.push({ dx, dy, s: s / samples.length });
    }
  scores.sort((a, b) => b.s - a.s);
  const best = scores[0]!;
  const median = scores[Math.floor(scores.length / 2)]!.s;
  if (best.s - median < 6) return { x: 0, y: 0 };
  return { x: best.dx, y: best.dy };
}

export interface ExtractOptions {
  pxPerPt: number;
  isLetter: boolean;
  refine: boolean;
}

/**
 * Extract the glyph written in one cell. `box` is the writing box in pixels of `canon`.
 */
export function extractCell(canon: Gray, boxIn: { x: number; y: number; w: number; h: number }, opts: ExtractOptions): CellResult {
  const offset = opts.refine ? registerCell(canon, boxIn, Math.round(2.5 * opts.pxPerPt)) : { x: 0, y: 0 };
  const box = { x: boxIn.x + offset.x, y: boxIn.y + offset.y, w: boxIn.w, h: boxIn.h };
  const inset = opts.refine ? Math.ceil(1.3 * opts.pxPerPt) : 0;
  const cx0 = Math.max(0, Math.round(box.x + inset));
  const cy0 = Math.max(0, Math.round(box.y + inset));
  const cx1 = Math.min(canon.width, Math.round(box.x + box.w - inset));
  const cy1 = Math.min(canon.height, Math.round(box.y + box.h - inset));
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  if (w <= 4 || h <= 4) return { flags: ['empty'], confidence: 0, bitmap: null, offset };
  const weak = new Uint8Array(w * h);
  const strong = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = canon.data[(cy0 + y) * canon.width + cx0 + x]!;
      weak[y * w + x] = v < WEAK ? 1 : 0;
      strong[y * w + x] = v < STRONG ? 1 : 0;
    }
  const { labels, comps } = labelComponents(weak, w, h);
  const hasStrong = new Uint8Array(comps.length + 1);
  const darkSum = new Float64Array(comps.length + 1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (!l) continue;
    if (strong[i]) hasStrong[l] = 1;
    darkSum[l] = darkSum[l]! + canon.data[(cy0 + Math.floor(i / w)) * canon.width + cx0 + (i % w)]!;
  }
  const cellArea = w * h;
  const minArea = Math.max(4, Math.round(cellArea * 0.0004));
  const edgeTouch = (c: Component) => c.x0 <= 0 || c.y0 <= 0 || c.x1 >= w - 1 || c.y1 >= h - 1;
  let candidates = comps.filter((c) => hasStrong[c.label] && c.area >= minArea);
  // Remove remnants of printed lines: thin components touching the crop edge.
  candidates = candidates.filter((c) => {
    if (!edgeTouch(c)) return true;
    const long = Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1);
    const thickness = c.area / long;
    return !(thickness <= 2.5 && long >= 0.3 * Math.min(w, h));
  });
  if (!candidates.length) return { flags: ['empty'], confidence: 0, bitmap: null, offset };
  const largest = candidates.reduce((a, b) => (b.area > a.area ? b : a));
  const flags = new Set<SampleFlag>();
  const reach = 0.35 * h;
  const near = (c: Component) => c.x1 >= largest.x0 - reach && c.x0 <= largest.x1 + reach && c.y1 >= largest.y0 - reach && c.y0 <= largest.y1 + reach;
  const kept: Component[] = [];
  let droppedArea = 0;
  for (const c of candidates) {
    if (c === largest) {
      kept.push(c);
      continue;
    }
    if (c.area < Math.max(minArea, 0.012 * largest.area)) {
      droppedArea += c.area;
      continue;
    }
    if (!near(c) && c.area < 0.15 * largest.area) {
      droppedArea += c.area;
      flags.add('noise');
      continue;
    }
    kept.push(c);
  }
  const keptArea = kept.reduce((s, c) => s + c.area, 0);
  if (droppedArea > 0.1 * keptArea) flags.add('noise');
  if (kept.some(edgeTouch)) flags.add('edge');
  const meanInk = kept.reduce((s, c) => s + darkSum[c.label]!, 0) / keptArea;
  if (meanInk > 125) flags.add('faint');
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of kept) {
    x0 = Math.min(x0, c.x0);
    y0 = Math.min(y0, c.y0);
    x1 = Math.max(x1, c.x1);
    y1 = Math.max(y1, c.y1);
  }
  if (opts.isLetter && y1 - y0 + 1 < 0.08 * h && x1 - x0 + 1 < 0.08 * w) flags.add('tiny');
  const pad = 2;
  const bw = x1 - x0 + 1 + pad * 2;
  const bh = y1 - y0 + 1 + pad * 2;
  const keepSet = new Set(kept.map((c) => c.label));
  const data = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) if (keepSet.has(labels[y * w + x]!)) data[(y - y0 + pad) * bw + (x - x0 + pad)] = 1;
  let confidence = 1;
  if (flags.has('edge')) confidence -= 0.35;
  if (flags.has('noise')) confidence -= 0.25;
  if (flags.has('faint')) confidence -= 0.2;
  if (flags.has('tiny')) confidence -= 0.3;
  return {
    flags: [...flags],
    confidence: Math.max(0, Math.round(confidence * 100) / 100),
    bitmap: {
      width: bw,
      height: bh,
      data,
      originX: cx0 - box.x + x0 - pad,
      originY: cy0 - box.y + y0 - pad,
      pxPerPt: opts.pxPerPt,
    },
    offset,
  };
}

export function cellBoxPx(cell: CellRect, pxPerPt = CANON_PX_PER_PT) {
  return { x: cell.x * pxPerPt, y: cell.y * pxPerPt, w: cell.w * pxPerPt, h: cell.h * pxPerPt };
}

/**
 * Affine that maps potrace output for `bm` (coordinates ×10, y up from the bitmap
 * bottom) into cell font units.
 */
export function potraceToUnits(bm: GlyphBitmap): [number, number, number, number, number, number] {
  const upx = UNITS_PER_PT / bm.pxPerPt;
  return [upx / 10, 0, 0, upx / 10, bm.originX * upx, BOX_TOP_UNITS - (bm.originY + bm.height) * upx];
}

/** Encode a 1-bit bitmap as RGBA (black ink on white) for tracing or previews. */
export function bitmapToRgba(bm: GlyphBitmap, pad = 0): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const W = bm.width + pad * 2;
  const H = bm.height + pad * 2;
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < bm.height; y++)
    for (let x = 0; x < bm.width; x++)
      if (bm.data[y * bm.width + x]) {
        const i = ((y + pad) * W + x + pad) * 4;
        out[i] = out[i + 1] = out[i + 2] = 0;
      }
  return { data: out, width: W, height: H };
}
