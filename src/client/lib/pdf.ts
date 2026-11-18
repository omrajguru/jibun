/**
 * Template PDF generator. Runs in the browser so cell labels can be drawn with
 * the system's fonts for any script; labels are embedded as small images.
 */
import { PDFDocument, StandardFonts, rgb, type PDFImage, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { CELL_H, CELL_W, LABEL_H, MARKER, guidesFor, type CellRect, pageLayout, qrPayload, referenceCircle, unitsToBoxPt, UNITS_PER_PT, type GuideKind } from '../../shared/layout';
import type { PageRow } from '../../shared/types';
import { needsReference, keyKind } from '../../shared/unicode';

/** Drop-out blue: luminance ≈ 0.85, removed by the detector's threshold. Guides that cross
 * the writing area use this; only the box border (outside the crop) uses the stronger tint,
 * which the detector uses to register each cell. */
const DROPOUT = rgb(201 / 255, 220 / 255, 247 / 255);
const DROPOUT_STRONG = rgb(176 / 255, 203 / 255, 242 / 255);
const INK = rgb(0.04, 0.04, 0.04);
const GREY = rgb(0.45, 0.45, 0.45);

const GUIDE_WIDTH: Record<GuideKind, number> = { ascender: 0.35, cap: 0.35, x: 0.5, baseline: 0.7, descender: 0.35, headline: 0.7, frame: 0.4 };

function asciiSafe(s: string) {
  return s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').trim() || 'Untitled';
}

function labelText(key: string) {
  const k = keyKind(key).kind;
  if (k === 'mark' || k === 'rakar') return '◌' + key;
  if (k === 'spacing-mark') return '◌' + key;
  return key.replace('‍', '');
}

const LABEL_SCALE = 5; // px per pt for the label layer
const LABEL_FONT = '"Instrument Sans", "Noto Sans", "Noto Sans Devanagari", "Nirmala UI", "Mangal", "Yu Gothic", "Hiragino Sans", "Meiryo", system-ui, sans-serif';

/**
 * Render every cell label of a page into one image (a single PNG encode per
 * page, so even thousands of characters stay fast). Labels use the system's
 * fonts, so any script prints correctly.
 */
async function renderLabelLayer(keys: string[], cells: CellRect[], width: number, height: number): Promise<Uint8Array> {
  const S = LABEL_SCALE;
  const canvas = new OffscreenCanvas(Math.ceil(width * S), Math.ceil(height * S));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'middle';
  keys.forEach((key, i) => {
    const cell = cells[i]!;
    const text = labelText(key);
    let size = 8.5 * S;
    ctx.font = `${size}px ${LABEL_FONT}`;
    while (ctx.measureText(text).width > (CELL_W - 4) * S && size > 4 * S) {
      size -= S / 2;
      ctx.font = `${size}px ${LABEL_FONT}`;
    }
    ctx.fillText(text, (cell.x + 1.5) * S, (cell.labelY + LABEL_H / 2 + 0.3) * S);
  });
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function drawQr(page: PDFPage, text: string, x: number, yTop: number, size: number, pageH: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const m = size / n;
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < n && qr.modules.get(r, c + run)) run++;
      page.drawRectangle({ x: x + c * m, y: pageH - (yTop + (r + 1) * m), width: run * m + 0.05, height: m + 0.05, color: INK });
      c += run;
    }
  }
}

export async function generateTemplatePdf(pages: PageRow[], opts: { fontName: string; rewrite?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Jibun template – ${asciiSafe(opts.fontName)}`);
  doc.setCreator('Jibun');
  doc.setProducer('Jibun');
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  // Make sure the UI font is ready before drawing labels with it.
  await document.fonts.ready.catch(() => undefined);

  for (const pg of pages) {
    const L = pageLayout(pg.paper);
    const page = doc.addPage([L.width, L.height]);
    const H = L.height;
    const top = (y: number, h = 0) => H - y - h;
    // Label layer first, everything else on top of it.
    const labels: PDFImage = await doc.embedPng(await renderLabelLayer(pg.cells, L.cells, L.width, L.height));
    page.drawImage(labels, { x: 0, y: 0, width: L.width, height: L.height });

    for (const m of L.markers) page.drawRectangle({ x: m.x - MARKER / 2, y: top(m.y - MARKER / 2, MARKER), width: MARKER, height: MARKER, color: INK });
    drawQr(page, qrPayload(pg.id), L.qr.x, L.qr.y, L.qr.size, H);

    const titleX = L.markers[0].x + MARKER / 2 + 12;
    page.drawText('Jibun', { x: titleX, y: top(40), size: 15, font: helvB, color: INK });
    page.drawText(`${asciiSafe(opts.fontName)}  ·  ${opts.rewrite ? 'Rewrite sheet' : 'Template'}  ·  Page ${pg.pageNumber} of ${pg.pageCount}`, { x: titleX, y: top(56), size: 9, font: helv, color: GREY });
    page.drawText('Write each character inside its box, sitting on the bold line. Use a dark pen. Keep all four corner squares in view.', {
      x: titleX,
      y: top(72),
      size: 7.5,
      font: helv,
      color: GREY,
      maxWidth: L.qr.x - titleX - 12,
    });

    for (let i = 0; i < pg.cells.length; i++) {
      const key = pg.cells[i]!;
      const cell = L.cells[i]!;
      page.drawRectangle({ x: cell.x, y: top(cell.y, CELL_H), width: CELL_W, height: CELL_H, borderColor: DROPOUT_STRONG, borderWidth: 0.6 });
      for (const g of guidesFor(key)) {
        const y = top(cell.y + unitsToBoxPt(g.y));
        page.drawLine({ start: { x: cell.x + 1.5, y }, end: { x: cell.x + CELL_W - 1.5, y }, thickness: GUIDE_WIDTH[g.kind], color: DROPOUT, dashArray: g.kind === 'ascender' || g.kind === 'descender' ? [1.5, 1.5] : undefined });
      }
      if (needsReference(key)) {
        const ref = referenceCircle(key);
        page.drawCircle({
          x: cell.x + ref.cx / UNITS_PER_PT,
          y: top(cell.y + unitsToBoxPt(ref.cy)),
          size: ref.r / UNITS_PER_PT,
          borderColor: DROPOUT,
          borderWidth: 0.7,
          borderDashArray: [1.6, 1.6],
        });
      }
    }
  }
  return doc.save({ useObjectStreams: true });
}

export function downloadBytes(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
