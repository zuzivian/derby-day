// Is the opponent still there? Pure: the match view feeds it the clock, the
// lockstep stall state and what the relay says, and shows what comes back.
//
//   ok         inputs are flowing (or we're only briefly waiting on them)
//   lost       the peer has gone quiet while we wait on it, or the relay says
//              its socket dropped: "Opponent disconnected, waiting N s"
//   abandoned  lost for ABANDON_MS: the match ends as an abandoned friendly
//
// Lockstep itself already pauses: with no inputs from the other side neither
// peer can advance. Coming back within the window simply resumes the match.
//
// Only time this side spends running counts towards the window: if our own
// tab freezes (backgrounded, a long GC or shader compile, a laptop lid), the
// gap is ours, not the opponent's, and doesn't eat into their 20 seconds.

/** How long a lost opponent has to come back (docs/ROADMAP.md, Phase 3 exit criteria). */
export const ABANDON_MS = 20_000;
/** Silence while stalled for this long counts as a disconnect (a frozen or crashed tab, a dead link). */
export const SILENT_MS = 2000;

export interface PresenceInput {
  now: number;
  /** Lockstep is waiting on the peer's inputs. */
  stalled: boolean;
  /** When anything last arrived from the peer. */
  lastHeardAt: number;
  /** The relay reports the peer's socket dropped (or our own link is reconnecting). */
  away: boolean;
}

export type Presence = { state: 'ok' } | { state: 'lost'; remainingMs: number } | { state: 'abandoned' };

/** Longest gap between two updates that counts in full. Longer gaps are our own tab stalling, not the peer. */
export const MAX_STEP_MS = 250;

export class PeerWatch {
  /** Time spent lost, counting only time this side was actually running. */
  private lostMs = 0;
  private lastAt: number | null = null;
  /** When we came back from a stall of our own (a frozen or backgrounded tab): silence before it isn't the peer's. */
  private resumedAt = -Infinity;
  private done = false;

  constructor(readonly abandonMs = ABANDON_MS, readonly silentMs = SILENT_MS) {}

  update(i: PresenceInput): Presence {
    if (this.done) return { state: 'abandoned' };
    const dt = this.lastAt === null ? 0 : Math.max(0, i.now - this.lastAt);
    this.lastAt = i.now;
    if (dt > MAX_STEP_MS) this.resumedAt = i.now;
    const silent = i.stalled && i.now - Math.max(i.lastHeardAt, this.resumedAt) > this.silentMs;
    if (!i.away && !silent) {
      this.lostMs = 0;
      return { state: 'ok' };
    }
    this.lostMs += Math.min(dt, MAX_STEP_MS);
    const remainingMs = this.abandonMs - this.lostMs;
    if (remainingMs <= 0) {
      this.done = true;
      return { state: 'abandoned' };
    }
    return { state: 'lost', remainingMs };
  }
}
