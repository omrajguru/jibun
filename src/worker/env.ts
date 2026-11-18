import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  PROJECT_ROOM: DurableObjectNamespace<import('./room').ProjectRoom>;
  BUILD_QUEUE: Queue<BuildMessage>;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;

  /** Public origin of this deployment */
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Amazon S3 storage */
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_PREFIX?: string;
  S3_ENDPOINT?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  DEV_MEMORY_STORAGE?: string;
}

export interface BuildMessage {
  buildId: string;
  projectId: string;
}

export interface Owner {
  userId: string;
  email: string;
}
