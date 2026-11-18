/**
 * Object storage on Amazon S3 (SigV4 via aws4fetch). Every key is stored under
 * S3_PREFIX (default "jibun/") so Jibun can share a bucket safely. Objects are
 * private; the Worker streams them to the signed-in owner only.
 */
import { AwsClient } from 'aws4fetch';
import type { Env } from './env';

export interface StoredObject {
  body: ReadableStream;
  contentType: string | null;
  size: number | null;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array | ArrayBuffer, opts?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
}

class S3Store implements ObjectStore {
  private client: AwsClient;
  private base: string;
  constructor(
    env: Env,
    private prefix: string,
  ) {
    this.client = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, region: env.S3_REGION, service: 's3' });
    // Virtual-hosted style for AWS; path style when a custom S3-compatible endpoint is given.
    const custom = env.S3_ENDPOINT?.replace(/\/$/, '');
    this.base = custom ? `${custom}/${encodeURIComponent(env.S3_BUCKET!)}` : `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  }

  private url(key: string) {
    return `${this.base}/${(this.prefix + key).split('/').map(encodeURIComponent).join('/')}`;
  }

  private async send(url: string, init: RequestInit, ok: number[] = [200]): Promise<Response> {
    let last: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.client.fetch(url, init);
      if (ok.includes(res.status)) return res;
      last = res;
      // Retry throttling and transient server errors with backoff.
      if (res.status !== 503 && res.status !== 500 && res.status !== 429) break;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
    const text = last ? await last.text().catch(() => '') : '';
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(last?.status);
    throw new Error(`Storage request failed (${code})`);
  }

  async put(key: string, body: Uint8Array | ArrayBuffer, opts: { contentType?: string; metadata?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'Content-Type': opts.contentType ?? 'application/octet-stream' };
    for (const [k, v] of Object.entries(opts.metadata ?? {})) headers[`x-amz-meta-${k.toLowerCase()}`] = v;
    const res = await this.send(this.url(key), { method: 'PUT', headers, body: body as BodyInit });
    await res.body?.cancel();
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await this.send(this.url(key), { method: 'GET' }, [200, 404, 403]);
    if (res.status !== 200) {
      await res.body?.cancel();
      if (res.status === 403) throw new Error('Storage access denied');
      return null;
    }
    const len = res.headers.get('content-length');
    return { body: res.body!, contentType: res.headers.get('content-type'), size: len ? Number(len) : null };
  }

  async list(prefix: string, cursor?: string) {
    const q = new URLSearchParams({ 'list-type': '2', prefix: this.prefix + prefix, 'max-keys': '1000' });
    if (cursor) q.set('continuation-token', cursor);
    const res = await this.send(`${this.base}?${q}`, { method: 'GET' });
    const xml = await res.text();
    const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unescape(m[1]!).slice(this.prefix.length));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    return { keys, cursor: truncated && next ? unescape(next) : undefined };
  }

  async delete(keys: string[]) {
    // DeleteObjects removes up to 1,000 keys per request (Content-MD5 is required).
    const esc = (k: string) => k.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    for (let i = 0; i < keys.length; i += 1000) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys
        .slice(i, i + 1000)
        .map((k) => `<Object><Key>${esc(this.prefix + k)}</Key></Object>`)
        .join('')}</Delete>`;
      const body = new TextEncoder().encode(xml);
      const md5 = new Uint8Array(await crypto.subtle.digest('MD5', body));
      const res = await this.send(`${this.base}/?delete`, { method: 'POST', headers: { 'Content-Type': 'application/xml', 'Content-MD5': btoa(String.fromCharCode(...md5)) }, body });
      const text = await res.text();
      if (/<Error>/.test(text)) throw new Error(`Storage delete failed (${/<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? 'unknown'})`);
    }
  }
}

/** In-memory store for local development without AWS credentials. */
const memory = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
class MemoryStore implements ObjectStore {
  async put(key: string, body: Uint8Array | ArrayBuffer, opts: { contentType?: string } = {}) {
    memory.set(key, { bytes: new Uint8Array(body instanceof ArrayBuffer ? body : body.slice()), contentType: opts.contentType ?? null });
  }
  async get(key: string) {
    const o = memory.get(key);
    if (!o) return null;
    return { body: new Response(o.bytes as BodyInit).body!, contentType: o.contentType, size: o.bytes.length };
  }
  async list(prefix: string) {
    return { keys: [...memory.keys()].filter((k) => k.startsWith(prefix)) };
  }
  async delete(keys: string[]) {
    for (const k of keys) memory.delete(k);
  }
}

export function storage(env: Env): ObjectStore {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.S3_BUCKET && env.S3_REGION) {
    const prefix = env.S3_PREFIX ?? 'jibun/';
    return new S3Store(env, prefix.endsWith('/') || !prefix ? prefix : prefix + '/');
  }
  if (env.DEV_MEMORY_STORAGE === '1' && ['localhost', '127.0.0.1'].includes(new URL(env.BETTER_AUTH_URL).hostname)) return new MemoryStore();
  throw new Error('Object storage is not configured (set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET and S3_REGION).');
}

export async function deletePrefix(store: ObjectStore, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await store.list(prefix, cursor);
    if (page.keys.length) await store.delete(page.keys);
    cursor = page.cursor;
  } while (cursor);
}
