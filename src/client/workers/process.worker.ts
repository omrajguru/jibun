/// <reference lib="webworker" />
/**
 * Off-main-thread scan processing: detection, perspective correction, cell
 * extraction and Potrace (WASM) tracing. Scans never leave the device; only
 * trimmed glyph bitmaps and outlines are returned.
 */
import jsQR from 'jsqr';
import { init as potraceInit, potrace } from 'esm-potrace-wasm';
import { outlineToSvgPath, parseSvgPath, transformOutline } from '../../shared/font/path';
import { CANON_PX_PER_PT, type Paper } from '../../shared/layout';
import { bitmapToRgba, cellBoxPx, detectPages, downscale, rewarpForPaper, extractCell, potraceToUnits, rgbaToGray, type DetectedPage, type GlyphBitmap } from '../../shared/imaging';
import type { SampleUpload } from '../../shared/types';
import { keyKind } from '../../shared/unicode';

declare const self: DedicatedWorkerGlobalScope;

// Phone photos are reduced to about 6 MP; tall or wide images with several pages keep more length.
const MAX_SIDE = 4800;
const MAX_PIXELS = 6_000_000;
const pages = new Map<string, DetectedPage>();
let ready: Promise<void> | null = null;
const ensurePotrace = () => (ready ??= potraceInit());

const decodeQr = (rgba: Uint8ClampedArray, w: number, h: number) => jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;

export type ProcessRequest =
  | { type: 'detect'; id: string; image: ImageBitmap; paper: Paper }
  | { type: 'extract'; id: string; cells: string[]; paper: Paper }
  | { type: 'release'; id: string }
  | { type: 'screen'; id: string; key: string; rgba: Uint8ClampedArray; width: number; height: number; pxPerPt: number };

export type ProcessResponse =
  | { type: 'detected'; id: string; pages: { handle: string; pageId: string | null; preview: ImageBitmap }[] }
  | { type: 'progress'; id: string; done: number; total: number }
  | { type: 'extracted'; id: string; samples: SampleUpload[]; flagged: number; empty: number }
  | { type: 'screen-result'; id: string; sample: SampleUpload | null; flags: string[] }
  | { type: 'error'; id: string; message: string; code?: string };

async function tracePath(bm: GlyphBitmap): Promise<string> {
  await ensurePotrace();
  const img = bitmapToRgba(bm);
  const paths = await potrace({ data: img.data, width: img.width, height: img.height } as unknown as ImageBitmapSource, {
    turdsize: 3,
    turnpolicy: 4,
    alphamax: 1,
    opticurve: 1,
    opttolerance: 0.2,
    pathonly: true,
    extractcolors: false,
    posterizelevel: 2,
    posterizationalgorithm: 0,
  });
  const outline = paths.flatMap((d) => parseSvgPath(d));
  return outlineToSvgPath(transformOutline(outline, potraceToUnits(bm)), 1);
}

async function pngBase64(bm: GlyphBitmap): Promise<string> {
  const img = bitmapToRgba(bm);
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const isLetter = (key: string) => /^\p{L}$/u.test(key);

function post(msg: ProcessResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

self.onmessage = async (ev: MessageEvent<ProcessRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'detect') {
      const { image } = msg;
      const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height), Math.sqrt(MAX_PIXELS / (image.width * image.height)));
      const w = Math.max(1, Math.round(image.width * scale));
      const h = Math.max(1, Math.round(image.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, w, h);
      image.close();
      const gray = downscale(rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h), MAX_SIDE, MAX_PIXELS);
      const found = detectPages(gray, decodeQr, msg.paper);
      const out: { handle: string; pageId: string | null; preview: ImageBitmap }[] = [];
      for (let k = 0; k < found.length; k++) {
        const det = found[k]!;
        const handle = `${msg.id}#${k}`;
        pages.set(handle, det);
        // Small preview of the corrected page.
        const small = downscale(det.canon, 360);
        const rgba = new Uint8ClampedArray(small.width * small.height * 4);
        for (let i = 0; i < small.data.length; i++) {
          rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = small.data[i]!;
          rgba[i * 4 + 3] = 255;
        }
        out.push({ handle, pageId: det.pageId, preview: await createImageBitmap(new ImageData(rgba, small.width, small.height)) });
      }
      post({ type: 'detected', id: msg.id, pages: out }, out.map((p) => p.preview));
      return;
    }
    if (msg.type === 'extract') {
      const found = pages.get(msg.id);
      if (!found) throw new Error('Page is no longer in memory; please add the photo again.');
      // The sheet's real paper size wins over the guess made during detection.
      const det = rewarpForPaper(found, msg.paper);
      const samples: SampleUpload[] = [];
      let flagged = 0;
      let empty = 0;
      const total = Math.min(msg.cells.length, det.layout.cells.length);
      for (let i = 0; i < total; i++) {
        const key = msg.cells[i]!;
        const cell = det.layout.cells[i]!;
        const res = extractCell(det.canon, cellBoxPx(cell, CANON_PX_PER_PT), { pxPerPt: CANON_PX_PER_PT, isLetter: isLetter(key) && keyKind(key).kind === 'char', refine: true });
        if (!res.bitmap) {
          empty++;
        } else {
          const path = await tracePath(res.bitmap);
          if (!path) empty++;
          else {
            if (res.flags.length) flagged++;
            samples.push({ key, cellIndex: i, path, flags: res.flags, confidence: res.confidence, bitmap: await pngBase64(res.bitmap), source: 'scan' });
          }
        }
        if (i % 8 === 7 || i === total - 1) post({ type: 'progress', id: msg.id, done: i + 1, total });
      }
      post({ type: 'extracted', id: msg.id, samples, flagged, empty });
      return;
    }
    if (msg.type === 'release') {
      pages.delete(msg.id);
      return;
    }
    if (msg.type === 'screen') {
      const gray = rgbaToGray(msg.rgba, msg.width, msg.height);
      const res = extractCell(gray, { x: 0, y: 0, w: msg.width, h: msg.height }, { pxPerPt: msg.pxPerPt, isLetter: false, refine: false });
      if (!res.bitmap) {
        post({ type: 'screen-result', id: msg.id, sample: null, flags: res.flags });
        return;
      }
      const path = await tracePath(res.bitmap);
      const flags = res.flags.filter((f) => f !== 'faint');
      post({
        type: 'screen-result',
        id: msg.id,
        sample: path ? { key: msg.key, cellIndex: null, path, flags: flags.filter((f) => f === 'edge'), confidence: res.confidence, bitmap: await pngBase64(res.bitmap), source: 'screen' } : null,
        flags,
      });
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    post({ type: 'error', id: msg.id, message: err.message ?? String(e), code: err.code });
  }
};
