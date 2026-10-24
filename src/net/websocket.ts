// Transport over a WebSocket to the relay (server/relay-core.ts, protocol in
// src/net/relay.ts). The relay pairs two sockets under a room code and
// forwards `relay` envelopes between them; this class wraps every message in
// one, so Lockstep and the room handshake run on it unchanged.
//
// Reconnect: when the socket drops after we hold a seat, it reconnects with
// exponential backoff and resumes the seat with its token. Messages sent
// while disconnected are dropped, which lockstep tolerates (every input
// message re-sends what the peer hasn't acknowledged). If the drop outlasts
// `giveUpMs`, or the relay refuses us (wrong version, room full, seat gone),
// the status goes to 'closed' and stays there.
//
// The WebSocket constructor and timers are injectable so tests/websocket.test.ts
// can drive it without a network.

import { PROTOCOL, type ErrorCode, type PeerState, type ServerMsg } from './relay.ts';
import { Listeners, type Transport } from './transport.ts';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type LinkEvent =
  | { type: 'status'; status: NetStatus }
  /** We hold a seat (first time, or again after a resume). */
  | { type: 'room'; code: string; seat: 0 | 1 }
  | { type: 'peer'; s: PeerState; why?: string }
  /** The link is over for this reason ('network' = could not reach or get back to the relay). */
  | { type: 'error'; code: ErrorCode | 'network'; msg: string };

/** The parts of the browser WebSocket this class uses. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

export interface WebSocketTransportOptions {
  url: string;
  /** Build identity; the relay refuses to pair different versions. See netVersion(). */
  version: string;
  /** Host a new room, or join one by code. */
  role: { host: true } | { join: string };
  connect?: (url: string) => SocketLike;
  timers?: Timers;
  random?: () => number;
  /** Heartbeat interval. The relay drops sockets silent for 30 s. */
  pingMs?: number;
  /** Give up reconnecting after this long. Default 25 s (the relay holds a seat 30 s). */
  giveUpMs?: number;
  /** Give up on the very first connection after this long. Default 8 s. */
  firstConnectMs?: number;
}

const OPEN = 1;
const BACKOFF_MIN = 250;
const BACKOFF_MAX = 4000;

/** What the relay compares in host/join: the relay protocol plus the sim and replay versions (src/net/room.ts). */
export function netVersion(sim: number, replay: number): string {
  return `p${PROTOCOL}.s${sim}.r${replay}`;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class WebSocketTransport<M> implements Transport<M> {
  status: NetStatus = 'connecting';
  code: string | null = null;
  seat: 0 | 1 | null = null;
  /** The other seat as the relay last described it. */
  peer: 'none' | 'here' | 'away' | 'left' = 'none';
  /** Why the link closed, once it has. */
  error: { code: ErrorCode | 'network'; msg: string } | null = null;
  /** Successful resumes, for stats and tests. */
  resumes = 0;
  /** The build identity sent in host/join. */
  readonly version: string;

  private ws: SocketLike | null = null;
  private token: string | null = null;
  private listeners = new Listeners<M>();
  private events = new Listeners<LinkEvent>();
  private timers: Timers;
  private connectFn: (url: string) => SocketLike;
  private random: () => number;
  private pingMs: number;
  private giveUpMs: number;
  private firstConnectMs: number;
  private attempt = 0;
  private downSince: number;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private pingN = 0;

  constructor(private o: WebSocketTransportOptions) {
    this.version = o.version;
    this.timers = o.timers ?? defaultTimers;
    this.connectFn = o.connect ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = o.random ?? Math.random;
    this.pingMs = o.pingMs ?? 5000;
    this.giveUpMs = o.giveUpMs ?? 25_000;
    this.firstConnectMs = o.firstConnectMs ?? 8000;
    this.downSince = this.timers.now();
    this.dial();
  }

  send(m: M): void {
    if (this.status !== 'open' || !this.ws || this.ws.readyState !== OPEN) return;
    this.raw({ t: 'relay', m });
  }

  onMessage(fn: (m: M) => void): () => void {
    return this.listeners.add(fn);
  }

  /** Status changes, room and peer notices, and the final error. */
  onEvent(fn: (e: LinkEvent) => void): () => void {
    return this.events.add(fn);
  }

  /** Leave the room for good (the opponent is told at once) and close. */
  close(): void {
    if (this.status === 'closed') return;
    if (this.ws?.readyState === OPEN) this.raw({ t: 'leave' });
    this.shutdown(null);
    this.listeners.clear();
  }

  /** Cut the socket as a network failure would, without leaving: for tests and the e2e hook. */
  drop(): void {
    this.ws?.close(4001, 'dropped');
  }

  // -------------------------------------------------------------------------

  private dial(): void {
    let ws: SocketLike;
    try {
      ws = this.connectFn(this.o.url);
    } catch (e) {
      this.shutdown({ code: 'network', msg: `Could not open a connection to the match server (${e instanceof Error ? e.message : String(e)}).` });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.token && this.code !== null && this.seat !== null) this.raw({ t: 'resume', code: this.code, seat: this.seat, token: this.token });
      else if ('host' in this.o.role) this.raw({ t: 'host', v: this.o.version });
      else this.raw({ t: 'join', code: this.o.role.join, v: this.o.version });
      this.schedulePing();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') this.receive(msg);
    };
    ws.onerror = () => {
      /* a close follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.lost();
    };
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'relay':
        // Whatever the peer sent: only objects get through; their contents are checked by the receivers.
        if (msg.m && typeof msg.m === 'object' && !Array.isArray(msg.m)) this.listeners.emit(msg.m as M);
        return;
      case 'hosted':
      case 'joined':
        this.code = msg.code;
        this.seat = msg.seat;
        this.token = msg.token;
        this.opened();
        this.emit({ type: 'room', code: msg.code, seat: msg.seat });
        return;
      case 'resumed':
        this.resumes++;
        this.opened();
        this.emit({ type: 'room', code: msg.code, seat: msg.seat });
        if (msg.peer && this.peer === 'away') this.peerIs('back');
        return;
      case 'peer':
        this.peerIs(msg.s, msg.why);
        return;
      case 'error':
        // Every relay error ends the link; the socket close that follows must not trigger a reconnect.
        this.shutdown({ code: msg.code, msg: msg.msg });
        return;
      case 'pong':
        return;
    }
  }

  private peerIs(s: PeerState, why?: string): void {
    this.peer = s === 'joined' || s === 'back' ? 'here' : s;
    this.emit(why ? { type: 'peer', s, why } : { type: 'peer', s });
  }

  private opened(): void {
    this.attempt = 0;
    this.setStatus('open');
  }

  /** The socket closed without us asking. */
  private lost(): void {
    this.clearPing();
    if (this.status === 'closed') return;
    const now = this.timers.now();
    if (this.status === 'open') this.downSince = now;
    const limit = this.token ? this.giveUpMs : this.firstConnectMs;
    if (now - this.downSince >= limit) {
      this.shutdown({
        code: 'network',
        msg: this.token ? 'Lost the connection to the match server and could not get it back.' : 'Could not reach the match server. Check your connection and try again.',
      });
      return;
    }
    if (this.token) this.setStatus('reconnecting');
    const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.attempt++);
    const wait = Math.min(base * (0.75 + 0.5 * this.random()), Math.max(0, limit - (now - this.downSince)));
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.status !== 'closed') this.dial();
    }, wait);
  }

  private shutdown(error: { code: ErrorCode | 'network'; msg: string } | null): void {
    if (this.status === 'closed') return;
    this.clearPing();
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'bye');
    } catch {
      /* already closing */
    }
    this.error = error;
    this.setStatus('closed');
    if (error) this.emit({ type: 'error', ...error });
  }

  private schedulePing(): void {
    this.clearPing();
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = null;
      if (this.ws?.readyState !== OPEN) return;
      this.raw({ t: 'ping', n: ++this.pingN });
      this.schedulePing();
    }, this.pingMs);
  }

  private clearPing(): void {
    if (this.pingTimer !== null) this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit({ type: 'status', status: s });
  }

  private emit(e: LinkEvent): void {
    this.events.emit(e);
  }

  private raw(msg: object): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* closing; onclose will follow */
    }
  }
}
