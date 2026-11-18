/**
 * Remote MCP server, protected by OAuth 2.1 (workers-oauth-provider).
 *
 * MCP clients register dynamically, send the person to /oauth/authorize, where
 * the normal Jibun session is required and an explicit
 * consent screen is shown. Tokens are then accepted at /mcp.
 */
import { AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { normaliseSettings } from '../shared/font/build';
import { PRESETS, keysToWrite } from '../shared/unicode';
import { getOwner } from './auth';
import { HttpError, createPages, getBuild, getProjectDetail, listBuilds, listProjects, parseFormats, requestBuild, setCharacters, updateProject } from './db';
import type { Env, Owner } from './env';

export const MCP_SCOPES = ['fonts:read', 'fonts:write'];

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, inner: string, status = 200, headers = new Headers()) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--black:#0A0A0A;--blue:#2563EB;--g50:#FAFAFA;--g200:#E5E5E5;--g500:#737373;--g700:#404040;--r:14px}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--g50);color:var(--black);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:440px;background:#fff;border:1px solid var(--g200);border-radius:var(--r);padding:32px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.04)}
h1{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:30px;line-height:1.15;margin:0 0 12px}
p{color:var(--g700);margin:0 0 12px}.muted{color:var(--g500);font-size:14px}
ul{padding:0;margin:16px 0;list-style:none}li{padding:10px 12px;border:1px solid var(--g200);border-radius:10px;margin-bottom:8px;font-size:14px}
.warn{background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;padding:10px 12px;font-size:14px;color:#9A3412}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;height:44px;border-radius:10px;font:inherit;font-weight:500;cursor:pointer;border:1px solid var(--g200);background:#fff;color:var(--black)}
button.primary{background:var(--black);color:#fff;border-color:var(--black)}button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
</style></head><body><main>${inner}</main></body></html>`,
    { status, headers },
  );
}

const SCOPE_TEXT: Record<string, string> = {
  'fonts:read': 'See your fonts, captured characters and export history',
  'fonts:write': 'Change font settings and character sets, create sheets and start font builds',
  offline_access: 'Stay connected without asking again',
};

function consentPage(d: ConsentDescription, handle: string) {
  const name = esc(d.clientName);
  const origin = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : 'This app registered itself, so its name is not verified.';
  const scopes = d.scope.map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)}<input type="hidden" name="scope" value="${esc(s)}"></li>`).join('');
  return `<h1>Connect ${name} to Jibun?</h1>
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}"><ul>${scopes}</ul>
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow</button></div></form>
`;
}

export async function authorizeHandler(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const req = c.req.raw;
  const oauth = env.OAUTH_PROVIDER;
  try {
    const url = new URL(req.url);
    const owner = await getOwner(env, req.headers);
    if (!owner) {
      if (req.method !== 'GET') return page('Sign in', '<h1>Sign in first</h1><p>Your session ended. Start connecting again.</p>', 401);
      const next = url.pathname + url.search;
      return Response.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, url).toString(), 302);
    }
    if (req.method === 'GET') {
      const authReq = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      return page('Connect to Jibun', consentPage(details, consent.handle), 200, consent.headers);
    }
    const form = await req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(req, handle, { scope: form.getAll('scope').map(String) });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: owner.userId,
      metadata: { label: 'MCP' },
      scope: approved.request.scope,
      props: { userId: owner.userId, email: owner.email } satisfies Owner,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return page('Could not connect', `<h1>Could not connect</h1><p>${esc(message ?? 'The request was not valid.')}</p>`, 400);
    }
    throw error;
  }
}

// ------------------------------------------------------------------ MCP server

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

function buildServer(env: Env, owner: Owner, scopes: string[]) {
  const server = new McpServer({ name: 'jibun', version: '1.0.0' }, { instructions: 'Jibun turns handwriting into fonts. Use these tools to inspect fonts, edit character sets and settings, create rewrite sheets and export fonts.' });
  const canWrite = scopes.includes('fonts:write');
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A) => {
    try {
      return await fn(...a);
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e);
      return { ...text(`Error: ${msg}`), isError: true };
    }
  };

  server.registerTool('list_fonts', { description: 'List every font project with capture progress and its latest build.', inputSchema: {}, annotations: { readOnlyHint: true } }, guard(async () => text(await listProjects(env, owner.userId))));

  server.registerTool(
    'get_font',
    {
      description: 'Details for one font: settings, which characters are missing, which samples are flagged for review, ligatures and pages.',
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ projectId }) => {
      const d = await getProjectDetail(env, owner.userId, projectId);
      const okKeys = new Set(d.samples.filter((s) => s.status !== 'rejected').map((s) => s.key));
      const { write, composed } = keysToWrite(
        d.characters.map((c) => c.key),
        d.project.settings.autoCompose,
      );
      return text({
        project: d.project,
        characters: d.characters.length,
        missing: write.filter((k) => !okKeys.has(k)),
        composedAutomatically: composed.length,
        flagged: d.samples.filter((s) => s.status === 'flagged').map((s) => ({ id: s.id, key: s.key, flags: s.flags, confidence: s.confidence })),
        ligatures: d.ligatures,
        pages: d.pages.map((p) => ({ id: p.id, kind: p.kind, page: `${p.pageNumber}/${p.pageCount}`, processed: !!p.processedAt })),
      });
    }),
  );

  server.registerTool('list_presets', { description: 'Character set presets that can be added to a font.', inputSchema: {}, annotations: { readOnlyHint: true } }, guard(async () =>
    text(PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description, count: p.keys().length }))),
  ));

  server.registerTool('list_exports', { description: 'Export history across all fonts.', inputSchema: { projectId: z.string().optional() }, annotations: { readOnlyHint: true } }, guard(async ({ projectId }) =>
    text(await listBuilds(env, owner.userId, projectId, 100)),
  ));

  server.registerTool('get_export', { description: 'Status and report of one export build.', inputSchema: { buildId: z.string() }, annotations: { readOnlyHint: true } }, guard(async ({ buildId }) =>
    text(await getBuild(env, owner.userId, buildId)),
  ));

  if (!canWrite) return server;

  server.registerTool(
    'update_font_settings',
    {
      description: 'Change the family name or global metrics. Units are font units (1000 per em).',
      inputSchema: {
        projectId: z.string(),
        name: z.string().max(80).optional(),
        familyName: z.string().max(60).optional(),
        sidebearing: z.number().optional(),
        tracking: z.number().optional(),
        baselineShift: z.number().optional(),
        scale: z.number().optional(),
        spaceWidth: z.number().optional(),
        kerning: z.boolean().optional(),
        alternates: z.boolean().optional(),
        autoCompose: z.boolean().optional(),
      },
    },
    guard(async ({ projectId, name, ...settings }) => {
      await updateProject(env, owner.userId, projectId, { name, settings });
      return text((await getProjectDetail(env, owner.userId, projectId)).project.settings);
    }),
  );

  server.registerTool(
    'add_characters',
    {
      description: 'Add characters to a font, from preset ids and/or literal text. Existing characters are kept.',
      inputSchema: { projectId: z.string(), presets: z.array(z.string()).optional(), text: z.string().optional() },
    },
    guard(async ({ projectId, presets, text: t }) => {
      const d = await getProjectDetail(env, owner.userId, projectId);
      const add: string[] = [];
      for (const id of presets ?? []) {
        const p = PRESETS.find((x) => x.id === id);
        if (!p) throw new HttpError(400, `Unknown preset ${id}`);
        add.push(...p.keys());
      }
      if (t) add.push(...Array.from(t.normalize('NFC')).filter((ch) => ch.trim()));
      await setCharacters(env, owner.userId, projectId, [...d.characters.map((c) => c.key), ...add]);
      const after = await getProjectDetail(env, owner.userId, projectId);
      return text({ characters: after.characters.length, added: after.characters.length - d.characters.length });
    }),
  );

  server.registerTool(
    'create_rewrite_sheet',
    {
      description: 'Create a small sheet holding only the flagged (or given) characters. Returns page ids; the PDF is printed from the Jibun app.',
      inputSchema: { projectId: z.string(), keys: z.array(z.string()).optional() },
    },
    guard(async ({ projectId, keys }) => {
      const d = await getProjectDetail(env, owner.userId, projectId);
      const list = keys?.length ? keys : [...new Set(d.samples.filter((s) => s.status === 'flagged').map((s) => s.key))];
      const pages = await createPages(env, owner.userId, projectId, 'rewrite', list);
      return text({ pages: pages.map((p) => ({ id: p.id, cells: p.cells.length })), open: `${env.BETTER_AUTH_URL}/fonts/${projectId}/capture` });
    }),
  );

  server.registerTool(
    'export_font',
    {
      description: 'Start building the font. Returns the build; poll get_export until status is done. Download links require the Jibun web session.',
      inputSchema: { projectId: z.string(), formats: z.array(z.enum(['ttf', 'otf', 'woff2'])).optional() },
    },
    guard(async ({ projectId, formats }) => {
      const b = await requestBuild(env, owner.userId, projectId, parseFormats(formats));
      return text({ ...b, downloads: `${env.BETTER_AUTH_URL}/fonts/${projectId}/export` });
    }),
  );

  void normaliseSettings;
  return server;
}

/** Handler for requests under /mcp, called by OAuthProvider with validated props. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Owner; auth?: { scope: string[] } }) {
    const props = ctx.props;
    if (!props?.userId || !ctx.auth?.scope.includes('fonts:read')) return new Response('Forbidden', { status: 403 });
    const scopes = ctx.auth.scope;
    const server = buildServer(env, props, scopes);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      ctx.waitUntil(server.close());
    }
  },
};
