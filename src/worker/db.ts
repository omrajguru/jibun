/** Data access shared by the HTTP API, the MCP server and the build consumer. */
import { normaliseSettings } from '../shared/font/build';
import { paginate, type Paper } from '../shared/layout';
import {
  LIMITS,
  type BuildSummary,
  type CharacterRow,
  type ExportFormat,
  type FontSettings,
  type GlyphAdjust,
  type LigatureDef,
  type PageRow,
  type ProjectDetail,
  type ProjectSummary,
  type SampleFlag,
  type SampleRow,
  type SampleUpload,
} from '../shared/types';
import { decomposition, dedupeKeys } from '../shared/unicode';
import type { Env } from './env';
import { deletePrefix, storage } from './storage';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function newId(prefix: string, len = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 62];
  return `${prefix}_${s}`;
}

const j = <T>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

interface ProjectDbRow {
  id: string;
  user_id: string;
  name: string;
  paper: Paper;
  samples_per_char: number;
  settings: string;
  created_at: number;
  updated_at: number;
}

interface BuildDbRow {
  id: string;
  project_id: string;
  status: BuildSummary['status'];
  formats: string;
  glyph_count: number | null;
  files: string;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  report: string | null;
}

export function toBuild(r: BuildDbRow): BuildSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    formats: j(r.formats, [] as ExportFormat[]),
    glyphCount: r.glyph_count,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    files: j(r.files, [] as { format: ExportFormat; size: number }[]),
  };
}

export async function requireProject(env: Env, userId: string, projectId: string): Promise<ProjectDbRow> {
  const row = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(projectId, userId).first<ProjectDbRow>();
  if (!row) throw new HttpError(404, 'Project not found');
  return row;
}

export async function touchProject(env: Env, projectId: string) {
  await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(Date.now(), projectId).run();
}

export async function listProjects(env: Env, userId: string): Promise<ProjectSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
      (SELECT COUNT(*) FROM characters c WHERE c.project_id = p.id) AS character_count,
      (SELECT COUNT(DISTINCT s.key) FROM samples s WHERE s.project_id = p.id AND s.status = 'ok') AS captured_count,
      (SELECT COUNT(*) FROM samples s WHERE s.project_id = p.id AND s.status = 'flagged') AS flagged_count
     FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC`,
  )
    .bind(userId)
    .all<ProjectDbRow & { character_count: number; captured_count: number; flagged_count: number }>();
  const builds = await env.DB.prepare(
    `SELECT b.* FROM builds b JOIN projects p ON p.id = b.project_id WHERE p.user_id = ? AND b.created_at = (SELECT MAX(created_at) FROM builds b2 WHERE b2.project_id = b.project_id)`,
  )
    .bind(userId)
    .all<BuildDbRow>();
  const lastBuild = new Map(builds.results.map((b) => [b.project_id, toBuild(b)]));
  // "Ready" counts characters that are written or will be composed from written parts.
  const [charRows, sampleRows] = await env.DB.batch([
    env.DB.prepare('SELECT c.project_id, c.key FROM characters c JOIN projects p ON p.id = c.project_id WHERE p.user_id = ?').bind(userId),
    env.DB.prepare("SELECT DISTINCT s.project_id, s.key FROM samples s JOIN projects p ON p.id = s.project_id WHERE p.user_id = ? AND s.status <> 'rejected'").bind(userId),
  ]);
  const have = new Map<string, Set<string>>();
  for (const s of sampleRows!.results as { project_id: string; key: string }[]) (have.get(s.project_id) ?? have.set(s.project_id, new Set()).get(s.project_id)!).add(s.key);
  const ready = new Map<string, number>();
  const compose = new Map(results.map((r) => [r.id, normaliseSettings(j(r.settings, {})).autoCompose]));
  for (const c of charRows!.results as { project_id: string; key: string }[]) {
    const got = have.get(c.project_id);
    let ok = !!got?.has(c.key);
    if (!ok && got && compose.get(c.project_id)) {
      const d = decomposition(c.key);
      ok = !!d && [d.base, ...d.marks].every((k) => got.has(k));
    }
    if (ok) ready.set(c.project_id, (ready.get(c.project_id) ?? 0) + 1);
  }
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    paper: r.paper,
    samplesPerChar: r.samples_per_char,
    characterCount: r.character_count,
    capturedCount: ready.get(r.id) ?? 0,
    flaggedCount: r.flagged_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastBuild: lastBuild.get(r.id) ?? null,
  }));
}

export async function createProject(
  env: Env,
  userId: string,
  input: { name: string; keys: string[]; paper: Paper; samplesPerChar: number; settings?: Partial<FontSettings> },
): Promise<string> {
  const keys = dedupeKeys(input.keys);
  if (!keys.length) throw new HttpError(400, 'Choose at least one character');
  if (keys.length > LIMITS.maxCharacters) throw new HttpError(400, `A font can hold up to ${LIMITS.maxCharacters} base characters`);
  const name = input.name.trim().slice(0, 80) || 'Untitled font';
  const id = newId('prj');
  const now = Date.now();
  const settings = normaliseSettings({ ...input.settings, familyName: input.settings?.familyName ?? name });
  const stmts = [
    env.DB.prepare('INSERT INTO projects (id, user_id, name, paper, samples_per_char, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      userId,
      name,
      input.paper === 'letter' ? 'letter' : 'a4',
      clampInt(input.samplesPerChar, 1, LIMITS.maxSamplesPerChar),
      JSON.stringify(settings),
      now,
      now,
    ),
    ...keys.map((k, i) => env.DB.prepare('INSERT INTO characters (project_id, key, position) VALUES (?, ?, ?)').bind(id, k, i)),
  ];
  await batchChunked(env, stmts);
  return id;
}

export function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

/** D1 batches are limited; split large inserts. */
export async function batchChunked(env: Env, stmts: D1PreparedStatement[], size = 90) {
  for (let i = 0; i < stmts.length; i += size) await env.DB.batch(stmts.slice(i, i + size));
}

export async function getProjectDetail(env: Env, userId: string, projectId: string): Promise<ProjectDetail> {
  const p = await requireProject(env, userId, projectId);
  const [chars, samples, pages, ligs, last] = await env.DB.batch([
    env.DB.prepare('SELECT key, position, adjust FROM characters WHERE project_id = ? ORDER BY position').bind(projectId),
    env.DB.prepare(
      "SELECT id, key, page_id, cell_index, path, flags, confidence, status, source, bitmap_key, created_at FROM samples WHERE project_id = ? AND status <> 'rejected' ORDER BY created_at",
    ).bind(projectId),
    env.DB.prepare('SELECT * FROM pages WHERE project_id = ? ORDER BY created_at, page_number').bind(projectId),
    env.DB.prepare('SELECT * FROM ligatures WHERE project_id = ? ORDER BY created_at').bind(projectId),
    env.DB.prepare('SELECT * FROM builds WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').bind(projectId),
  ]);
  const characters: CharacterRow[] = (chars!.results as { key: string; position: number; adjust: string | null }[]).map((c) => ({
    key: c.key,
    position: c.position,
    adjust: j<GlyphAdjust | null>(c.adjust, null),
  }));
  const sampleRows: SampleRow[] = (samples!.results as Record<string, unknown>[]).map(toSample);
  const pageRows: PageRow[] = (pages!.results as Record<string, unknown>[]).map(toPage);
  const ligatures: LigatureDef[] = (ligs!.results as { id: string; sequence: string; overlap: number }[]).map((l) => ({ id: l.id, sequence: l.sequence, overlap: l.overlap }));
  const keysCaptured = new Set(sampleRows.filter((s) => s.status === 'ok').map((s) => s.key));
  const lastBuild = (last!.results as BuildDbRow[])[0];
  return {
    project: {
      id: p.id,
      name: p.name,
      paper: p.paper,
      samplesPerChar: p.samples_per_char,
      characterCount: characters.length,
      capturedCount: keysCaptured.size,
      flaggedCount: sampleRows.filter((s) => s.status === 'flagged').length,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      settings: normaliseSettings(j(p.settings, {})),
      lastBuild: lastBuild ? toBuild(lastBuild) : null,
    },
    characters,
    samples: sampleRows,
    pages: pageRows,
    ligatures,
  };
}

function toSample(r: Record<string, unknown>): SampleRow {
  return {
    id: r.id as string,
    key: r.key as string,
    pageId: (r.page_id as string) ?? null,
    cellIndex: (r.cell_index as number) ?? null,
    path: r.path as string,
    flags: j(r.flags as string, [] as SampleFlag[]),
    confidence: r.confidence as number,
    status: r.status as SampleRow['status'],
    source: r.source as SampleRow['source'],
    createdAt: r.created_at as number,
    bitmapKey: (r.bitmap_key as string) ?? null,
  };
}

function toPage(r: Record<string, unknown>): PageRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as PageRow['kind'],
    paper: r.paper as Paper,
    pageNumber: r.page_number as number,
    pageCount: r.page_count as number,
    cells: j(r.cells as string, [] as string[]),
    createdAt: r.created_at as number,
    processedAt: (r.processed_at as number) ?? null,
  };
}

export async function updateProject(env: Env, userId: string, projectId: string, patch: { name?: string; paper?: Paper; samplesPerChar?: number; settings?: Partial<FontSettings> }) {
  const p = await requireProject(env, userId, projectId);
  const settings = patch.settings ? normaliseSettings({ ...j(p.settings, {}), ...patch.settings }) : normaliseSettings(j(p.settings, {}));
  await env.DB.prepare('UPDATE projects SET name = ?, paper = ?, samples_per_char = ?, settings = ?, updated_at = ? WHERE id = ?')
    .bind(
      patch.name !== undefined ? patch.name.trim().slice(0, 80) || p.name : p.name,
      patch.paper === 'letter' || patch.paper === 'a4' ? patch.paper : p.paper,
      patch.samplesPerChar !== undefined ? clampInt(patch.samplesPerChar, 1, LIMITS.maxSamplesPerChar) : p.samples_per_char,
      JSON.stringify(settings),
      Date.now(),
      projectId,
    )
    .run();
}

export async function setCharacters(env: Env, userId: string, projectId: string, keysIn: string[]) {
  await requireProject(env, userId, projectId);
  const keys = dedupeKeys(keysIn);
  if (!keys.length) throw new HttpError(400, 'Choose at least one character');
  if (keys.length > LIMITS.maxCharacters) throw new HttpError(400, `A font can hold up to ${LIMITS.maxCharacters} base characters`);
  const existing = await env.DB.prepare('SELECT key FROM characters WHERE project_id = ?').bind(projectId).all<{ key: string }>();
  const keep = new Set(keys);
  const stmts: D1PreparedStatement[] = [];
  for (const r of existing.results) if (!keep.has(r.key)) stmts.push(env.DB.prepare('DELETE FROM characters WHERE project_id = ? AND key = ?').bind(projectId, r.key));
  keys.forEach((k, i) =>
    stmts.push(env.DB.prepare('INSERT INTO characters (project_id, key, position) VALUES (?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET position = excluded.position').bind(projectId, k, i)),
  );
  await batchChunked(env, stmts);
  await touchProject(env, projectId);
}

export function sanitizeAdjust(a: unknown): GlyphAdjust | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  const out: GlyphAdjust = { lsb: num(o.lsb, -400, 400), rsb: num(o.rsb, -400, 400), baseline: num(o.baseline, -500, 500), scale: num(o.scale, 0.3, 3) };
  for (const k of Object.keys(out) as (keyof GlyphAdjust)[]) if (out[k] === undefined || out[k] === (k === 'scale' ? 1 : 0)) delete out[k];
  return Object.keys(out).length ? out : null;
}

export async function setAdjust(env: Env, userId: string, projectId: string, key: string, adjust: unknown) {
  await requireProject(env, userId, projectId);
  const a = sanitizeAdjust(adjust);
  const r = await env.DB.prepare('UPDATE characters SET adjust = ? WHERE project_id = ? AND key = ?').bind(a ? JSON.stringify(a) : null, projectId, key).run();
  if (!r.meta.changes) throw new HttpError(404, 'Character not in this font');
  await touchProject(env, projectId);
}

export async function createPages(env: Env, userId: string, projectId: string, kind: 'template' | 'rewrite', keysIn?: string[]): Promise<PageRow[]> {
  const p = await requireProject(env, userId, projectId);
  const all = await env.DB.prepare('SELECT key FROM characters WHERE project_id = ? ORDER BY position').bind(projectId).all<{ key: string }>();
  const valid = new Set(all.results.map((r) => r.key));
  let keys: string[];
  let perChar = p.samples_per_char;
  if (kind === 'template') {
    keys = keysIn?.length ? dedupeKeys(keysIn).filter((k) => valid.has(k)) : all.results.map((r) => r.key);
  } else {
    keys = dedupeKeys(keysIn ?? []).filter((k) => valid.has(k));
    perChar = 1;
  }
  if (!keys.length) throw new HttpError(400, 'No characters to put on the sheet');
  const chunks = paginate(keys, perChar, p.paper);
  const batch = newId('bat', 10);
  const now = Date.now();
  const rows: PageRow[] = chunks.map((cells, i) => ({
    id: newId('pg', 14),
    projectId,
    kind,
    paper: p.paper,
    pageNumber: i + 1,
    pageCount: chunks.length,
    cells,
    createdAt: now,
    processedAt: null,
  }));
  await batchChunked(
    env,
    rows.map((r) =>
      env.DB.prepare('INSERT INTO pages (id, project_id, kind, paper, page_number, page_count, batch_id, cells, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        r.id,
        projectId,
        kind,
        r.paper,
        r.pageNumber,
        r.pageCount,
        batch,
        JSON.stringify(r.cells),
        now,
      ),
    ),
  );
  await touchProject(env, projectId);
  return rows;
}

export async function getPage(env: Env, userId: string, pageId: string): Promise<PageRow> {
  const r = await env.DB.prepare('SELECT pg.* FROM pages pg JOIN projects p ON p.id = pg.project_id WHERE pg.id = ? AND p.user_id = ?').bind(pageId, userId).first<Record<string, unknown>>();
  if (!r) throw new HttpError(404, 'This page does not belong to any of your fonts');
  return toPage(r);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FLAGS: SampleFlag[] = ['empty', 'edge', 'noise', 'faint', 'tiny', 'unaligned'];
const PATH_RE = /^[MmLlHhVvCcSsQqTtZz0-9eE.,+\-\s]*$/;

export async function addSamples(env: Env, userId: string, projectId: string, pageId: string | null, uploads: SampleUpload[]): Promise<SampleRow[]> {
  await requireProject(env, userId, projectId);
  if (!Array.isArray(uploads) || !uploads.length) throw new HttpError(400, 'No samples');
  if (uploads.length > LIMITS.maxSamplesPerRequest) throw new HttpError(400, 'Too many samples in one request');
  let page: PageRow | null = null;
  if (pageId) {
    page = await getPage(env, userId, pageId);
    if (page.projectId !== projectId) throw new HttpError(400, 'That page belongs to a different font');
  }
  const keys = new Set((await env.DB.prepare('SELECT key FROM characters WHERE project_id = ?').bind(projectId).all<{ key: string }>()).results.map((r) => r.key));
  const now = Date.now();
  const rows: SampleRow[] = [];
  const stmts: D1PreparedStatement[] = [];
  const puts: Promise<unknown>[] = [];
  for (const u of uploads) {
    if (typeof u.key !== 'string' || !keys.has(u.key)) throw new HttpError(400, `Character ${JSON.stringify(u.key)} is not in this font`);
    if (page) {
      if (typeof u.cellIndex !== 'number' || page.cells[u.cellIndex] !== u.key) throw new HttpError(400, 'Cell does not match the page layout');
    }
    const flags = (Array.isArray(u.flags) ? u.flags : []).filter((f): f is SampleFlag => FLAGS.includes(f));
    if (flags.includes('empty')) continue; // empty cells are simply not captured
    if (typeof u.path !== 'string' || !u.path || u.path.length > LIMITS.maxPathLength || !PATH_RE.test(u.path)) throw new HttpError(400, 'Invalid outline');
    const id = newId('smp');
    let bitmapKey: string | null = null;
    let bitmap: Uint8Array | null = null;
    if (u.bitmap) {
      const bytes = b64ToBytes(u.bitmap);
      if (bytes.length > LIMITS.maxBitmapBytes || !PNG_SIG.every((b, i) => bytes[i] === b)) throw new HttpError(400, 'Invalid bitmap');
      bitmap = bytes;
      bitmapKey = 'd1';
    }
    const confidence = Math.min(1, Math.max(0, Number(u.confidence) || 0));
    const status: SampleRow['status'] = flags.length ? 'flagged' : 'ok';
    const source = u.source === 'screen' ? 'screen' : 'scan';
    if (page) {
      // Re-processing the same page replaces the earlier result for that cell.
      stmts.push(env.DB.prepare('DELETE FROM samples WHERE page_id = ? AND cell_index = ?').bind(page.id, u.cellIndex));
    }
    if (status === 'ok' && (page?.kind === 'rewrite' || !page)) {
      // A redo supersedes earlier flagged attempts for the same character.
      stmts.push(env.DB.prepare("UPDATE samples SET status = 'rejected' WHERE project_id = ? AND key = ? AND status = 'flagged'").bind(projectId, u.key));
    }
    stmts.push(
      env.DB.prepare(
        'INSERT INTO samples (id, project_id, key, page_id, cell_index, path, flags, confidence, status, source, bitmap_key, bitmap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, projectId, u.key, page?.id ?? null, page ? u.cellIndex : null, u.path, JSON.stringify(flags), confidence, status, source, bitmapKey, bitmap, now),
    );
    rows.push({ id, key: u.key, pageId: page?.id ?? null, cellIndex: page ? (u.cellIndex as number) : null, path: u.path, flags, confidence, status, source, createdAt: now, bitmapKey });
  }
  await Promise.all(puts);
  if (page) stmts.push(env.DB.prepare('UPDATE pages SET processed_at = ? WHERE id = ?').bind(now, page.id));
  await batchChunked(env, stmts);
  await touchProject(env, projectId);
  return rows;
}

export async function setSampleStatus(env: Env, userId: string, projectId: string, sampleId: string, status: 'ok' | 'rejected') {
  await requireProject(env, userId, projectId);
  const r = await env.DB.prepare('UPDATE samples SET status = ? WHERE id = ? AND project_id = ?').bind(status, sampleId, projectId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Sample not found');
  await touchProject(env, projectId);
}

export async function loadBuildInput(env: Env, projectId: string) {
  const [p, chars, samples, ligs] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId),
    env.DB.prepare('SELECT key, adjust FROM characters WHERE project_id = ? ORDER BY position').bind(projectId),
    env.DB.prepare(
      "SELECT key, path FROM samples WHERE project_id = ? AND status IN ('ok', 'flagged') ORDER BY key, CASE status WHEN 'ok' THEN 0 ELSE 1 END, created_at DESC",
    ).bind(projectId),
    env.DB.prepare('SELECT id, sequence, overlap FROM ligatures WHERE project_id = ? ORDER BY created_at').bind(projectId),
  ]);
  const proj = (p!.results as ProjectDbRow[])[0];
  if (!proj) throw new HttpError(404, 'Project not found');
  return {
    project: proj,
    input: {
      settings: normaliseSettings(j(proj.settings, {})),
      characters: (chars!.results as { key: string; adjust: string | null }[]).map((c) => ({ key: c.key, adjust: j<GlyphAdjust | null>(c.adjust, null) })),
      samples: samples!.results as { key: string; path: string }[],
      ligatures: (ligs!.results as LigatureDef[]).map((l) => ({ id: l.id, sequence: l.sequence, overlap: l.overlap })),
    },
  };
}

export async function deleteProject(env: Env, userId: string, projectId: string) {
  await requireProject(env, userId, projectId);
  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
  // Remove stored objects under every prefix for this project.
  const store = storage(env);
  for (const prefix of [`bitmaps/${projectId}/`, `fonts/${projectId}/`, `templates/${projectId}/`, `scans/${projectId}/`]) await deletePrefix(store, prefix);
}

export async function listBuilds(env: Env, userId: string, projectId?: string, limit = 50): Promise<(BuildSummary & { projectName: string })[]> {
  const q = projectId
    ? env.DB.prepare('SELECT b.*, p.name AS project_name FROM builds b JOIN projects p ON p.id = b.project_id WHERE p.user_id = ? AND p.id = ? ORDER BY b.created_at DESC LIMIT ?').bind(userId, projectId, limit)
    : env.DB.prepare('SELECT b.*, p.name AS project_name FROM builds b JOIN projects p ON p.id = b.project_id WHERE p.user_id = ? ORDER BY b.created_at DESC LIMIT ?').bind(userId, limit);
  const { results } = await q.all<BuildDbRow & { project_name: string }>();
  return results.map((r) => ({ ...toBuild(r), projectName: r.project_name }));
}

export async function getBuild(env: Env, userId: string, buildId: string) {
  const r = await env.DB.prepare('SELECT b.* FROM builds b JOIN projects p ON p.id = b.project_id WHERE b.id = ? AND p.user_id = ?').bind(buildId, userId).first<BuildDbRow>();
  if (!r) throw new HttpError(404, 'Build not found');
  return { build: toBuild(r), report: j(r.report, null as unknown) };
}

export const ALL_FORMATS: ExportFormat[] = ['ttf', 'otf', 'woff2'];
export function parseFormats(f: unknown): ExportFormat[] {
  const arr = Array.isArray(f) ? f : ALL_FORMATS;
  const out = ALL_FORMATS.filter((x) => arr.includes(x));
  if (!out.length) throw new HttpError(400, 'Choose at least one format');
  return out;
}

/** Ask the project's Durable Object to start (or reuse) a build. */
export async function requestBuild(env: Env, userId: string, projectId: string, formats: ExportFormat[]): Promise<BuildSummary> {
  await requireProject(env, userId, projectId);
  const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
  return stub.requestBuild(projectId, formats);
}

export async function notifyRoom(env: Env, projectId: string, event: unknown) {
  try {
    const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
    await stub.broadcast(event);
  } catch {
    // Live updates are best effort; clients also poll.
  }
}
