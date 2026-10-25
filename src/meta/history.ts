// The club's history in the save: the latest HISTORY_CAP matches in full, plus
// lifetime totals, records and a line per season that survive when older
// matches drop off the front. Pure data in, data out.
//
// Records and totals count competitive matches only (ranked, cup and league):
// a 6-0 against the practice Reserve XI is not a club record.

import type { MatchRecord, Save } from './game.ts';

/** Matches kept in full. Older ones are dropped; their totals and records stay in `records`. */
export const HISTORY_CAP = 300;
/** Points kept for the Elo chart. */
export const ELO_HISTORY_CAP = 200;
/** Seasons kept in the club history. */
export const SEASONS_CAP = 100;

export interface RecordMark {
  value: number;
  /** "4–0 v Harrow Albion (Ranked)". */
  text: string;
  year: number;
}

export interface ClubRecords {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  /** Current runs, to know when a record run ends. */
  unbeatenRun: number;
  winRun: number;
  biggestWin?: RecordMark;
  heaviestDefeat?: RecordMark;
  mostGoals?: RecordMark;
  longestUnbeaten?: RecordMark;
  longestWinRun?: RecordMark;
  highestElo?: RecordMark;
  /** Best division reached (1 is the top). */
  bestDivision?: number;
}

/** One finished calendar year, for the club history. */
export interface SeasonSummary {
  year: number;
  division: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  eloEnd: number;
  /** "League 4: 2nd in Division 3, promoted", "Cup 6: winners". */
  notes: string[];
}

export const emptyRecords = (): ClubRecords => ({ played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, unbeatenRun: 0, winRun: 0 });

const competitive = (m: MatchRecord): boolean => m.ranked || (!!m.competition && !m.competition.startsWith('Warm-up'));

function describe(m: MatchRecord): string {
  return `${m.goalsFor}–${m.goalsAgainst} v ${m.opponent} (${m.ranked ? 'Ranked' : m.competition})`;
}

const better = (mark: RecordMark | undefined, value: number) => !mark || value > mark.value;

/** Fold one match into the totals and records. */
function tally(rec: ClubRecords, m: MatchRecord, year: number): void {
  if (!competitive(m)) return;
  rec.played++;
  rec.gf += m.goalsFor;
  rec.ga += m.goalsAgainst;
  const margin = m.goalsFor - m.goalsAgainst;
  if (margin > 0) rec.won++;
  else if (margin === 0) rec.drawn++;
  else rec.lost++;
  rec.unbeatenRun = margin >= 0 ? rec.unbeatenRun + 1 : 0;
  rec.winRun = margin > 0 ? rec.winRun + 1 : 0;
  if (margin > 0 && better(rec.biggestWin, margin)) rec.biggestWin = { value: margin, text: describe(m), year };
  if (margin < 0 && better(rec.heaviestDefeat, -margin)) rec.heaviestDefeat = { value: -margin, text: describe(m), year };
  if (m.goalsFor > 0 && better(rec.mostGoals, m.goalsFor)) rec.mostGoals = { value: m.goalsFor, text: describe(m), year };
  if (rec.unbeatenRun > 1 && better(rec.longestUnbeaten, rec.unbeatenRun)) rec.longestUnbeaten = { value: rec.unbeatenRun, text: `${rec.unbeatenRun} matches unbeaten, to ${describe(m)}`, year };
  if (rec.winRun > 1 && better(rec.longestWinRun, rec.winRun)) rec.longestWinRun = { value: rec.winRun, text: `${rec.winRun} wins in a row, to ${describe(m)}`, year };
  if (better(rec.highestElo, m.eloAfter) && m.eloAfter !== m.eloBefore) rec.highestElo = { value: m.eloAfter, text: `Elo ${m.eloAfter} after ${describe(m)}`, year };
}

/** Fill in the history fields for a save from before them. Safe to call repeatedly. */
export function ensureHistoryFields(save: Save): void {
  save.historyBase ??= 0;
  save.seasons ??= [];
  save.yearNotes ??= [];
  if (!save.records) {
    const rec = emptyRecords();
    for (const m of save.history) tally(rec, m, save.year ?? 1);
    save.records = rec;
  }
  save.records.bestDivision = Math.min(save.records.bestDivision ?? Infinity, save.division ?? Infinity);
  if (!Number.isFinite(save.records.bestDivision)) delete save.records.bestDivision;
  trim(save);
}

function trim(save: Save): void {
  const over = save.history.length - HISTORY_CAP;
  if (over > 0) {
    save.history.splice(0, over);
    save.historyBase = (save.historyBase ?? 0) + over;
  }
  if (save.eloHistory.length > ELO_HISTORY_CAP) save.eloHistory.splice(0, save.eloHistory.length - ELO_HISTORY_CAP);
  if (save.seasons && save.seasons.length > SEASONS_CAP) save.seasons.splice(0, save.seasons.length - SEASONS_CAP);
}

/** Record a match: into the history (dropping the oldest past the cap) and the lifetime records. */
export function pushHistory(save: Save, m: MatchRecord): void {
  ensureHistoryFields(save);
  save.history.push(m);
  tally(save.records!, m, save.year ?? 1);
  trim(save);
}

/** How many matches the club has recorded in its life (history kept plus dropped). A trophy's `atMatch` uses it. */
export const lifetimeMatches = (save: Save): number => (save.historyBase ?? 0) + save.history.length;

/** A line for this year's entry in the club history ("Cup 6: winners"). */
export function noteYear(save: Save, note: string): void {
  (save.yearNotes ??= []).push(note);
}

/** Note the best division reached. */
export function noteDivision(save: Save, division: number): void {
  ensureHistoryFields(save);
  save.records!.bestDivision = Math.min(save.records!.bestDivision ?? division, division);
}

/** Close a calendar year in the club history (from the rollover). */
export function closeYear(save: Save, s: Omit<SeasonSummary, 'notes'>): SeasonSummary {
  ensureHistoryFields(save);
  const summary: SeasonSummary = { ...s, notes: save.yearNotes ?? [] };
  save.seasons!.push(summary);
  save.yearNotes = [];
  trim(save);
  return summary;
}
