/**
 * Turn an uploaded PDF (a scanner's output, or a template filled in with a
 * PDF app) into one image per page, rendered at about 2,500 px on the long side.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const TARGET_LONG_SIDE = 2500;
export const MAX_PDF_PAGES = 60;

export async function pdfToImages(file: Blob, onPage?: (n: number, total: number) => void): Promise<Blob[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  let doc: pdfjs.PDFDocumentProxy;
  const task = pdfjs.getDocument({ data, enableXfa: false });
  try {
    doc = await task.promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/password/i.test(msg) ? 'This PDF is password protected. Remove the password and try again.' : 'This PDF could not be opened. It may be damaged.');
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new Error(`This PDF has ${doc.numPages} pages; upload at most ${MAX_PDF_PAGES} at a time.`);
    const out: Blob[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onPage?.(i, doc.numPages);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = TARGET_LONG_SIDE / Math.max(base.width, base.height);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // 'print' renders without waiting for animation frames (which never fire in a
      // background tab) and includes filled-in form fields and ink annotations.
      await page.render({ canvas, canvasContext: ctx, viewport: vp, background: '#ffffff', intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
      page.cleanup();
      out.push(await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not render the PDF page'))), 'image/png')));
      canvas.width = canvas.height = 0;
    }
    return out;
  } finally {
    await task.destroy();
  }
}

export function isPdf(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}
