import type { BuildSummary, ExportFormat, FontSettings, GlyphAdjust, PageRow, ProjectDetail, ProjectSummary, SampleRow, SampleUpload } from '../../shared/types';
import type { Paper } from '../../shared/layout';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, raw?: BodyInit, contentType?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: raw ? (contentType === 'multipart' ? undefined : { 'Content-Type': contentType ?? 'application/octet-stream' }) : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'You appear to be offline. Check your connection and try again.');
  }
  if (res.status === 401) {
    if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, 'Sign in to continue');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Retry idempotent-safe operations on network failure or 5xx. */
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof ApiError && e.status !== 0 && e.status < 500) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last;
}

export const api = {
  me: () => req<{ email: string }>('GET', '/api/me'),
  projects: () => req<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (b: { name: string; keys: string[]; paper: Paper; samplesPerChar: number; settings?: Partial<FontSettings> }) => req<ProjectDetail>('POST', '/api/projects', b),
  project: (id: string) => req<ProjectDetail>('GET', `/api/projects/${id}`),
  updateProject: (id: string, b: { name?: string; paper?: Paper; samplesPerChar?: number; settings?: Partial<FontSettings> }) => req<ProjectDetail>('PATCH', `/api/projects/${id}`, b),
  deleteProject: (id: string) => req('DELETE', `/api/projects/${id}`),
  setCharacters: (id: string, keys: string[]) => req<ProjectDetail>('PUT', `/api/projects/${id}/characters`, { keys }),
  setAdjust: (id: string, key: string, adjust: GlyphAdjust | null) => req('PUT', `/api/projects/${id}/adjust`, { key, adjust }),
  createPages: (id: string, kind: 'template' | 'rewrite', keys?: string[]) => req<PageRow[]>('POST', `/api/projects/${id}/pages`, { kind, keys }),
  page: (pageId: string) => req<PageRow>('GET', `/api/pages/${pageId}`),
  uploadPdf: (id: string, batch: string, pdf: Uint8Array) => retry(() => req('PUT', `/api/projects/${id}/pdf/${batch}`, undefined, pdf as BodyInit, 'application/pdf')),
  addSamples: (id: string, pageId: string | null, samples: SampleUpload[]) => retry(() => req<SampleRow[]>('POST', `/api/projects/${id}/samples`, { pageId, samples })),
  setSampleStatus: (id: string, sid: string, status: 'ok' | 'rejected') => req('PATCH', `/api/projects/${id}/samples/${sid}`, { status }),
  addLigature: (id: string, sequence: string, overlap: number) => req<ProjectDetail>('POST', `/api/projects/${id}/ligatures`, { sequence, overlap }),
  deleteLigature: (id: string, lid: string) => req<ProjectDetail>('DELETE', `/api/projects/${id}/ligatures/${lid}`),
  backupScan: (id: string, file: Blob, pageId?: string) => req('POST', `/api/projects/${id}/scans${pageId ? `?page=${pageId}` : ''}`, undefined, file, file.type),
  build: (id: string, formats: ExportFormat[]) => req<BuildSummary>('POST', `/api/projects/${id}/builds`, { formats }),
  uploadBuild: (id: string, files: Partial<Record<ExportFormat, Uint8Array>>, report: unknown, replaces?: string) => {
    const fd = new FormData();
    for (const [f, bytes] of Object.entries(files)) fd.append(f, new Blob([bytes as BlobPart]), `font.${f}`);
    fd.append('report', JSON.stringify(report));
    if (replaces) fd.append('replaces', replaces);
    return retry(() => req<BuildSummary>('POST', `/api/projects/${id}/builds/upload`, undefined, fd as unknown as BodyInit, 'multipart'));
  },
  builds: (id?: string) => req<(BuildSummary & { projectName: string })[]>('GET', id ? `/api/projects/${id}/builds` : '/api/builds'),
  getBuild: (bid: string) => req<{ build: BuildSummary; report: unknown }>('GET', `/api/builds/${bid}`),
  fileUrl: (bid: string, f: ExportFormat) => `/api/builds/${bid}/files/${f}`,
  signOut: () => fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  authMethods: async () => {
    const res = await fetch('/api/auth-methods');
    return res.ok ? ((await res.json()) as { password: boolean; google: boolean }) : { password: true, google: false };
  },
  signUp: async (name: string, email: string, password: string) => {
    const res = await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
    });
    if (res.status === 429) throw new Error('Too many attempts. Wait a few minutes, then try again.');
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.message ?? 'Could not create your account. Please try again.');
    }
  },
  signInPassword: async (email: string, password: string) => {
    let res: Response;
    try {
      res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, rememberMe: true }),
      });
    } catch {
      throw new Error('You appear to be offline.');
    }
    if (res.status === 429) throw new Error('Too many attempts. Wait a few minutes, then try again.');
    if (!res.ok) throw new Error(res.status >= 500 ? 'Jibun could not sign you in right now. Try again shortly.' : 'That email and password do not match.');
  },
  signInGoogle: async (next: string) => {
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: next, errorCallbackURL: '/login?error=denied' }),
    });
    const data = (await res.json().catch(() => null)) as { url?: string; message?: string } | null;
    if (!res.ok || !data?.url) throw new Error(data?.message ?? 'Google sign-in is not available right now.');
    location.assign(data.url);
  },
  session: async () => {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error('Could not reach Jibun');
    return (await res.json()) as { email: string };
  },
};

/** Live project events over WebSocket, with automatic reconnect. */
export function subscribe(projectId: string, onEvent: (e: { type: string; build?: BuildSummary }) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let ping: ReturnType<typeof setInterval> | undefined;
  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/api/projects/${projectId}/live`);
    ws.onopen = () => {
      delay = 1000;
      ping = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25000);
    };
    ws.onmessage = (m) => {
      if (m.data === 'pong') return;
      try {
        onEvent(JSON.parse(m.data as string));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (!closed) setTimeout(open, (delay = Math.min(delay * 2, 15000)));
    };
  };
  open();
  return () => {
    closed = true;
    clearInterval(ping);
    ws?.close();
  };
}
