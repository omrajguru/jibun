/** Queue consumer that compiles fonts and stores them in S3. */
import { brotliCompressSync, constants } from 'node:zlib';
import { buildFontFiles } from '../shared/font/build';
import type { BuildSummary, ExportFormat } from '../shared/types';
import { loadBuildInput, notifyRoom, toBuild } from './db';
import type { BuildMessage, Env } from './env';
import { storage } from './storage';

const brotli = (d: Uint8Array) => new Uint8Array(brotliCompressSync(d, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: d.length } }));

const MAX_ATTEMPTS = 3;
const CONTENT_TYPES: Record<ExportFormat, string> = { ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2' };

export function fileName(family: string, format: ExportFormat) {
  const base = family.normalize('NFKD').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'Jibun';
  return `${base}.${format}`;
}

export async function handleBuildBatch(batch: MessageBatch<BuildMessage>, env: Env) {
  for (const msg of batch.messages) {
    try {
      await runBuild(env, msg.body);
      msg.ack();
    } catch (err) {
      const row = await env.DB.prepare('SELECT attempts FROM builds WHERE id = ?').bind(msg.body.buildId).first<{ attempts: number }>();
      const attempts = row?.attempts ?? MAX_ATTEMPTS;
      const message = err instanceof Error ? err.message : String(err);
      console.error('build failed', msg.body.buildId, message);
      if (attempts < MAX_ATTEMPTS && !(err instanceof PermanentBuildError)) {
        await env.DB.prepare("UPDATE builds SET status = 'queued', error = ? WHERE id = ?").bind(message, msg.body.buildId).run();
        msg.retry({ delaySeconds: 5 * attempts });
      } else {
        await env.DB.prepare("UPDATE builds SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").bind(message.slice(0, 500), Date.now(), msg.body.buildId).run();
        await announce(env, msg.body.buildId, msg.body.projectId);
        msg.ack();
      }
    }
  }
}

export class PermanentBuildError extends Error {}

async function announce(env: Env, buildId: string, projectId: string, progress?: number) {
  const row = await env.DB.prepare('SELECT * FROM builds WHERE id = ?').bind(buildId).first<Parameters<typeof toBuild>[0]>();
  if (!row) return;
  const build: BuildSummary = { ...toBuild(row), progress };
  await notifyRoom(env, projectId, { type: 'build', build });
}

export async function runBuild(env: Env, { buildId, projectId }: BuildMessage) {
  const row = await env.DB.prepare('SELECT * FROM builds WHERE id = ? AND project_id = ?').bind(buildId, projectId).first<{ status: string; formats: string }>();
  if (!row || row.status === 'done' || row.status === 'failed') return; // idempotent redelivery
  await env.DB.prepare("UPDATE builds SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?").bind(Date.now(), buildId).run();
  await announce(env, buildId, projectId, 0.1);

  const { project, input } = await loadBuildInput(env, projectId);
  if (!input.samples.length) throw new PermanentBuildError('Nothing has been captured yet, so there is nothing to build.');
  const formats = JSON.parse(row.formats) as ExportFormat[];
  const { files, report } = await buildFontFiles(input, formats, brotli);
  await announce(env, buildId, projectId, 0.8);

  const stored: { format: ExportFormat; size: number }[] = [];
  for (const f of formats) {
    const bytes = files[f];
    if (!bytes) continue;
    await storage(env).put(`fonts/${projectId}/${buildId}/${fileName(input.settings.familyName, f)}`, bytes, {
      contentType: CONTENT_TYPES[f],
      metadata: { project: project.id, build: buildId },
    });
    stored.push({ format: f, size: bytes.length });
  }
  await env.DB.prepare("UPDATE builds SET status = 'done', glyph_count = ?, report = ?, files = ?, error = NULL, finished_at = ? WHERE id = ?")
    .bind(report.glyphCount, JSON.stringify(report), JSON.stringify(stored), Date.now(), buildId)
    .run();
  await announce(env, buildId, projectId, 1);
}
