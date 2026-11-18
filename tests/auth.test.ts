import { describe, expect, it } from 'vitest';
import { PUBLIC_AUTH_ROUTES, createAuth } from '../src/worker/auth';
import { hashPassword, verifyPassword } from '../src/shared/password';
import type { Env } from '../src/worker/env';

function fakeEnv(): Env {
  const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), raw: async () => [], run: async () => ({ meta: {} }) };
  const db = { prepare: () => stmt, batch: async (s: unknown[]) => s.map(() => ({ results: [] })), exec: async () => ({}), dump: async () => new ArrayBuffer(0) };
  return {
    DB: db as unknown as D1Database,
    BETTER_AUTH_URL: 'https://jibun.example',
    BETTER_AUTH_SECRET: 'x'.repeat(40),
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
  } as Env;
}

describe('public accounts', () => {
  it('enables rate-limited email signup and protects existing credentials during social sign-in', () => {
    const auth = createAuth(fakeEnv());
    expect(PUBLIC_AUTH_ROUTES.has('/api/auth/sign-up/email')).toBe(true);
    expect(auth.options.emailAndPassword.enabled).toBe(true);
    expect(auth.options.rateLimit?.customRules?.['/sign-up/email']).toMatchObject({ max: 5 });
    expect(auth.options.account?.accountLinking?.requireLocalEmailVerified).toBe(true);
  });

  it('omits Google when its keys are not set', () => {
    const auth = createAuth({ ...fakeEnv(), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    expect(auth.options.socialProviders?.google).toBeUndefined();
  });

  it('hashes and verifies passwords with PBKDF2', async () => {
    const pw = crypto.randomUUID();
    const h = await hashPassword(pw);
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(h).not.toContain(pw);
    expect(await verifyPassword({ hash: h, password: pw })).toBe(true);
    expect(await verifyPassword({ hash: h, password: pw + 'x' })).toBe(false);
    expect(await verifyPassword({ hash: 'garbage', password: pw })).toBe(false);
    expect(await hashPassword(pw)).not.toBe(h); // salted
  });
});
