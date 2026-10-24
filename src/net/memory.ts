// In-memory network for tests and headless experiments. Two endpoints share a
// virtual clock; each message is delivered after a seeded random latency, so
// jitter reorders packets naturally, and a seeded fraction can be dropped.
// Nothing here reads a real clock.

import { makeRng, next, type Rng } from '../sim/rng.ts';
import type { HumanInput } from '../sim/types.ts';
import type { Lockstep, LockstepMsg } from './lockstep.ts';
import { Listeners, type Transport } from './transport.ts';

export interface LinkOptions {
  seed: number;
  /** One-way latency range, ms. */
  minMs: number;
  maxMs: number;
  /** 0..1 chance each message is lost. */
  drop?: number;
}

interface InFlight<M> {
  at: number;
  seq: number;
  to: 0 | 1;
  msg: M;
}

export class MemoryNetwork<M> {
  /** Virtual time, ms. */
  now = 0;
  sent = 0;
  dropped = 0;
  private rng: Rng;
  private queue: InFlight<M>[] = [];
  private seq = 0;
  private listeners: [Listeners<M>, Listeners<M>] = [new Listeners(), new Listeners()];
  /** While false for a side, everything that side sends is dropped (a peer that went silent). */
  readonly up: [boolean, boolean] = [true, true];
  readonly ends: [Transport<M>, Transport<M>];

  constructor(private o: LinkOptions) {
    this.rng = makeRng(o.seed);
    const end = (side: 0 | 1): Transport<M> => ({
      send: (msg) => this.post(side, msg),
      onMessage: (fn) => this.listeners[side].add(fn),
      close: () => this.listeners[side].clear(),
    });
    this.ends = [end(0), end(1)];
  }

  private post(from: 0 | 1, msg: M): void {
    this.sent++;
    if (!this.up[from] || (this.o.drop && next(this.rng) < this.o.drop)) {
      this.dropped++;
      return;
    }
    const latency = this.o.minMs + (this.o.maxMs - this.o.minMs) * next(this.rng);
    // Structured clone, like BroadcastChannel and like JSON over a socket: no shared objects.
    this.queue.push({ at: this.now + latency, seq: this.seq++, to: from === 0 ? 1 : 0, msg: structuredClone(msg) });
  }

  /** Move the virtual clock forward and deliver everything that is due, in arrival order. */
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      let k = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (q.at > this.now) continue;
        if (k < 0 || q.at < this.queue[k].at || (q.at === this.queue[k].at && q.seq < this.queue[k].seq)) k = i;
      }
      if (k < 0) return;
      const [q] = this.queue.splice(k, 1);
      this.listeners[q.to].emit(q.msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Headless two-peer driver, shared by tests/lockstep.test.ts and scripts/net-probe.ts.

/** A seeded stand-in for a human: wanders the cursor, sometimes passes, shoots, sprints or switches. */
export function botInput(seed: number): () => HumanInput {
  const r = makeRng(seed);
  let x = 20 + 30 * next(r);
  let y = 5 + 30 * next(r);
  let n = 0;
  return () => {
    n++;
    x = Math.min(60, Math.max(1, x + (next(r) - 0.5) * 3));
    y = Math.min(39, Math.max(1, y + (next(r) - 0.5) * 3));
    const inp: HumanInput = { cursor: { x, y }, moved: true };
    const roll = next(r);
    if (roll < 0.03) inp.pass = true;
    else if (roll < 0.04) inp.shoot = next(r);
    else if (roll < 0.05) inp.switchPlayer = true;
    if (n % 200 < 60) inp.sprint = true;
    return inp;
  };
}

export interface DriveStats {
  /** Virtual ms until both peers reached the target tick (or gave up). */
  elapsedMs: number;
  /** Per peer: ms spent due to step but waiting for the other side. */
  stalledMs: [number, number];
}

/**
 * Run two lockstep peers over `net` in virtual time until both reach `untilTick`,
 * each rendering at 60 Hz. `run[i] === false` freezes peer i (it never ticks).
 */
export function drivePair(
  net: MemoryNetwork<LockstepMsg>,
  peers: [Lockstep, Lockstep],
  samplers: [() => HumanInput, () => HumanInput],
  untilTick: number,
  o: { maxMs?: number; run?: [boolean, boolean]; startOffsetMs?: [number, number] } = {},
): DriveStats {
  const frame = 1000 / 60;
  const acc = [-(o.startOffsetMs?.[0] ?? 0), -(o.startOffsetMs?.[1] ?? 0)];
  const stalledMs: [number, number] = [0, 0];
  const maxMs = o.maxMs ?? untilTick * frame * 4 + 5000;
  const run = o.run ?? [true, true];
  let ms = 0;
  while (ms < maxMs && (peers[0].s.tick < untilTick || peers[1].s.tick < untilTick)) {
    if (!peers[0].running && !peers[1].running) break;
    ms++;
    net.advance(1);
    for (const i of [0, 1] as const) {
      const p = peers[i];
      if (!run[i] || !p.running || p.s.tick >= untilTick) continue;
      acc[i] += 1;
      while (acc[i] >= frame && p.s.tick < untilTick) {
        if (p.tick(samplers[i])) acc[i] -= frame;
        else {
          stalledMs[i]++;
          acc[i] = Math.min(acc[i], frame);
          break;
        }
      }
    }
  }
  return { elapsedMs: ms, stalledMs };
}
