import type { Paper } from '../../shared/layout';
import type { BuildInput, ExportFormat, SampleUpload } from '../../shared/types';
import type { BuildReport } from '../../shared/font/build';
import type { ProcessRequest, ProcessResponse } from '../workers/process.worker';

let proc: Worker | null = null;
const waiters = new Map<string, (m: ProcessResponse) => void>();

function processor() {
  if (!proc) {
    proc = new Worker(new URL('../workers/process.worker.ts', import.meta.url), { type: 'module' });
    proc.onmessage = (e: MessageEvent<ProcessResponse>) => waiters.get(e.data.id)?.(e.data);
    proc.onerror = (e) => {
      for (const [id, w] of waiters) w({ type: 'error', id, message: e.message || 'The image processor stopped unexpectedly.' });
      proc?.terminate();
      proc = null;
    };
  }
  return proc;
}

function call(req: ProcessRequest, transfer: Transferable[], onProgress?: (done: number, total: number) => void): Promise<ProcessResponse> {
  return new Promise((resolve, reject) => {
    const handler = (m: ProcessResponse) => {
      if (m.type === 'progress') return onProgress?.(m.done, m.total);
      waiters.delete(req.id);
      if (m.type === 'error') reject(Object.assign(new Error(m.message), { code: m.code }));
      else resolve(m);
    };
    waiters.set(req.id, handler);
    processor().postMessage(req, transfer);
  });
}

let seq = 0;
const nextId = () => `j${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Prepare an image (respecting EXIF orientation) and find every template page in it. */
export async function detect(file: Blob, paper: Paper) {
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const id = nextId();
  const res = (await call({ type: 'detect', id, image, paper }, [image])) as Extract<ProcessResponse, { type: 'detected' }>;
  return res.pages;
}

export async function extract(handle: string, cells: string[], paper: Paper, onProgress?: (d: number, t: number) => void) {
  const res = (await call({ type: 'extract', id: handle, cells, paper }, [], onProgress)) as Extract<ProcessResponse, { type: 'extracted' }>;
  processor().postMessage({ type: 'release', id: handle } satisfies ProcessRequest);
  return res;
}

export function release(handle: string) {
  processor().postMessage({ type: 'release', id: handle } satisfies ProcessRequest);
}

export async function processScreenCell(key: string, img: ImageData, pxPerPt: number): Promise<{ sample: SampleUpload | null; flags: string[] }> {
  const id = nextId();
  const res = (await call({ type: 'screen', id, key, rgba: img.data, width: img.width, height: img.height, pxPerPt }, [img.data.buffer])) as Extract<ProcessResponse, { type: 'screen-result' }>;
  return { sample: res.sample, flags: res.flags };
}

// ---------------------------------------------------------------- preview fonts

let prev: Worker | null = null;
let prevSeq = 0;
type Built = { files?: Partial<Record<ExportFormat, Uint8Array>>; ttf?: Uint8Array; report?: BuildReport; error?: string };
const prevWaiters = new Map<number, (d: Built) => void>();

function fontWorker(input: BuildInput, formats: ExportFormat[]): Promise<Built> {
  if (!prev) {
    prev = new Worker(new URL('../workers/preview.worker.ts', import.meta.url), { type: 'module' });
    prev.onmessage = (e) => {
      prevWaiters.get(e.data.id)?.(e.data);
      prevWaiters.delete(e.data.id);
    };
  }
  const id = ++prevSeq;
  return new Promise((resolve, reject) => {
    prevWaiters.set(id, (d) => (d.error ? reject(new Error(d.error)) : resolve(d)));
    prev!.postMessage({ id, input, formats });
  });
}

export async function buildPreview(input: BuildInput): Promise<{ ttf: Uint8Array; report: BuildReport }> {
  const d = await fontWorker(input, ['ttf']);
  return { ttf: d.ttf!, report: d.report! };
}

/** Build every requested format in the browser (used when the server build is unavailable). */
export async function buildLocally(input: BuildInput, formats: ExportFormat[]) {
  const d = await fontWorker(input, formats);
  return { files: d.files!, report: d.report! };
}

let fontSeq = 0;
/** Register a font from bytes and return its CSS family name. */
export async function loadFontFace(bytes: Uint8Array, prefix = 'JibunPreview'): Promise<string> {
  const family = `${prefix}${++fontSeq}`;
  const face = new FontFace(family, bytes.slice().buffer);
  await face.load();
  document.fonts.add(face);
  // Remove older preview faces so memory stays flat.
  for (const f of document.fonts) if (f.family.startsWith(prefix) && f.family !== family && f.family !== `"${family}"`) document.fonts.delete(f);
  return family;
}
