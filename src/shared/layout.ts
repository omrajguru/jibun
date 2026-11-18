/**
 * Template geometry shared by the PDF generator, the scan detector and the
 * on-screen writing canvas. All page measurements are in PDF points (1/72 in),
 * origin at the top-left corner of the page, y growing downwards.
 *
 * Inside a cell box the font coordinate system is fixed: the box spans
 * BOX_TOP_UNITS (top) to BOX_BOTTOM_UNITS (bottom) vertically and 0..BOX_W_UNITS
 * horizontally, so every input route yields glyphs in the same units.
 */
import { scriptOfKey, needsReference } from './unicode';

export type Paper = 'a4' | 'letter';

export const PAPER_SIZES: Record<Paper, { w: number; h: number; label: string }> = {
  a4: { w: 595.28, h: 841.89, label: 'A4' },
  letter: { w: 612, h: 792, label: 'US Letter' },
};

export const MARGIN = 28;
export const MARKER = 22;
export const QR_SIZE = 50;
export const HEADER_H = 62;

export const CELL_W = 44;
export const CELL_H = 50;
export const LABEL_H = 11;
export const GAP_X = 4;
export const ROW_GAP = 5;

export const UNITS_PER_EM = 1000;
export const BOX_TOP_UNITS = 950;
export const BOX_BOTTOM_UNITS = -300;
export const UNITS_PER_PT = (BOX_TOP_UNITS - BOX_BOTTOM_UNITS) / CELL_H; // 25
export const BOX_W_UNITS = CELL_W * UNITS_PER_PT; // 1100

/** Canonical raster resolution used after perspective correction. */
export const CANON_PX_PER_PT = 3;

export const METRICS = {
  ascender: 800,
  capHeight: 700,
  xHeight: 500,
  baseline: 0,
  descender: -250,
  devanagariHeadline: 620,
  kanaTop: 820,
  kanaBottom: -120,
} as const;

/** Dotted-circle reference for marks, in font units within the box. */
export function referenceCircle(key: string) {
  const deva = scriptOfKey(key) === 'devanagari';
  const top = deva ? METRICS.devanagariHeadline : METRICS.xHeight;
  const r = top / 2;
  const cx = BOX_W_UNITS / 2;
  return { cx, cy: r, r, left: cx - r, right: cx + r, top, bottom: 0 };
}

export type GuideKind = 'ascender' | 'cap' | 'x' | 'baseline' | 'descender' | 'headline' | 'frame';

export function guidesFor(key: string): { kind: GuideKind; y: number }[] {
  const s = scriptOfKey(key);
  if (s === 'devanagari')
    return [
      { kind: 'headline', y: METRICS.devanagariHeadline },
      { kind: 'baseline', y: 0 },
      { kind: 'descender', y: METRICS.descender },
    ];
  if (s === 'kana')
    return [
      { kind: 'frame', y: METRICS.kanaTop },
      { kind: 'baseline', y: 0 },
      { kind: 'frame', y: METRICS.kanaBottom },
    ];
  return [
    { kind: 'ascender', y: METRICS.ascender },
    { kind: 'cap', y: METRICS.capHeight },
    { kind: 'x', y: METRICS.xHeight },
    { kind: 'baseline', y: 0 },
    { kind: 'descender', y: METRICS.descender },
  ];
}

export function unitsToBoxPt(yUnits: number) {
  return (BOX_TOP_UNITS - yUnits) / UNITS_PER_PT;
}

export interface CellRect {
  index: number;
  /** box (writing area) in points */
  x: number;
  y: number;
  w: number;
  h: number;
  /** label strip above the box */
  labelY: number;
}

export interface PageLayout {
  paper: Paper;
  width: number;
  height: number;
  cols: number;
  rows: number;
  cells: CellRect[];
  /** centres of the four corner markers: TL, TR, BR, BL */
  markers: [Pt, Pt, Pt, Pt];
  qr: { x: number; y: number; size: number };
}
interface Pt {
  x: number;
  y: number;
}

export function pageLayout(paper: Paper): PageLayout {
  const { w, h } = PAPER_SIZES[paper];
  const gridLeft = MARGIN;
  const gridRight = w - MARGIN;
  const gridTop = MARGIN + HEADER_H;
  const gridBottom = h - MARGIN - MARKER - 8;
  const cols = Math.floor((gridRight - gridLeft + GAP_X) / (CELL_W + GAP_X));
  const rowH = LABEL_H + CELL_H + ROW_GAP;
  const rows = Math.floor((gridBottom - gridTop + ROW_GAP) / rowH);
  const usedW = cols * CELL_W + (cols - 1) * GAP_X;
  const x0 = gridLeft + (gridRight - gridLeft - usedW) / 2;
  const cells: CellRect[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const labelY = gridTop + r * rowH;
      cells.push({ index: r * cols + c, x: x0 + c * (CELL_W + GAP_X), y: labelY + LABEL_H, w: CELL_W, h: CELL_H, labelY });
    }
  const m = MARGIN + MARKER / 2;
  return {
    paper,
    width: w,
    height: h,
    cols,
    rows,
    cells,
    markers: [
      { x: m, y: m },
      { x: w - m, y: m },
      { x: w - m, y: h - m },
      { x: m, y: h - m },
    ],
    qr: { x: w - MARGIN - MARKER - 10 - QR_SIZE, y: MARGIN - 2, size: QR_SIZE },
  };
}

export function cellsPerPage(paper: Paper) {
  return pageLayout(paper).cells.length;
}

/** Split keys (with repeats for multiple samples) into pages. */
export function paginate(keys: string[], samplesPerChar: number, paper: Paper): string[][] {
  const per = cellsPerPage(paper);
  const seq: string[] = [];
  for (const k of keys) for (let i = 0; i < samplesPerChar; i++) seq.push(k);
  // Spread cells evenly so the last page is never a near-empty straggler,
  // without ever splitting the samples of one character across pages.
  const whole = Math.max(samplesPerChar, Math.floor(per / samplesPerChar) * samplesPerChar);
  const pageCount = Math.max(1, Math.ceil(seq.length / whole));
  const target = Math.min(whole, Math.ceil(seq.length / pageCount / samplesPerChar) * samplesPerChar);
  const pages: string[][] = [];
  for (let i = 0; i < seq.length; i += target) pages.push(seq.slice(i, i + target));
  return pages;
}

export const QR_PREFIX = 'jibun:1:';
export function qrPayload(pageId: string) {
  return QR_PREFIX + pageId;
}
export function parseQrPayload(s: string): string | null {
  if (!s.startsWith(QR_PREFIX)) return null;
  const id = s.slice(QR_PREFIX.length);
  return /^[A-Za-z0-9_-]{6,40}$/.test(id) ? id : null;
}

export { needsReference };
