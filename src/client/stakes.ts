// Why this match matters: head-to-head, the Elo and ladder places a result moves, and the derby flag. Presentation
// only: it reads the save and the existing Elo functions (elo.ts); nothing here changes a rule or a number.

import type { LadderClub } from '../meta/club.ts';
import { expectedScore, kFactor } from '../meta/elo.ts';
import { ladderTable, type Save } from '../meta/game.ts';
import { isUnlocked } from '../meta/levels.ts';
import { esc } from './ui.ts';

/** Places either side of you on the ladder that make a match a derby. */
export const DERBY_PLACES = 2;

/** "First meeting" or "Last time you won 2–1" (with the record from two meetings on). Forfeits and practice are not meetings. */
export function headToHead(s: Save, opp: { name: string }): string {
  const met = s.history.filter((m) => m.opponent === opp.name && !m.forfeited && (m.ranked || (m.competition && !m.competition.startsWith('Warm-up'))));
  const last = met[met.length - 1];
  if (!last) return 'First meeting';
  const word = last.goalsFor > last.goalsAgainst ? 'won' : last.goalsFor === last.goalsAgainst ? 'drew' : 'lost';
  const rec = (f: (m: { goalsFor: number; goalsAgainst: number }) => boolean) => met.filter(f).length;
  const tail = met.length > 1 ? ` · W${rec((m) => m.goalsFor > m.goalsAgainst)} D${rec((m) => m.goalsFor === m.goalsAgainst)} L${rec((m) => m.goalsFor < m.goalsAgainst)}` : '';
  return `Last time you ${word} ${last.goalsFor}–${last.goalsAgainst}${tail}`;
}

export interface Stakes {
  gain: number;
  cost: number;
  /** Ladder places after a win and after a defeat, when the ladder is open. */
  rankNow?: number;
  rankWin?: number;
  rankLose?: number;
  /** A near neighbour on the ladder. */
  derby: boolean;
}

/** The Elo a win or defeat is worth (the ladder's own sum) and where it would put you. */
export function stakesVs(s: Save, opp: LadderClub): Stakes {
  const e = expectedScore(s.club.elo, opp.elo);
  const k = kFactor(s.club.played);
  const gain = Math.round(k * (1 - e));
  const cost = Math.round(k * e);
  if (!isUnlocked(s, 'ladder')) return { gain, cost, derby: false };
  const table = ladderTable(s);
  const others = table.filter((r) => !r.you);
  const at = (elo: number) => 1 + others.filter((r) => r.elo >= elo).length;
  const rankNow = table.findIndex((r) => r.you) + 1;
  const oppRank = table.findIndex((r) => r.name === opp.name) + 1;
  return { gain, cost, rankNow, rankWin: at(s.club.elo + gain), rankLose: at(s.club.elo - cost), derby: oppRank > 0 && Math.abs(oppRank - rankNow) <= DERBY_PLACES };
}

/** "Win: +18 Elo, up to #22" for a line of text; the ladder part only when it is open. */
export function winText(st: Stakes): string {
  const up = st.rankNow && st.rankWin && st.rankWin < st.rankNow ? `, up to #${st.rankWin}` : '';
  return `Win: +${st.gain} Elo${up}`;
}

/** The line under a hero or fixture card: derby flag and head-to-head, then what a win does (or `win`, e.g. the next cup round). */
export function storyHtml(s: Save, opp: LadderClub, win?: string): string {
  const st = stakesVs(s, opp);
  return `<p class="hero-story"><span class="story-h2h">${st.derby ? '<b class="derby">Derby</b> ' : ''}${esc(headToHead(s, opp))}</span><span class="story-win">${esc(win ?? winText(st))}</span></p>`;
}

/** The kick-off banner for a match: "Derby" or "First meeting" over the head-to-head. */
export function introLine(s: Save, opp: LadderClub): { title: string; sub: string } {
  const h2h = headToHead(s, opp);
  return { title: stakesVs(s, opp).derby ? 'Derby' : h2h === 'First meeting' ? 'First meeting' : 'Rematch', sub: h2h === 'First meeting' ? `${s.club.short} v ${opp.short}` : h2h };
}
