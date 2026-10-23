// Transport over BroadcastChannel: two tabs of the same origin, no server.
// One channel per room code. Every message is wrapped with the sender's id,
// and, once paired, each side only listens to its peer, so a third tab on
// the same code can't inject inputs.
//
// A WebSocket relay would implement the same Transport: the server forwards
// envelopes between the two sockets in a room.

import { Listeners, type Transport } from './transport.ts';

interface Envelope<M> {
  from: string;
  m: M;
}

export type Support = { ok: true; note?: string } | { ok: false; reason: string };

/**
 * Can two tabs of this page talk? Only a heuristic: the real test is whether
 * the other tab answers. Sandboxed frames (opaque "null" origin, as in some
 * embedded viewers) can construct a channel that never reaches another tab.
 */
export function broadcastSupport(): Support {
  if (typeof BroadcastChannel === 'undefined') return { ok: false, reason: 'This browser has no BroadcastChannel, so tabs cannot talk to each other.' };
  const opaque = typeof location !== 'undefined' && location.origin === 'null' && location.protocol !== 'file:';
  if (opaque) {
    return {
      ok: false,
      reason: 'This page is running in a sandboxed viewer, where tabs cannot see each other. Build the game (bun run build) and open dist/index.html in two tabs or windows of the same browser.',
    };
  }
  try {
    new BroadcastChannel('overlap.probe').close();
  } catch {
    return { ok: false, reason: 'This page is not allowed to open a BroadcastChannel (sandboxed or storage blocked). Open dist/index.html directly in two tabs.' };
  }
  let framed = false;
  try {
    framed = window.top !== window.self;
  } catch {
    framed = true;
  }
  return framed ? { ok: true, note: 'This page is embedded in another page, which may stop tabs from reaching each other. If joining times out, open dist/index.html directly.' } : { ok: true };
}

export class BroadcastTransport<M> implements Transport<M> {
  /** Once set, messages from anyone else are ignored. */
  peer: string | null = null;
  private ch: BroadcastChannel;
  private listeners = new Listeners<M>();
  private closed = false;

  constructor(
    room: string,
    readonly id: string,
  ) {
    this.ch = new BroadcastChannel(`overlap.room.${room}`);
    this.ch.onmessage = (e: MessageEvent<Envelope<M>>) => {
      const env = e.data;
      if (!env || typeof env !== 'object' || env.from === this.id) return;
      if (this.peer && env.from !== this.peer) return;
      this.listeners.emit(env.m);
    };
  }

  send(m: M): void {
    if (this.closed) return;
    this.ch.postMessage({ from: this.id, m } satisfies Envelope<M>);
  }

  onMessage(fn: (m: M) => void): () => void {
    return this.listeners.add(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.ch.close();
  }
}
