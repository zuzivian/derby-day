// Bun WebSocket adapter for the relay (server/relay-core.ts).
//
//   bun server/bun.ts                       listen on PORT (default 8787)
//   PORT=0 bun server/bun.ts                any free port; the first line printed says which
//
// Routes: GET /health (JSON stats, for load balancers and uptime checks),
// GET / (a one-line hello), and a WebSocket upgrade on any path (the client uses /ws).
// Everything is configured by environment variables, see docs/ONLINE.md:
//   PORT, HOST            where to listen (HOST default 0.0.0.0)
//   ALLOWED_ORIGINS       comma-separated Origin allow-list, e.g. https://derby.natwong.dev.
//                         Empty allows every origin (fine locally; set it in production).
//   TRUST_PROXY=1         take the client address from Fly-Client-IP / X-Forwarded-For
//                         (only behind a proxy that sets them, or clients can spoof the per-IP limit)
//   RELAY_MAX_ROOMS, RELAY_MAX_SOCKETS, RELAY_MAX_SOCKETS_PER_IP, RELAY_MAX_FRAME_BYTES,
//   RELAY_RATE_PER_SEC, RELAY_BURST, RELAY_GRACE_MS, ...   any field of RelayLimits, in SCREAMING_SNAKE_CASE

import { DEFAULT_LIMITS, RelayCore, type RelayLimits, type RelaySocket } from './relay-core.ts';
import { PROTOCOL } from '../src/net/relay.ts';
import { originAllowed } from './origin.ts';

export interface ServeOptions {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  trustProxy?: boolean;
  limits?: Partial<RelayLimits>;
  quiet?: boolean;
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

/** RelayLimits overrides from RELAY_* variables. */
export function limitsFromEnv(env: Record<string, string | undefined>): Partial<RelayLimits> {
  const out: Partial<RelayLimits> = {};
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof RelayLimits)[]) {
    const raw = env[`RELAY_${snake(k)}`];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`RELAY_${snake(k)} must be a non-negative number, got "${raw}"`);
    out[k] = n;
  }
  return out;
}

interface WsData {
  sock: RelaySocket;
  ip: string;
}

export function startRelay(o: ServeOptions = {}) {
  const allowed = (o.allowedOrigins ?? []).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const log = o.quiet ? undefined : (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
  const core = new RelayCore({ now: () => Date.now(), random: Math.random, token: () => crypto.randomUUID(), limits: o.limits, log });
  const startedAt = Date.now();

  const server = Bun.serve<WsData>({
    port: o.port ?? 8787,
    hostname: o.host ?? '0.0.0.0',
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (!originAllowed(req.headers.get('origin'), allowed)) return new Response('Origin not allowed', { status: 403 });
        const fwd = o.trustProxy ? req.headers.get('fly-client-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : null;
        const ip = fwd || srv.requestIP(req)?.address || '';
        const data = { ip } as WsData;
        if (srv.upgrade(req, { data })) return undefined;
        return new Response('Expected a WebSocket', { status: 400 });
      }
      if (url.pathname === '/health') {
        return Response.json({ ok: true, protocol: PROTOCOL, uptimeS: Math.round((Date.now() - startedAt) / 1000), ...core.stats() }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/') return new Response('Derby Day relay. Connect with a WebSocket; GET /health for status.\n');
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      // Bun enforces the cap itself too (closing with 1009), before the frame is buffered.
      maxPayloadLength: core.limits.maxFrameBytes,
      idleTimeout: Math.ceil(core.limits.heartbeatMs / 1000) + 10,
      open(ws) {
        ws.data.sock = { send: (t) => void ws.send(t), close: (code, reason) => ws.close(code, reason) };
        core.open(ws.data.sock, ws.data.ip);
      },
      message(ws, msg) {
        const text = typeof msg === 'string' ? msg : new TextDecoder().decode(msg);
        core.message(ws.data.sock, text, typeof msg === 'string' ? Buffer.byteLength(msg) : msg.byteLength);
      },
      close(ws) {
        core.close(ws.data.sock);
      },
    },
  });
  const sweep = setInterval(() => core.sweep(), 1000);
  if (!o.quiet && !allowed.length) console.warn('ALLOWED_ORIGINS is empty: accepting WebSockets from any origin.');
  return {
    port: server.port,
    core,
    stop() {
      clearInterval(sweep);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const env = process.env;
  const relay = startRelay({
    port: env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 8787,
    host: env.HOST || '0.0.0.0',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(','),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    limits: limitsFromEnv(env),
    quiet: env.RELAY_QUIET === '1',
  });
  // Tests read this line to find the port.
  console.log(`relay listening on port ${relay.port}`);
  const shutdown = () => {
    relay.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
