/// <reference lib="webworker" />
/**
 * Builds fonts in the background with the same compiler the server uses: a
 * quick TTF for the live preview, or every export format when the server build
 * is unavailable (Brotli for WOFF2 comes from a WASM encoder).
 */
import { buildFontFiles } from '../../shared/font/build';
import type { BuildInput, ExportFormat } from '../../shared/types';

declare const self: DedicatedWorkerGlobalScope;

let brotli: Promise<(d: Uint8Array) => Uint8Array> | null = null;
const getBrotli = () =>
  (brotli ??= import('brotli-wasm').then((m) => m.default).then((b) => (d: Uint8Array) => b.compress(d, { quality: 11 })));

self.onmessage = async (ev: MessageEvent<{ id: number; input: BuildInput; formats?: ExportFormat[] }>) => {
  const { id, input } = ev.data;
  const formats = ev.data.formats ?? ['ttf'];
  try {
    const enc = formats.includes('woff2') ? await getBrotli() : null;
    const { files, report } = await buildFontFiles(input, formats, enc);
    const transfer = Object.values(files).map((f) => f!.buffer);
    self.postMessage({ id, files, ttf: files.ttf, report }, transfer);
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
