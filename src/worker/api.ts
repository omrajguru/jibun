import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { LIMITS, type SampleUpload } from '../shared/types';
import { PUBLIC_AUTH_ROUTES, createAuth, getOwner, googleConfigured } from './auth';
import {
  HttpError,
  addSamples,
  createPages,
  createProject,
  deleteProject,
  getBuild,
  getPage,
  getProjectDetail,
  listBuilds,
  listProjects,
  newId,
  parseFormats,
  requestBuild,
  requireProject,
  setAdjust,
  setCharacters,
  setSampleStatus,
  touchProject,
  updateProject,
} from './db';
import { fileName } from './builder';
import type { Env, Owner } from './env';
import { storage } from './storage';
import { authorizeHandler } from './mcp';

type Ctx = { Bindings: Env; Variables: { owner: Owner } };

export const app = new Hono<Ctx>();

app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false, xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin' }));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof Error && /is not configured/.test(err.message)) return c.json({ error: `Jibun is not set up yet: ${err.message}` }, 503);
  console.error(err);
  return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500);
});

// ---------------------------------------------------------------- auth

app.all('/api/auth/*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (!PUBLIC_AUTH_ROUTES.has(path)) return c.json({ error: 'Not found' }, 404);
  return createAuth(c.env).handler(c.req.raw);
});

// Health check: proves the database and storage work. Reports only pass/fail.
app.get('/api/health', async (c) => {
  const result: Record<string, boolean> = { database: false, storage: false };
  try {
    await c.env.DB.prepare('SELECT 1').first();
    result.database = true;
  } catch {
    /* reported below */
  }
  try {
    const store = storage(c.env);
    const key = `health/${crypto.randomUUID()}.txt`;
    await store.put(key, new TextEncoder().encode('ok'), { contentType: 'text/plain' });
    const got = await store.get(key);
    const text = got ? await new Response(got.body).text() : '';
    await store.delete([key]);
    result.storage = text === 'ok';
  } catch {
    /* reported below */
  }
  const ok = Object.values(result).every(Boolean);
  return c.json({ ok, ...result }, ok ? 200 : 503, { 'Cache-Control': 'no-store' });
});

// Which sign-in methods the login page should offer.
app.get('/api/auth-methods', (c) => c.json({ password: true, google: googleConfigured(c.env) }));

// OAuth authorization page for MCP clients (session-gated inside).
app.get('/oauth/authorize', authorizeHandler);
app.post('/oauth/authorize', authorizeHandler);

// ---------------------------------------------------------------- session gate

app.use('/api/*', async (c, next) => {
  const owner = await getOwner(c.env, c.req.raw.headers);
  if (!owner) return c.json({ error: 'Sign in to continue' }, 401);
  // CSRF: state-changing requests must come from our own origin.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    const self = new URL(c.req.url).origin;
    if (origin && origin !== self) return c.json({ error: 'Cross-site request refused' }, 403);
  }
  c.set('owner', owner);
  await next();
});

const body = async <T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> => {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
};

app.get('/api/me', (c) => c.json({ email: c.get('owner').email }));

app.get('/api/projects', async (c) => c.json(await listProjects(c.env, c.get('owner').userId)));

app.post('/api/projects', async (c) => {
  const b = await body<{ name: string; keys: string[]; paper: 'a4' | 'letter'; samplesPerChar: number; settings?: Record<string, unknown> }>(c);
  if (!Array.isArray(b.keys)) throw new HttpError(400, 'keys must be a list');
  const id = await createProject(c.env, c.get('owner').userId, { name: String(b.name ?? ''), keys: b.keys.map(String), paper: b.paper, samplesPerChar: b.samplesPerChar ?? 1, settings: b.settings });
  return c.json(await getProjectDetail(c.env, c.get('owner').userId, id), 201);
});

app.get('/api/projects/:id', async (c) => c.json(await getProjectDetail(c.env, c.get('owner').userId, c.req.param('id'))));

app.patch('/api/projects/:id', async (c) => {
  const b = await body<Parameters<typeof updateProject>[3]>(c);
  await updateProject(c.env, c.get('owner').userId, c.req.param('id'), b);
  return c.json(await getProjectDetail(c.env, c.get('owner').userId, c.req.param('id')));
});

app.delete('/api/projects/:id', async (c) => {
  await deleteProject(c.env, c.get('owner').userId, c.req.param('id'));
  return c.json({ ok: true });
});

app.put('/api/projects/:id/characters', async (c) => {
  const b = await body<{ keys: string[] }>(c);
  if (!Array.isArray(b.keys)) throw new HttpError(400, 'keys must be a list');
  await setCharacters(c.env, c.get('owner').userId, c.req.param('id'), b.keys.map(String));
  return c.json(await getProjectDetail(c.env, c.get('owner').userId, c.req.param('id')));
});

app.put('/api/projects/:id/adjust', async (c) => {
  const b = await body<{ key: string; adjust: unknown }>(c);
  await setAdjust(c.env, c.get('owner').userId, c.req.param('id'), String(b.key), b.adjust);
  return c.json({ ok: true });
});

app.post('/api/projects/:id/pages', async (c) => {
  const b = await body<{ kind: 'template' | 'rewrite'; keys?: string[] }>(c);
  const kind = b.kind === 'rewrite' ? 'rewrite' : 'template';
  return c.json(await createPages(c.env, c.get('owner').userId, c.req.param('id'), kind, Array.isArray(b.keys) ? b.keys.map(String) : undefined), 201);
});

app.get('/api/pages/:pageId', async (c) => c.json(await getPage(c.env, c.get('owner').userId, c.req.param('pageId'))));

// Template PDFs are generated in the browser (it has fonts for every script) and stored here.
app.put('/api/projects/:id/pdf/:batch', async (c) => {
  await requireProject(c.env, c.get('owner').userId, c.req.param('id'));
  const batch = c.req.param('batch');
  if (!/^[A-Za-z0-9_-]{4,60}$/.test(batch)) throw new HttpError(400, 'Bad name');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > 30_000_000 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new HttpError(400, 'Not a PDF');
  await storage(c.env).put(`templates/${c.req.param('id')}/${batch}.pdf`, bytes, { contentType: 'application/pdf' });
  return c.json({ ok: true });
});

app.get('/api/projects/:id/pdf/:batch', async (c) => {
  await requireProject(c.env, c.get('owner').userId, c.req.param('id'));
  if (!/^[A-Za-z0-9_-]{4,60}$/.test(c.req.param('batch'))) throw new HttpError(400, 'Bad name');
  const obj = await storage(c.env).get(`templates/${c.req.param('id')}/${c.req.param('batch')}.pdf`);
  if (!obj) throw new HttpError(404, 'Template not found');
  return new Response(obj.body, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="jibun-${c.req.param('batch')}.pdf"`, 'Cache-Control': 'private, no-store' } });
});

app.post('/api/projects/:id/samples', async (c) => {
  const b = await body<{ pageId?: string | null; samples: SampleUpload[] }>(c);
  const rows = await addSamples(c.env, c.get('owner').userId, c.req.param('id'), b.pageId ?? null, b.samples);
  return c.json(rows, 201);
});

app.patch('/api/projects/:id/samples/:sid', async (c) => {
  const b = await body<{ status: 'ok' | 'rejected' }>(c);
  if (b.status !== 'ok' && b.status !== 'rejected') throw new HttpError(400, 'status must be ok or rejected');
  await setSampleStatus(c.env, c.get('owner').userId, c.req.param('id'), c.req.param('sid'), b.status);
  return c.json({ ok: true });
});

app.get('/api/projects/:id/samples/:sid/bitmap', async (c) => {
  await requireProject(c.env, c.get('owner').userId, c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT bitmap_key, bitmap FROM samples WHERE id = ? AND project_id = ?')
    .bind(c.req.param('sid'), c.req.param('id'))
    .first<{ bitmap_key: string | null; bitmap: ArrayBuffer | number[] | null }>();
  const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' };
  if (row?.bitmap) return new Response(new Uint8Array(row.bitmap as ArrayBuffer), { headers });
  if (!row?.bitmap_key || row.bitmap_key === 'd1') throw new HttpError(404, 'No bitmap');
  const obj = await storage(c.env).get(row.bitmap_key);
  if (!obj) throw new HttpError(404, 'No bitmap');
  return new Response(obj.body, { headers });
});

app.post('/api/projects/:id/ligatures', async (c) => {
  const { userId } = c.get('owner');
  const pid = c.req.param('id');
  await requireProject(c.env, userId, pid);
  const b = await body<{ sequence: string; overlap?: number }>(c);
  const seq = String(b.sequence ?? '').normalize('NFC');
  if (Array.from(seq).length < 2 || Array.from(seq).length > 6) throw new HttpError(400, 'A ligature joins 2 to 6 characters');
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM ligatures WHERE project_id = ?').bind(pid).first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.maxLigatures) throw new HttpError(400, 'Too many ligatures');
  const overlap = Math.max(-200, Math.min(400, Math.round(Number(b.overlap ?? 40)) || 0));
  await c.env.DB.prepare('INSERT INTO ligatures (id, project_id, sequence, overlap, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, sequence) DO UPDATE SET overlap = excluded.overlap')
    .bind(newId('lig'), pid, seq, overlap, Date.now())
    .run();
  await touchProject(c.env, pid);
  return c.json(await getProjectDetail(c.env, userId, pid));
});

app.delete('/api/projects/:id/ligatures/:lid', async (c) => {
  const { userId } = c.get('owner');
  await requireProject(c.env, userId, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM ligatures WHERE id = ? AND project_id = ?').bind(c.req.param('lid'), c.req.param('id')).run();
  return c.json(await getProjectDetail(c.env, userId, c.req.param('id')));
});

// Optional scan backups (processing stays in the browser).
app.post('/api/projects/:id/scans', async (c) => {
  const pid = c.req.param('id');
  await requireProject(c.env, c.get('owner').userId, pid);
  const pageId = c.req.query('page') ?? null;
  if (pageId !== null && (await getPage(c.env, c.get('owner').userId, pageId)).projectId !== pid) throw new HttpError(404, 'Page not found');
  const type = c.req.header('content-type') ?? '';
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(type)) throw new HttpError(400, 'Unsupported image type');
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > LIMITS.maxScanBytes) throw new HttpError(413, 'Image too large');
  const id = newId('scn');
  const key = `scans/${pid}/${id}`;
  await storage(c.env).put(key, bytes, { contentType: type });
  await c.env.DB.prepare('INSERT INTO scans (id, project_id, page_id, r2_key, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, pid, pageId, key, bytes.byteLength, Date.now()).run();
  return c.json({ id }, 201);
});

// ---------------------------------------------------------------- builds

app.post('/api/projects/:id/builds', async (c) => {
  const b = await body<{ formats?: string[] }>(c);
  return c.json(await requestBuild(c.env, c.get('owner').userId, c.req.param('id'), parseFormats(b.formats)), 202);
});

// Fonts compiled in the browser (fallback when the server builder is unavailable) are stored like any build.
app.post('/api/projects/:id/builds/upload', async (c) => {
  const pid = c.req.param('id');
  await requireProject(c.env, c.get('owner').userId, pid);
  const form = await c.req.formData().catch(() => {
    throw new HttpError(400, 'Expected form data');
  });
  const MAGIC: Record<'ttf' | 'otf' | 'woff2', number[]> = { ttf: [0, 1, 0, 0], otf: [0x4f, 0x54, 0x54, 0x4f], woff2: [0x77, 0x4f, 0x46, 0x32] };
  const proj = await c.env.DB.prepare('SELECT settings FROM projects WHERE id = ?').bind(pid).first<{ settings: string }>();
  const family = (JSON.parse(proj?.settings ?? '{}') as { familyName?: string }).familyName ?? 'Jibun';
  const id = newId('bld');
  const store = storage(c.env);
  const stored: { format: 'ttf' | 'otf' | 'woff2'; size: number }[] = [];
  for (const f of ['ttf', 'otf', 'woff2'] as const) {
    const file = form.get(f);
    if (!file || typeof file === 'string') continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 30_000_000 || !MAGIC[f].every((b, i) => bytes[i] === b)) throw new HttpError(400, `The ${f.toUpperCase()} file is not valid`);
    await store.put(`fonts/${pid}/${id}/${fileName(family, f)}`, bytes, { contentType: `font/${f}` });
    stored.push({ format: f, size: bytes.length });
  }
  if (!stored.length) throw new HttpError(400, 'No font files');
  let report: { glyphCount?: number } | null = null;
  try {
    report = JSON.parse(String(form.get('report') ?? 'null'));
  } catch {
    report = null;
  }
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO builds (id, project_id, status, formats, glyph_count, report, files, created_at, started_at, finished_at) VALUES (?, ?, 'done', ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, pid, JSON.stringify(stored.map((s) => s.format)), report?.glyphCount ?? null, JSON.stringify(report), JSON.stringify(stored), now, now, now)
    .run();
  const replaces = form.get('replaces');
  if (typeof replaces === 'string' && replaces) {
    await c.env.DB.prepare("UPDATE builds SET status = 'failed', error = 'Built in the browser instead', finished_at = ? WHERE id = ? AND project_id = ? AND status <> 'done'").bind(now, replaces, pid).run();
  }
  return c.json((await getBuild(c.env, c.get('owner').userId, id)).build, 201);
});

app.get('/api/projects/:id/builds', async (c) => c.json(await listBuilds(c.env, c.get('owner').userId, c.req.param('id'))));
app.get('/api/builds', async (c) => c.json(await listBuilds(c.env, c.get('owner').userId, undefined, 200)));
app.get('/api/builds/:bid', async (c) => c.json(await getBuild(c.env, c.get('owner').userId, c.req.param('bid'))));

app.get('/api/builds/:bid/files/:format', async (c) => {
  const { build } = await getBuild(c.env, c.get('owner').userId, c.req.param('bid'));
  const format = c.req.param('format') as 'ttf' | 'otf' | 'woff2';
  if (!build.files.some((f) => f.format === format)) throw new HttpError(404, 'That format was not exported in this build');
  const proj = await c.env.DB.prepare('SELECT settings FROM projects WHERE id = ?').bind(build.projectId).first<{ settings: string }>();
  const family = (JSON.parse(proj?.settings ?? '{}') as { familyName?: string }).familyName ?? 'Jibun';
  const name = fileName(family, format);
  const store = storage(c.env);
  let obj = await store.get(`fonts/${build.projectId}/${build.id}/${name}`);
  if (!obj) {
    // The family name may have changed since the build; find the file by prefix.
    const list = await store.list(`fonts/${build.projectId}/${build.id}/`);
    const key = list.keys.find((k) => k.endsWith(`.${format}`));
    obj = key ? await store.get(key) : null;
  }
  if (!obj) throw new HttpError(404, 'File missing');
  const download = c.req.query('inline') !== '1';
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.contentType ?? 'application/octet-stream',
      ...(download ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
      'Cache-Control': 'private, no-store',
    },
  });
});

// Live updates: WebSocket handled by the project's Durable Object.
app.get('/api/projects/:id/live', async (c) => {
  await requireProject(c.env, c.get('owner').userId, c.req.param('id'));
  if (c.req.header('upgrade') !== 'websocket') throw new HttpError(426, 'Expected WebSocket');
  const stub = c.env.PROJECT_ROOM.get(c.env.PROJECT_ROOM.idFromName(c.req.param('id')));
  return stub.fetch(c.req.raw);
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// ---------------------------------------------------------------- SPA

app.get('*', async (c) => {
  // Static assets are served before the Worker runs; anything else is the app shell.
  const url = new URL(c.req.url);
  url.pathname = '/';
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});
