// UNTESTED: a Cloudflare Workers + Durable Objects adapter for the relay core.
// It typechecks, but has never been deployed or run (no Cloudflare account or
// wrangler here). docs/ONLINE.md says how to try it. The Bun adapter
// (server/bun.ts) is the tested one.
//
// One Durable Object instance ("global") holds every room, which keeps room
// codes unique without coordination. A single object handles thousands of
// sockets; shard by room code before that becomes the limit. It does not use
// WebSocket hibernation, so the object stays in memory while anyone is connected.
//
// wrangler.toml:
//   main = "server/cloudflare.ts"
//   [[durable_objects.bindings]]
//   name = "RELAY"
//   class_name = "RelayObject"
//   [[migrations]]
//   tag = "v1"
//   new_classes = ["RelayObject"]
//   [vars]
//   ALLOWED_ORIGINS = "https://derby.natwong.dev"

import { RelayCore, type RelaySocket } from './relay-core.ts';
import { originAllowed } from './origin.ts';

// Just the Workers runtime types this file touches.
interface CfWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
interface Env {
  RELAY: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('Derby Day relay. Connect with a WebSocket; GET /health for status.\n');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket' && !originAllowed(req.headers.get('origin'), allowed)) return new Response('Origin not allowed', { status: 403 });
    return env.RELAY.get(env.RELAY.idFromName('global')).fetch(req);
  },
};

export class RelayObject {
  private core = new RelayCore({ now: () => Date.now(), random: Math.random, token: () => crypto.randomUUID() });
  private sweep: ReturnType<typeof setInterval> | null = null;

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === '/health') return Response.json({ ok: true, ...this.core.stats() });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 400 });
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    const sock: RelaySocket = { send: (t) => ws.send(t), close: (code, reason) => ws.close(code, reason) };
    this.core.open(sock, req.headers.get('cf-connecting-ip') ?? '');
    ws.addEventListener('message', (e) => {
      const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      this.core.message(sock, text, typeof e.data === 'string' ? new TextEncoder().encode(e.data).length : e.data.byteLength);
    });
    const closed = () => this.core.close(sock);
    ws.addEventListener('close', closed);
    ws.addEventListener('error', closed);
    this.sweep ??= setInterval(() => {
      this.core.sweep();
      if (this.core.stats().sockets === 0 && this.core.stats().rooms === 0 && this.sweep) {
        clearInterval(this.sweep);
        this.sweep = null;
      }
    }, 1000);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
}
