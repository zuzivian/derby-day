// A match that kicked off but was never recorded: the tab closed, the page
// reloaded or the browser crashed mid-match. Without this, closing the tab was
// a free undo for any ranked, cup or league result.
//
// The client marks the match at kick-off (beginMatch, persisted before the
// match mounts) and any recorded result clears it (applyResult). On the next
// boot settleAbandoned records whatever is still marked exactly like the pause
// menu's forfeit: 0–3, Elo lost, a fine and owed XP. Friendlies record nothing
// either way. A real crash is possible: a match the game itself crashed in is
// voided (at most once in VOID_EVERY matches, so it can't be farmed), and the
// player is told plainly what happened.

import { applyResult, formatMoney, signed, type Save } from './game.ts';
import { lifetimeMatches } from './history.ts';
import { cupOpponent, recordCupMatch, recordSeasonMatch, seasonOpponent } from './competitions.ts';
import { maybeRollover } from './progression.ts';

export interface PendingMatch {
  kind: 'ranked' | 'cup' | 'league' | 'friendly';
  /** The opponent's ladder id (ranked), for the forfeit's Elo. */
  opponentId?: string;
  opponent: string;
  /** Shown in the message: "Ranked", "Cup semi-final", "League matchday 3". */
  label: string;
  /** The game itself threw an error during the match (the client's error handler sets it). */
  crashed?: boolean;
}

/** A match the game crashed in is voided at most once in this many matches; any other crash counts like a reload. */
export const VOID_EVERY = 10;

/** Mark a match as under way. Persist the save right after, before the match starts. */
export function beginMatch(save: Save, m: PendingMatch): void {
  save.pending = { ...m };
}

/** Forget the mark without recording anything (a friendly, or a match that never started). */
export function clearPending(save: Save): void {
  save.pending = null;
}

/** The game hit an error mid-match: if the page is then reloaded, the match may be voided rather than forfeited. */
export function markCrashed(save: Save): void {
  if (save.pending) save.pending.crashed = true;
}

export interface Settled {
  /** For a toast: what happened and what it cost. */
  message: string;
  eloDelta: number;
  /** Voided after a crash: nothing recorded. */
  voided?: boolean;
}

/**
 * Settle the match left unfinished last time, if any, and clear the mark.
 *  - The game crashed during it (crashed) and no match was voided in the last
 *    VOID_EVERY: it is voided, nothing recorded.
 *  - Otherwise it is recorded as a 0–3 forfeit, like the pause menu's: Elo,
 *    a fine and owed XP (forfeitCost in game.ts).
 * Returns the message to show, or null when nothing was pending (or it was a
 * friendly). Run on boot, after the save's fields are filled in.
 */
export function settleAbandoned(save: Save): Settled | null {
  const p = save.pending;
  if (!p) return null;
  save.pending = null;
  if (p.kind === 'friendly') return null;
  const played = lifetimeMatches(save);
  if (p.crashed && (save.voidAt === undefined || played - save.voidAt >= VOID_EVERY)) {
    save.voidAt = played;
    return { voided: true, eloDelta: 0, message: `Your ${p.label.toLowerCase()} match against ${p.opponent} stopped because the game hit an error, so it doesn't count. Sorry about that.` };
  }
  const before = save.club.elo;
  const budget = save.budget;
  const owedBefore = save.xpOwed ?? 0;
  const moneyOwedBefore = save.moneyOwed ?? 0;
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
  const fine = budget - save.budget + (save.moneyOwed ?? 0) - moneyOwedBefore;
  const owed = (save.xpOwed ?? 0) - owedBefore;
  const cost = [delta ? `Elo ${signed(delta)}` : '', fine > 0 ? `a ${formatMoney(fine)} fine` : '', owed > 0 ? `${owed} XP owed from your next matches` : 'no XP'].filter(Boolean).join(', ');
  return {
    eloDelta: delta,
    message: `Your ${p.label.toLowerCase()} match against ${p.opponent} didn't finish (the page was closed or reloaded), so it counts as a 0–3 forfeit: ${cost}. Matches are saved when the final whistle goes.`,
  };
}
