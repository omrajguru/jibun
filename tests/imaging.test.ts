import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { CANON_PX_PER_PT, pageLayout, qrPayload, type Paper } from '../src/shared/layout';
import { cellBoxPx, detectPage, extractCell, homography, type Gray, type Mat3, type Point } from '../src/shared/imaging';

const decode = (rgba: Uint8ClampedArray, w: number, h: number) => jsQR(rgba, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;

interface Truth {
  index: number;
  /** ink bbox in pt relative to box top-left, or null for an empty cell */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  dot: boolean;
}

/** Paint a template page with synthetic handwriting at `S` px per pt. */
function paintPage(paper: Paper, pageId: string, S: number, seed: number) {
  const L = pageLayout(paper);
  const W = Math.round(L.width * S);
  const H = Math.round(L.height * S);
  const img = new Uint8Array(W * H).fill(245);
  const fillRect = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = Math.max(0, Math.round(y0 * S)); y < Math.min(H, Math.round(y1 * S)); y++)
      for (let x = Math.max(0, Math.round(x0 * S)); x < Math.min(W, Math.round(x1 * S)); x++) img[y * W + x] = Math.min(img[y * W + x]!, v);
  };
  const disc = (cx: number, cy: number, r: number, v: number) => {
    for (let y = Math.round((cy - r) * S); y <= Math.round((cy + r) * S); y++)
      for (let x = Math.round((cx - r) * S); x <= Math.round((cx + r) * S); x++)
        if ((x / S - cx) ** 2 + (y / S - cy) ** 2 <= r * r && x >= 0 && y >= 0 && x < W && y < H) img[y * W + x] = Math.min(img[y * W + x]!, v);
  };
  for (const m of L.markers) fillRect(m.x - 11, m.y - 11, m.x + 11, m.y + 11, 15);
  const qr = QRCode.create(qrPayload(pageId), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const mod = L.qr.size / n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) fillRect(L.qr.x + c * mod, L.qr.y + r * mod, L.qr.x + (c + 1) * mod, L.qr.y + (r + 1) * mod, 15);
  // dropout guides and borders (light blue => luminance ~ 0.86)
  const GUIDE = 212;
  const truths: Truth[] = [];
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const cell of L.cells) {
    fillRect(cell.x, cell.y, cell.x + cell.w, cell.y + 0.5, GUIDE);
    fillRect(cell.x, cell.y + cell.h - 0.5, cell.x + cell.w, cell.y + cell.h, GUIDE);
    fillRect(cell.x, cell.y, cell.x + 0.5, cell.y + cell.h, GUIDE);
    fillRect(cell.x + cell.w - 0.5, cell.y, cell.x + cell.w, cell.y + cell.h, GUIDE);
    for (const gy of [6, 10, 18, 38, 48]) fillRect(cell.x + 2, cell.y + gy, cell.x + cell.w - 2, cell.y + gy + 0.4, GUIDE);
    // ~8% of cells left empty
    if (rand() < 0.08) {
      truths.push({ index: cell.index, bbox: null, dot: false });
      continue;
    }
    // a stroke: vertical stem with a bowl, random size and position within the box
    const sx = 6 + rand() * 8;
    const top = 10 + rand() * 8;
    const bottom = 38;
    const stroke = 1.6 + rand() * 1;
    const ink = 25 + Math.round(rand() * 50);
    fillRect(cell.x + sx, cell.y + top, cell.x + sx + stroke, cell.y + bottom, ink);
    const bowlR = 5 + rand() * 4;
    const bcx = sx + stroke + bowlR;
    const bcy = bottom - bowlR;
    for (let a = 0; a < Math.PI * 2; a += 0.02) disc(cell.x + bcx + Math.cos(a) * bowlR, cell.y + bcy + Math.sin(a) * bowlR, stroke / 2, ink);
    const dot = rand() < 0.3;
    if (dot) disc(cell.x + sx + 1, cell.y + top - 5, 1.6, ink);
    truths.push({
      index: cell.index,
      bbox: { x0: sx, y0: dot ? top - 6.6 : top, x1: bcx + bowlR + stroke / 2, y1: bottom + stroke / 2 },
      dot,
    });
  }
  return { img: { data: img, width: W, height: H } as Gray, truths, layout: L };
}

/** Photograph the page: perspective, uneven light, blur and noise. */
function photograph(page: Gray, corners: Point[], outW: number, outH: number, opts: { light: number; noise: number }) {
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: page.width, y: 0 },
    { x: page.width, y: page.height },
    { x: 0, y: page.height },
  ];
  const Hm: Mat3 = homography(corners, src); // photo -> page
  const out = new Uint8ClampedArray(outW * outH * 4);
  let rnd = 7;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let y = 0; y < outH; y++)
    for (let x = 0; x < outW; x++) {
      const w = Hm[6] * x + Hm[7] * y + Hm[8];
      const px = (Hm[0] * x + Hm[1] * y + Hm[2]) / w;
      const py = (Hm[3] * x + Hm[4] * y + Hm[5]) / w;
      let v = 90; // table
      if (px >= 0 && py >= 0 && px < page.width - 1 && py < page.height - 1) {
        // 2x2 box blur through bilinear sampling
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const tx = px - x0;
        const ty = py - y0;
        const d = page.data;
        const i = y0 * page.width + x0;
        v = (d[i]! * (1 - tx) + d[i + 1]! * tx) * (1 - ty) + (d[i + page.width]! * (1 - tx) + d[i + page.width + 1]! * tx) * ty;
      }
      const shade = 1 - opts.light * (x / outW) * 0.6 - opts.light * (y / outH) * 0.4;
      v = v * shade + (rand() - 0.5) * opts.noise;
      const j = (y * outW + x) * 4;
      out[j] = out[j + 1] = out[j + 2] = Math.max(0, Math.min(255, v));
      out[j + 3] = 255;
    }
  return out;
}

function toGray(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const d = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = rgba[i * 4]!;
  return { data: d, width: w, height: h };
}

function evaluate(paper: Paper, corners: Point[], outW: number, outH: number, opts: { light: number; noise: number }, rotate180 = false) {
  const pageId = 'pg_TEST1234';
  const { img, truths, layout } = paintPage(paper, pageId, 4, 42);
  let photo = photograph(img, corners, outW, outH, opts);
  if (rotate180) {
    const r = new Uint8ClampedArray(photo.length);
    const n = outW * outH;
    for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) r[(n - 1 - i) * 4 + c] = photo[i * 4 + c]!;
    photo = r;
  }
  const det = detectPage(toGray(photo, outW, outH), decode, paper);
  expect(det.pageId).toBe(pageId);
  let correct = 0;
  let detail: string[] = [];
  for (const t of truths) {
    const cell = layout.cells[t.index]!;
    const res = extractCell(det.canon, cellBoxPx(cell), { pxPerPt: CANON_PX_PER_PT, isLetter: true, refine: true });
    if (!t.bbox) {
      if (!res.bitmap) correct++;
      else detail.push(`cell ${t.index}: expected empty`);
      continue;
    }
    if (!res.bitmap || res.flags.includes('edge')) {
      detail.push(`cell ${t.index}: ${res.flags.join(',')}`);
      continue;
    }
    const bm = res.bitmap;
    const S = CANON_PX_PER_PT;
    const got = { x0: (bm.originX + 2) / S, y0: (bm.originY + 2) / S, x1: (bm.originX + bm.width - 2) / S, y1: (bm.originY + bm.height - 2) / S };
    const tol = 1.4; // pt
    const ok = Math.abs(got.x0 - t.bbox.x0) < tol && Math.abs(got.y0 - t.bbox.y0) < tol && Math.abs(got.x1 - t.bbox.x1) < tol && Math.abs(got.y1 - t.bbox.y1) < tol;
    if (ok) correct++;
    else detail.push(`cell ${t.index}: bbox ${JSON.stringify(got)} vs ${JSON.stringify(t.bbox)}`);
  }
  const acc = correct / truths.length;
  return { acc, detail: detail.slice(0, 8), rotation: det.rotation };
}

describe('scan detection and extraction', () => {
  it('extracts ≥ 98% of cells from a clean flat scan', () => {
    const W = 1700;
    const H = 2400;
    const r = evaluate('a4', [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], W, H, { light: 0, noise: 4 });
    expect(r.detail).toEqual([]);
    expect(r.acc).toBeGreaterThanOrEqual(0.98);
  });

  it('extracts ≥ 95% of cells from a tilted, unevenly lit phone photo', () => {
    const r = evaluate('a4', [{ x: 260, y: 180 }, { x: 1720, y: 120 }, { x: 1880, y: 2330 }, { x: 140, y: 2420 }], 2000, 2500, { light: 0.45, noise: 18 });
    expect(r.acc, r.detail.join('\n')).toBeGreaterThanOrEqual(0.95);
  });

  it('handles a page photographed upside down on US Letter', () => {
    const r = evaluate('letter', [{ x: 150, y: 150 }, { x: 1800, y: 190 }, { x: 1760, y: 2300 }, { x: 120, y: 2280 }], 1950, 2450, { light: 0.2, noise: 10 }, true);
    expect(r.rotation).not.toBe(0);
    expect(r.acc, r.detail.join('\n')).toBeGreaterThanOrEqual(0.95);
  });
});

import { paginate, cellsPerPage } from '../src/shared/layout';
describe('pagination', () => {
  it('balances pages and never exceeds capacity', () => {
    const keys = Array.from({ length: 100 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const p = paginate(keys, 1, 'letter');
    expect(p.map((x) => x.length)).toEqual([50, 50]);
    for (const per of [1, 2, 3]) for (const n of [1, 37, 99, 100, 250, 999]) {
      const pages = paginate(keys.concat(Array.from({ length: n }, (_, i) => String.fromCodePoint(0x5000 + i))).slice(0, n), per, 'a4');
      expect(pages.flat().length).toBe(n * per);
      expect(Math.max(...pages.map((x) => x.length))).toBeLessThanOrEqual(cellsPerPage('a4'));
      expect(pages.length).toBe(Math.ceil((n * per) / (Math.floor(cellsPerPage('a4') / per) * per)));
      for (const pg of pages) expect(pg.length % per).toBe(0);
    }
  });
});

import { detectPages, rewarpForPaper } from '../src/shared/imaging';
describe('multi-page images', () => {
  it('finds two pages stacked in one image, each with its own QR code', () => {
    const a = paintPage('letter', 'pg_STACKAAAA1', 2, 7);
    const b = paintPage('letter', 'pg_STACKBBBB2', 2, 9);
    const W = a.img.width;
    const gap = 40;
    const H = a.img.height + gap + b.img.height;
    const data = new Uint8Array(W * H).fill(245);
    data.set(a.img.data, 0);
    data.set(b.img.data, (a.img.height + gap) * W);
    const pages = detectPages({ data, width: W, height: H }, decode, 'letter');
    expect(pages.map((p) => p.pageId).sort()).toEqual(['pg_STACKAAAA1', 'pg_STACKBBBB2']);
    for (const p of pages) {
      const truths = (p.pageId === 'pg_STACKAAAA1' ? a : b).truths;
      let ok = 0;
      for (const t of truths) {
        const r = extractCell(p.canon, cellBoxPx(p.layout.cells[t.index]!), { pxPerPt: CANON_PX_PER_PT, isLetter: true, refine: true });
        if (!!r.bitmap === !!t.bbox) ok++;
      }
      expect(ok / truths.length).toBeGreaterThanOrEqual(0.98);
    }
  });

  it('re-warps a page when its real paper size differs from the guess', () => {
    const a = paintPage('a4', 'pg_PAPERA4XX1', 2, 3);
    const det = detectPages(a.img, decode, 'letter')[0]!;
    const fixed = rewarpForPaper(det, 'a4');
    expect(fixed.layout.paper).toBe('a4');
    let ok = 0;
    for (const t of a.truths) {
      const r = extractCell(fixed.canon, cellBoxPx(fixed.layout.cells[t.index]!), { pxPerPt: CANON_PX_PER_PT, isLetter: true, refine: true });
      if (!!r.bitmap === !!t.bbox) ok++;
    }
    expect(ok / a.truths.length).toBeGreaterThanOrEqual(0.98);
  });
});
