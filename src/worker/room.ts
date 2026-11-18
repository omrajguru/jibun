/**
 * One Durable Object per project. It serialises build requests (so double
 * clicks or two tabs never start two builds), relays progress from the queue
 * consumer, and fans live events out to every open tab over hibernatable
 * WebSockets.
 */
import { DurableObject } from 'cloudflare:workers';
import type { BuildSummary, ExportFormat } from '../shared/types';
import { newId, toBuild } from './db';
import type { Env } from './env';

export class ProjectRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const progress = await this.ctx.storage.get<unknown>('progress');
    if (progress) pair[1].send(JSON.stringify(progress));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong');
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }

  async broadcast(event: unknown) {
    const msg = JSON.stringify(event);
    const e = event as { type?: string };
    if (e && e.type === 'build') await this.ctx.storage.put('progress', event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* dead socket */
      }
    }
  }

  /** Start a build unless one for these formats is already queued or running. */
  async requestBuild(projectId: string, formats: ExportFormat[]): Promise<BuildSummary> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const active = await this.env.DB.prepare(
        "SELECT * FROM builds WHERE project_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
      )
        .bind(projectId)
        .first<Parameters<typeof toBuild>[0] & { started_at: number | null }>();
      const stale = active && Date.now() - (active.started_at ?? active.created_at) > 15 * 60 * 1000;
      if (active && !stale) return toBuild(active);
      if (active && stale) {
        await this.env.DB.prepare("UPDATE builds SET status = 'failed', error = 'Timed out', finished_at = ? WHERE id = ?").bind(Date.now(), active.id).run();
      }
      const id = newId('bld');
      const now = Date.now();
      await this.env.DB.prepare("INSERT INTO builds (id, project_id, status, formats, created_at) VALUES (?, ?, 'queued', ?, ?)").bind(id, projectId, JSON.stringify(formats), now).run();
      await this.env.BUILD_QUEUE.send({ buildId: id, projectId });
      const build: BuildSummary = { id, projectId, status: 'queued', formats, glyphCount: null, error: null, createdAt: now, finishedAt: null, files: [], progress: 0 };
      await this.broadcast({ type: 'build', build });
      return build;
    });
  }
}
