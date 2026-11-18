import { betterAuth } from 'better-auth';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../shared/password';
import type { Env, Owner } from './env';

export function createAuth(env: Env) {
  const baseURL = env.BETTER_AUTH_URL;
  const secure = baseURL.startsWith('https://');
  return betterAuth({
    appName: 'Jibun',
    baseURL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [baseURL],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 256,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    // Google stays available as a second method once its keys are set.
    socialProviders: googleConfigured(env)
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            prompt: 'select_account',
          },
        }
      : {},
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: { '/sign-up/email': { window: 300, max: 5 }, '/sign-in/email': { window: 300, max: 5 }, '/sign-in/social': { window: 60, max: 10 } },
    },
    account: {
      accountLinking: { enabled: true, requireLocalEmailVerified: true, trustedProviders: ['google'], allowDifferentEmails: false },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, secure },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export function googleConfigured(env: Env) {
  return !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CLIENT_ID !== 'dev';
}

/** Better Auth endpoints that may be reached from outside. Everything else is 404. */
export const PUBLIC_AUTH_ROUTES = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-in/social', '/api/auth/callback/google', '/api/auth/get-session', '/api/auth/sign-out', '/api/auth/error', '/api/auth/ok']);

export async function getOwner(env: Env, headers: Headers): Promise<Owner | null> {
  const session = await createAuth(env).api.getSession({ headers });
  return session ? { userId: session.user.id, email: session.user.email } : null;
}
