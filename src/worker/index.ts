import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { app } from './api';
import { handleBuildBatch } from './builder';
import type { BuildMessage, Env } from './env';
import { MCP_SCOPES, mcpApiHandler } from './mcp';

export { ProjectRoom } from './room';

function provider(env: Env) {
  const origin = env.BETTER_AUTH_URL.replace(/\/$/, '');
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpApiHandler as never,
    defaultHandler: { fetch: (req: Request, e: Env, ctx: ExecutionContext) => app.fetch(req, e, ctx) } as never,
    authorizeEndpoint: '/oauth/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [...MCP_SCOPES, 'offline_access'],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    requiredScopes: ['fonts:read'],
    accessTokenTTL: 60 * 60,
  });
}

let cached: { key: string; p: ReturnType<typeof provider> } | null = null;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!cached || cached.key !== env.BETTER_AUTH_URL) cached = { key: env.BETTER_AUTH_URL, p: provider(env) };
    return cached.p.fetch(request, env, ctx);
  },
  queue(batch: MessageBatch<BuildMessage>, env: Env) {
    return handleBuildBatch(batch, env);
  },
} satisfies ExportedHandler<Env, BuildMessage>;
