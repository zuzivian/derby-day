// Deterministic lockstep with input delay, for two peers running the same sim.
//
// Each peer owns one team. When a peer is about to simulate tick t it samples
// its local input and schedules it for tick t + delay, sending it to the other
// peer straight away. Tick t is only simulated once both inputs for t are
// known; until then the peer stalls. Because both sides apply exactly the
// same [home, away] inputs to the same starting state, both states stay
// identical, and nothing but inputs ever crosses the wire.
//
// Ticks 1..delay have no input from anyone (both sides fill them with {}), so
// a peer can always run `delay` ticks ahead of what it has heard.
//
// Robustness: every input message re-sends all inputs the peer hasn't
// acknowledged yet, and a stalled peer re-sends periodically, so reordering
// and occasional loss are harmless. BroadcastChannel and WebSocket are
// reliable anyway; this is for a future unreliable transport (WebTransport
// datagrams) and for the jittery in-memory tests.
//
// Desync detection: every `checkEvery` ticks (and at full-time) each side
// sends syncHash(state). A mismatch means the two engines disagree (a
// determinism bug, or floating point that differs between browsers); both
// sides stop and report the tick.
//
// Pure TypeScript: no DOM, no clock unless one is passed in (for ping stats and
// for noticing a silent peer; the clock never affects the sim).

import { fingerprint, step } from '../sim/match.ts';
import { hashString } from '../sim/rng.ts';
import type { HumanInput, MatchState, TeamInputs } from '../sim/types.ts';
import type { Transport } from './transport.ts';
import { cleanInput, cleanLockstepMsg } from './validate.ts';

export type LockstepMsg =
  /** Inputs for ticks from, from+1, ...; ack = highest tick of the receiver's inputs the sender has, contiguously. */
  | { t: 'in'; from: number; inputs: HumanInput[]; ack: number }
  | { t: 'fp'; tick: number; fp: number }
  | { t: 'ping'; n: number; at: number }
  | { t: 'pong'; n: number; at: number }
  | { t: 'bye' };

export interface LockstepOptions {
  state: MatchState;
  /** The team this peer controls. */
  side: 0 | 1;
  transport: Transport<LockstepMsg>;
  /** Input delay in ticks. */
  delay: number;
  /** Ticks between state hash exchanges. Default 60 (once a second). */
  checkEvery?: number;
  /** Milliseconds clock for ping stats only (never affects the sim). */
  now?: () => number;
}

export interface Desync {
  tick: number;
  mine: number;
  theirs: number;
}

/** 32-bit hash of the sim state as both peers must see it: fingerprint plus the RNG position. */
export function syncHash(s: MatchState): number {
  return hashString(`${fingerprint(s)}#${s.rng.s}`) >>> 0;
}

const RESEND_CAP = 120;

export class Lockstep {
  readonly s: MatchState;
  readonly side: 0 | 1;
  readonly delay: number;
  desync: Desync | null = null;
  peerLeft = false;
  /** Consecutive tick() calls that could not advance. */
  stallCalls = 0;
  /** Total ticks advanced and total tick() calls that stalled, for stats. */
  advanced = 0;
  stalls = 0;
  /** Smoothed round trip, ms (0 until measured). */
  rttMs = 0;
  /** Number of state hashes that matched. */
  checksPassed = 0;
  /** now() when anything last arrived from the peer (for disconnect detection, see presence.ts). */
  lastHeardAt: number;
  onDesync?: (d: Desync) => void;
  onPeerLeft?: () => void;

  private transport: Transport<LockstepMsg>;
  private checkEvery: number;
  private now: () => number;
  private local = new Map<number, HumanInput>();
  private remote = new Map<number, HumanInput>();
  /** Highest tick we have sampled (and sent) a local input for. */
  private sampledTo: number;
  /** Highest tick of the peer's inputs we hold contiguously. */
  private remoteTo: number;
  /** Highest tick of our inputs the peer says it holds contiguously. */
  private peerAck: number;
  private myFp = new Map<number, number>();
  private theirFp = new Map<number, number>();
  private pingN = 0;
  private unsubscribe: () => void;

  constructor(o: LockstepOptions) {
    this.s = o.state;
    this.side = o.side;
    this.delay = Math.max(1, Math.floor(o.delay));
    this.transport = o.transport;
    this.checkEvery = o.checkEvery ?? 60;
    this.now = o.now ?? (() => 0);
    this.lastHeardAt = this.now();
    const t0 = this.s.tick;
    for (let t = t0 + 1; t <= t0 + this.delay; t++) {
      this.local.set(t, {});
      this.remote.set(t, {});
    }
    this.sampledTo = this.remoteTo = this.peerAck = t0 + this.delay;
    this.unsubscribe = this.transport.onMessage((m) => this.receive(m as unknown));
  }

  /** True while the match can still move: no desync, peer still here, not full-time. */
  get running(): boolean {
    return !this.desync && !this.peerLeft && this.s.phase !== 'fulltime';
  }

  /**
   * Try to simulate the next tick. `sample` is called at most once per tick,
   * only when a new local input is due (for tick s.tick + 1 + delay).
   * Returns false when stalled waiting for the peer, or when stopped.
   */
  tick(sample: () => HumanInput): boolean {
    if (!this.running) return false;
    const t = this.s.tick + 1;
    if (this.sampledTo < t + this.delay) {
      this.sampledTo = t + this.delay;
      // Cleaned like the peer's inputs are, so both sides apply exactly the same values.
      this.local.set(this.sampledTo, cleanInput(sample()));
      this.flush();
      if (this.sampledTo % 30 === 0) this.transport.send({ t: 'ping', n: ++this.pingN, at: this.now() });
    }
    const theirs = this.remote.get(t);
    if (!theirs) {
      this.stalls++;
      // Re-send now and then while stuck, in case our last message was lost.
      if (this.stallCalls++ % 8 === 7) this.flush();
      return false;
    }
    this.stallCalls = 0;
    const mine = this.local.get(t)!;
    const inputs: TeamInputs = this.side === 0 ? [mine, theirs] : [theirs, mine];
    step(this.s, inputs);
    this.advanced++;
    this.remote.delete(t);
    if (this.s.tick % this.checkEvery === 0 || this.s.phase === 'fulltime') {
      const fp = syncHash(this.s);
      this.myFp.set(this.s.tick, fp);
      this.transport.send({ t: 'fp', tick: this.s.tick, fp });
      this.compare(this.s.tick);
    }
    return true;
  }

  /** Tell the peer we are leaving and stop listening. */
  leave(): void {
    this.transport.send({ t: 'bye' });
    this.dispose();
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Send every local input the peer hasn't acknowledged, plus our ack of theirs. */
  private flush(): void {
    const from = Math.max(this.peerAck + 1, this.sampledTo - RESEND_CAP + 1);
    const inputs: HumanInput[] = [];
    for (let t = from; t <= this.sampledTo; t++) inputs.push(this.local.get(t)!);
    this.transport.send({ t: 'in', from, inputs, ack: this.remoteTo });
  }

  /** True when the next tick is waiting on the peer's input. */
  get stalled(): boolean {
    return this.running && !this.remote.has(this.s.tick + 1);
  }

  /** Anything from the peer. Malformed messages and inputs for ticks it can't legitimately be at are ignored. */
  private receive(raw: unknown): void {
    const m = cleanLockstepMsg(raw);
    if (!m) return;
    this.lastHeardAt = this.now();
    switch (m.t) {
      case 'in': {
        // The peer is never more than `delay` ticks ahead of us, and schedules `delay` ahead of itself.
        const horizon = this.s.tick + 2 * this.delay + RESEND_CAP;
        for (let i = 0; i < m.inputs.length; i++) {
          const t = m.from + i;
          if (t > horizon) break;
          if (t > this.remoteTo && !this.remote.has(t)) this.remote.set(t, m.inputs[i]);
        }
        while (this.remote.has(this.remoteTo + 1)) this.remoteTo++;
        if (m.ack > this.peerAck) this.peerAck = Math.min(m.ack, this.sampledTo);
        // Inputs the peer has, at or before what we've simulated, are no longer needed.
        for (const t of this.local.keys()) if (t <= Math.min(this.peerAck, this.s.tick)) this.local.delete(t);
        return;
      }
      case 'fp':
        if (Math.abs(m.tick - this.s.tick) > 4 * RESEND_CAP) return; // nowhere near us: junk, don't store it
        this.theirFp.set(m.tick, m.fp);
        this.compare(m.tick);
        return;
      case 'ping':
        this.transport.send({ t: 'pong', n: m.n, at: m.at });
        return;
      case 'pong': {
        // Only answers to pings we sent, with a believable round trip (a forged `at` can't skew the stats).
        if (m.n < 1 || m.n > this.pingN) return;
        const rtt = this.now() - m.at;
        if (!(rtt >= 0 && rtt <= 60_000)) return;
        this.rttMs = this.rttMs ? this.rttMs * 0.8 + rtt * 0.2 : rtt;
        return;
      }
      case 'bye':
        if (this.peerLeft) return;
        this.peerLeft = true;
        this.onPeerLeft?.();
        return;
    }
  }

  private compare(tick: number): void {
    const a = this.myFp.get(tick);
    const b = this.theirFp.get(tick);
    if (a === undefined || b === undefined) return;
    this.myFp.delete(tick);
    this.theirFp.delete(tick);
    if (a === b) {
      this.checksPassed++;
      return;
    }
    if (this.desync) return;
    this.desync = { tick, mine: a, theirs: b };
    this.onDesync?.(this.desync);
  }
}
