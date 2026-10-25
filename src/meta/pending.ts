// A match that kicked off but was never recorded: the tab closed, the page
// reloaded or the browser crashed mid-match. Without this, closing the tab was
// a free undo for any ranked, cup or league result.
//
// The client marks the match at kick-off (beginMatch, persisted before the
// match mounts) and any recorded result clears it (applyResult). On the next
// boot settleAbandoned records whatever is still marked exactly like the pause
// menu's forfeit: 0–3, Elo lost, no money, XP or sessions. Friendlies record
// nothing either way. A real crash is possible, so the player is told plainly
// what happened and why it counts.

import { applyResult, signed, type Save } from './game.ts';
import { cupOpponent, recordCupMatch, recordSeasonMatch, seasonOpponent } from './competitions.ts';
import { maybeRollover } from './progression.ts';

export interface PendingMatch {
  kind: 'ranked' | 'cup' | 'league' | 'friendly';
  /** The opponent's ladder id (ranked), for the forfeit's Elo. */
  opponentId?: string;
  opponent: string;
  /** Shown in the message: "Ranked", "Cup semi-final", "League matchday 3". */
  label: string;
}

/** Mark a match as under way. Persist the save right after, before the match starts. */
export function beginMatch(save: Save, m: PendingMatch): void {
  save.pending = { ...m };
}

/** Forget the mark without recording anything (a friendly, or a match that never started). */
export function clearPending(save: Save): void {
  save.pending = null;
}

export interface Settled {
  /** For a toast: what happened and what it cost. */
  message: string;
  eloDelta: number;
}

/**
 * Record the match left unfinished last time, if any, as a 0–3 forfeit, and
 * clear the mark. Returns the message to show, or null when nothing was
 * pending (or it was a friendly). Run on boot, after the save's fields are
 * filled in.
 */
export function settleAbandoned(save: Save): Settled | null {
  const p = save.pending;
  if (!p) return null;
  save.pending = null;
  const before = save.club.elo;
  let recorded = false;
  if (p.kind === 'ranked') {
    const opp = save.ladder.find((c) => c.id === p.opponentId);
    if (opp) {
      applyResult(save, opp, { name: opp.name, short: opp.short }, 0, 3, true, [], undefined, true);
      recorded = true;
    }
  } else if (p.kind === 'cup' && save.cup && cupOpponent(save, save.cup)?.name === p.opponent) {
    recordCupMatch(save, 0, 3, [], undefined, true);
    recorded = true;
  } else if (p.kind === 'league' && save.season && seasonOpponent(save, save.season)?.name === p.opponent) {
    recordSeasonMatch(save, 0, 3, [], undefined, true);
    recorded = true;
  }
  if (!recorded) return null;
  maybeRollover(save);
  const delta = save.club.elo - before;
  const cost = delta ? `Elo ${signed(delta)}, ` : '';
  return {
    eloDelta: delta,
    message: `Your ${p.label.toLowerCase()} match against ${p.opponent} didn't finish (the page was closed or reloaded), so it counts as a 0–3 forfeit: ${cost}no XP and no money. Matches are saved when the final whistle goes.`,
  };
}
