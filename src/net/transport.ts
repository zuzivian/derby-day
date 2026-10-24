// The one thing netcode needs from a network: send a message, hear messages.
// BroadcastChannel (two tabs, same origin) implements it for the demo; a
// WebSocket or WebTransport relay can implement the same interface later
// without touching the lockstep code. src/net/memory.ts is an in-memory
// version with simulated latency, jitter, reordering and loss, for tests.

export interface Transport<M> {
  /** Fire and forget. Delivery order is not guaranteed. */
  send(msg: M): void;
  /** Subscribe; returns an unsubscribe function. */
  onMessage(fn: (msg: M) => void): () => void;
  close(): void;
}

/** Minimal fan-out helper for Transport implementations. */
export class Listeners<M> {
  private fns = new Set<(msg: M) => void>();
  add(fn: (msg: M) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(msg: M): void {
    for (const fn of [...this.fns]) fn(msg);
  }
  clear(): void {
    this.fns.clear();
  }
}

/** View a transport carrying several message kinds as one that carries only the kinds `keep` accepts. */
export function narrow<All, M extends All>(tr: Transport<All>, keep: (m: All) => m is M): Transport<M> {
  return {
    send: (m) => tr.send(m),
    onMessage: (fn) => tr.onMessage((m) => keep(m) && fn(m)),
    close: () => tr.close(),
  };
}
