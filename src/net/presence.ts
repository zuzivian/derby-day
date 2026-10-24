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

export class PeerWatch {
  private lostSince: number | null = null;
  private done = false;

  constructor(readonly abandonMs = ABANDON_MS, readonly silentMs = SILENT_MS) {}

  update(i: PresenceInput): Presence {
    if (this.done) return { state: 'abandoned' };
    const lost = i.away || (i.stalled && i.now - i.lastHeardAt > this.silentMs);
    if (!lost) {
      this.lostSince = null;
      return { state: 'ok' };
    }
    this.lostSince ??= i.now;
    const remainingMs = this.abandonMs - (i.now - this.lostSince);
    if (remainingMs <= 0) {
      this.done = true;
      return { state: 'abandoned' };
    }
    return { state: 'lost', remainingMs };
  }
}
