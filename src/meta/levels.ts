// Club level: experience (XP), levels 1-99, and the features and perks that
// unlock along the way. Pure data in, data out, like the rest of src/meta.
//
// The curve. Clearing level L takes 100 * L XP: level 1 -> 2 needs 100, 2 -> 3
// needs 200, ... 98 -> 99 needs 9,800. Level 99 is the cap; its bar is 9,900
// long and reads "Max level" once full, but XP keeps counting (for a future
// prestige). Reaching level L from zero takes 50 * L * (L - 1) XP in total, so
// level 99 is 485,100 XP.
//
// Unlocks. UNLOCKS is the one table the UI, the tests and the docs read. A
// feature is available when the club's level reaches it, or when the save
// already uses it (an old save with a cup running, trophies or academy offers
// keeps them whatever its level), or when it was unlocked once before
// (`unlocksSeen`): once unlocked, always unlocked, even if the XP table is
// rebalanced later. Match controls (sprint, lofted balls, slides) are never
// gated. Both ways to play another human (Local 2P, Link two tabs) are open
// from level 1: "vs Player" is one of the home screen's play modes.
//
// XP. See XP below and docs/ROADMAP.md ("Club levels") for the table and the
// pacing. Forfeits and abandoned matches earn nothing, and two-human matches
// (Local 2P, Link two tabs) record nothing, so they earn nothing either.

import type { MatchRecord, Save } from './game.ts';

export const MAX_LEVEL = 99;

// ---------------------------------------------------------------------------
// The curve

/** XP needed to go from `level` to the next one. Level 99's bar is 9,900 long (it never completes into a level 100). */
export const xpToClear = (level: number): number => 100 * clampLevel(level);

/** Total XP needed to reach `level` from zero: 0 for level 1, 100 for 2, 300 for 3, 485,100 for 99. */
export function totalXpForLevel(level: number): number {
  const l = clampLevel(level);
  return 50 * l * (l - 1);
}

export interface LevelProgress {
  level: number;
  /** XP earned since reaching `level`. At level 99 it can run past `needed`. */
  intoLevel: number;
  /** Length of this level's bar (xpToClear(level)). */
  needed: number;
  /** Level 99 with a full bar. */
  maxed: boolean;
}

export function levelForXp(totalXp: number): LevelProgress {
  const xp = Math.max(0, Math.floor(Number.isFinite(totalXp) ? totalXp : 0));
  let level = 1;
  while (level < MAX_LEVEL && totalXpForLevel(level + 1) <= xp) level++;
  const intoLevel = xp - totalXpForLevel(level);
  const needed = xpToClear(level);
  return { level, intoLevel, needed, maxed: level === MAX_LEVEL && intoLevel >= needed };
}

function clampLevel(level: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
}

export const clubLevel = (save: Save): number => levelForXp(save.xp ?? 0).level;

/** "Level 4 · 230 / 400 XP", or "Level 99 · Max level" once the last bar is full. */
export function levelText(p: LevelProgress): string {
  return p.maxed ? `Level ${p.level} · Max level` : `Level ${p.level} · ${p.intoLevel.toLocaleString('en-GB')} / ${p.needed.toLocaleString('en-GB')} XP`;
}

// ---------------------------------------------------------------------------
// Unlocks and perks: the one table

export type UnlockId =
  | 'home' | 'club' | 'squad' | 'ranked' | 'practice'
  | 'training' | 'transfers' | 'ladder' | 'cup' | 'practice-hard' | 'replays' | 'local2p' | 'league' | 'calendar' | 'link' | 'drills' | 'practice-normal'
  | 'squad-15' | 'crest' | 'market-20' | 'kit' | 'scouting' | 'badge-silver' | 'squad-30' | 'win-bonus' | 'replays-40'
  | 'squad-50' | 'badge-gold' | 'replays-65' | 'badge-platinum' | 'market-80' | 'badge-legend';

export interface Unlock {
  id: UnlockId;
  level: number;
  kind: 'feature' | 'perk';
  /** Short name for lists and the "next unlock" teaser: "The Cup". */
  name: string;
  /** One sentence for the club-level panel and the level-up dialog. */
  text: string;
  /**
   * Where the level-up dialog's button goes: a screen (a client Screen id) and,
   * optionally, the id of the element to focus there.
   */
  go?: { screen: string; label: string; focusId?: string };
}

export const UNLOCKS: readonly Unlock[] = [
  { id: 'home', level: 1, kind: 'feature', name: 'Home and Kick off', text: 'Kick off your next match from Home. Everything else opens as the club levels up.' },
  { id: 'squad', level: 2, kind: 'feature', name: 'Squad', text: 'See your players and pick the starting eleven.', go: { screen: 'squad', label: 'Go to Squad' } },
  { id: 'local2p', level: 2, kind: 'feature', name: 'Local 2P', text: 'vs Player on one screen: two humans, one keyboard. Nothing recorded.', go: { screen: 'home', label: 'Show me', focusId: 'play-local2p' } },
  { id: 'link', level: 2, kind: 'feature', name: 'Link two tabs', text: 'vs Player in two tabs of this browser, in lockstep. Nothing recorded.', go: { screen: 'home', label: 'Show me', focusId: 'play-link' } },
  { id: 'practice', level: 2, kind: 'feature', name: 'Practice (Easy)', text: 'Friendlies against an Easy CPU. No Elo.', go: { screen: 'home', label: 'Show me', focusId: 'practice-easy' } },
  { id: 'ranked', level: 3, kind: 'feature', name: 'Ranked matches', text: 'Play ladder clubs near your Elo, live. Until then, Kick off is a warm-up friendly.' },
  { id: 'club', level: 3, kind: 'feature', name: 'Club', text: 'Club news, your club level and every unlock still to come.', go: { screen: 'club', label: 'Go to Club' } },
  { id: 'replays', level: 3, kind: 'feature', name: 'Replays', text: 'Watch your goals again, keep recent replays and share replay codes.', go: { screen: 'club', label: 'Show me', focusId: 'replay-paste' } },
  { id: 'drills', level: 3, kind: 'feature', name: 'Practice skills', text: 'The training-ground drills: run, pass, shoot and tackle, any time you like.', go: { screen: 'club', label: 'Show me', focusId: 'replay-tutorial' } },
  { id: 'training', level: 4, kind: 'feature', name: 'Training', text: 'Spend the sessions you earn on player attributes.', go: { screen: 'training', label: 'Go to Training' } },
  { id: 'practice-normal', level: 4, kind: 'feature', name: 'Practice Normal', text: 'A fairer CPU friendly: the Academy Select.', go: { screen: 'home', label: 'Show me', focusId: 'practice-normal' } },
  { id: 'cup', level: 5, kind: 'feature', name: 'The Cup', text: 'The Competitions tab opens with an 8-club knockout cup: prize money, penalties, a trophy.', go: { screen: 'competitions', label: 'Go to Competitions' } },
  { id: 'practice-hard', level: 5, kind: 'feature', name: 'Practice Hard', text: 'A tougher CPU friendly: the Veterans Select.', go: { screen: 'home', label: 'Show me', focusId: 'practice-hard' } },
  { id: 'transfers', level: 6, kind: 'feature', name: 'Transfers', text: 'Sign players from the market and sell to CPU clubs.', go: { screen: 'transfers', label: 'Go to Transfers' } },
  { id: 'ladder', level: 7, kind: 'feature', name: 'Ladder', text: 'The full Elo table of all 16 clubs.', go: { screen: 'ladder', label: 'Go to the Ladder' } },
  { id: 'league', level: 8, kind: 'feature', name: 'League season', text: 'An 8-club round robin over 7 matchdays, with prize money for every place.', go: { screen: 'competitions', label: 'Go to Competitions', focusId: 'comp-start-season' } },
  { id: 'calendar', level: 10, kind: 'feature', name: 'Season calendar and academy', text: 'Seasons of 10 matches start counting: players age, veterans retire and academy prospects arrive.', go: { screen: 'club', label: 'Show me', focusId: 'news-title' } },
  { id: 'squad-15', level: 15, kind: 'perk', name: 'Squad of 25', text: 'Room for one more player (24 to 25).', go: { screen: 'squad', label: 'Go to Squad' } },
  { id: 'crest', level: 18, kind: 'perk', name: 'Crest pattern', text: 'Change your crest pattern any time from Club news.', go: { screen: 'club', label: 'Show me', focusId: 'crest-select' } },
  { id: 'market-20', level: 20, kind: 'perk', name: 'Deeper market', text: 'Two extra players on the transfer market (10 to 12).', go: { screen: 'transfers', label: 'Go to Transfers' } },
  { id: 'kit', level: 22, kind: 'perk', name: 'Custom kit colours', text: 'Pick your own kit colours from Club news.', go: { screen: 'club', label: 'Show me', focusId: 'kit-primary' } },
  { id: 'scouting', level: 25, kind: 'perk', name: 'Sharper scouts', text: "An academy prospect's potential is known one match sooner (5 instead of 6)." },
  { id: 'badge-silver', level: 25, kind: 'perk', name: 'Silver badge', text: 'Your level badge turns silver.' },
  { id: 'squad-30', level: 30, kind: 'perk', name: 'Squad of 26', text: 'Room for another player (25 to 26).', go: { screen: 'squad', label: 'Go to Squad' } },
  { id: 'win-bonus', level: 35, kind: 'perk', name: 'Win bonus', text: 'One extra training session for every ranked or competition win.' },
  { id: 'replays-40', level: 40, kind: 'perk', name: 'Replay shelf of 8', text: 'Keep your last 8 replays instead of 5.' },
  { id: 'squad-50', level: 50, kind: 'perk', name: 'Squad of 27', text: 'Room for another player (26 to 27).', go: { screen: 'squad', label: 'Go to Squad' } },
  { id: 'badge-gold', level: 50, kind: 'perk', name: 'Gold badge', text: 'Your level badge turns gold.' },
  { id: 'replays-65', level: 65, kind: 'perk', name: 'Replay shelf of 10', text: 'Keep your last 10 replays.' },
  { id: 'badge-platinum', level: 75, kind: 'perk', name: 'Platinum badge', text: 'Your level badge turns platinum.' },
  { id: 'market-80', level: 80, kind: 'perk', name: 'Scouting network', text: 'Two more players on the transfer market (12 to 14).', go: { screen: 'transfers', label: 'Go to Transfers' } },
  { id: 'badge-legend', level: 99, kind: 'perk', name: 'Legend badge', text: 'Level 99. The bar keeps counting toward a future prestige.' },
];

/**
 * Version of the unlock table. Version 2 (gradual onboarding) moved Squad,
 * Club, Practice, vs Player and the rest later. A save made before it
 * (`unlocksV` missing) keeps every feature the old table had opened for it:
 * see ensureLevelFields.
 */
export const UNLOCKS_VERSION = 2;

/** Where the version-1 table opened each feature, for saves that predate version 2. */
const V1_LEVEL: Partial<Record<UnlockId, number>> = {
  home: 1, club: 1, squad: 1, ranked: 1, practice: 1, 'practice-normal': 1, local2p: 1, link: 1, drills: 1,
  training: 2, transfers: 3, ladder: 4, cup: 5, 'practice-hard': 5, replays: 6, league: 8, calendar: 10,
};

const BY_ID = new Map(UNLOCKS.map((u) => [u.id, u]));

export function unlockOf(id: UnlockId): Unlock {
  return BY_ID.get(id)!;
}

/** Unlocks the save is already using, which stay available whatever its level (for saves from before levels). */
export function inUse(save: Save, id: UnlockId): boolean {
  const trophies = save.trophies ?? [];
  switch (id) {
    case 'cup':
      return !!save.cup || trophies.some((t) => t.kind === 'cup');
    case 'league':
      return !!save.season || trophies.some((t) => t.kind === 'season');
    case 'calendar':
      return (save.week ?? 0) > 0 || (save.year ?? 1) > 1 || !!save.review || (save.offers?.length ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * The club level at which `id` opens for this save. The table's own level, except for a save that predates it
 * (`legacyUnlocks`): it keeps whichever came first, the old level or the new one, so nothing it was working
 * toward moves further away.
 */
export function unlockLevel(save: Save, id: UnlockId): number {
  const u = BY_ID.get(id);
  if (!u) return Infinity;
  return save.legacyUnlocks ? Math.min(V1_LEVEL[id] ?? u.level, u.level) : u.level;
}

export function isUnlocked(save: Save, id: UnlockId): boolean {
  const u = BY_ID.get(id);
  if (!u) return false;
  return clubLevel(save) >= unlockLevel(save, id) || (save.unlocksSeen?.includes(id) ?? false) || inUse(save, id);
}

/** The next locked unlocks: everything at the lowest level still to come. Empty at the end of the table. */
export function nextUnlocks(save: Save): Unlock[] {
  const locked = UNLOCKS.filter((u) => !isUnlocked(save, u.id));
  if (!locked.length) return [];
  const first = Math.min(...locked.map((u) => unlockLevel(save, u.id)));
  return locked.filter((u) => unlockLevel(save, u.id) === first);
}

/** "The Cup and Practice Hard at level 5 — 340 XP to go", or null when everything is unlocked. */
export function nextUnlockText(save: Save): string | null {
  const next = nextUnlocks(save);
  if (!next.length) return null;
  const level = unlockLevel(save, next[0].id);
  const toGo = Math.max(0, totalXpForLevel(level) - (save.xp ?? 0));
  const names = next.map((u) => u.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `${list} at level ${level} — ${toGo.toLocaleString('en-GB')} XP to go`;
}

/** Unlocks reached that the player hasn't been told about yet (the level-up dialog lists these). */
export function pendingUnlocks(save: Save): Unlock[] {
  const seen = new Set(save.unlocksSeen ?? []);
  const level = clubLevel(save);
  // Level-1 features are the starting kit, never news: a save whose unlocksSeen
  // predates one (vs Player moved to level 1) gets no level-up dialog for it.
  return UNLOCKS.filter((u) => unlockLevel(save, u.id) > 1 && unlockLevel(save, u.id) <= level && !seen.has(u.id));
}

/** The level-up dialog was closed: everything reached so far counts as seen (and stays unlocked). */
export function markUnlocksSeen(save: Save): void {
  const seen = new Set(save.unlocksSeen ?? []);
  for (const u of pendingUnlocks(save)) seen.add(u.id);
  save.unlocksSeen = UNLOCKS.filter((u) => seen.has(u.id)).map((u) => u.id);
}

// ---------------------------------------------------------------------------
// Perks, read by the rules that use them

const has = (save: Save, id: UnlockId) => isUnlocked(save, id);

/** Base squad cap (MAX_SQUAD in game.ts) plus one at levels 15, 30 and 50. */
export const BASE_SQUAD_CAP = 24;
export function squadCap(save: Save): number {
  return BASE_SQUAD_CAP + (['squad-15', 'squad-30', 'squad-50'] as const).filter((id) => has(save, id)).length;
}

export const BASE_MARKET_SIZE = 10;
export function marketSize(save: Save): number {
  return BASE_MARKET_SIZE + 2 * (['market-20', 'market-80'] as const).filter((id) => has(save, id)).length;
}

/** Matches an academy prospect plays before their potential is exact (SCOUT_MATCHES, one fewer with Sharper scouts). */
export function scoutMatchesFor(save: Save, base: number): number {
  return has(save, 'scouting') ? base - 1 : base;
}

/** Extra training sessions for a ranked or competition win. */
export const winTrainingBonus = (save: Save): number => (has(save, 'win-bonus') ? 1 : 0);

/** How many recent replays this browser keeps. */
export function replaySlots(save: Save): number {
  return has(save, 'replays-65') ? 10 : has(save, 'replays-40') ? 8 : 5;
}

export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'legend';
export function badgeTier(level: number): BadgeTier {
  if (level >= 99) return 'legend';
  if (level >= 75) return 'platinum';
  if (level >= 50) return 'gold';
  if (level >= 25) return 'silver';
  return 'bronze';
}

// ---------------------------------------------------------------------------
// XP sources

export type PracticeLevel = 'easy' | 'normal' | 'hard';

export const XP = {
  win: 120,
  draw: 80,
  loss: 50,
  goal: 10,
  cleanSheet: 20,
  practice: { easy: 30, normal: 40, hard: 60 } as Record<PracticeLevel, number>,
  trainingSession: 5,
  cup: { winner: 500, runnerUp: 200, semiFinal: 100 },
  /** League finishing bonus by position, 1st to 8th. */
  league: [800, 400, 200, 200, 100, 100, 50, 50],
} as const;

export type MilestoneId = 'first-match' | 'tutorial' | 'first-win' | 'first-signing' | 'first-trophy';
export const MILESTONES: Record<MilestoneId, { xp: number; label: string }> = {
  // Enough on top of an Easy friendly (30) that even a first-match defeat reaches level 2.
  'first-match': { xp: 80, label: 'first match' },
  tutorial: { xp: 100, label: 'training ground done' },
  'first-win': { xp: 100, label: 'first ranked win' },
  'first-signing': { xp: 50, label: 'first signing' },
  'first-trophy': { xp: 200, label: 'first trophy' },
};

export interface XpPart {
  label: string;
  xp: number;
}

export interface XpGain {
  total: number;
  parts: XpPart[];
  levelBefore: number;
  levelAfter: number;
}

export type MatchKind = 'ranked' | 'competition' | 'practice';

/** XP for one match. Ranked and competition: result + goals + clean sheet. Practice: a flat amount by difficulty. Forfeits: nothing. */
export function matchXp(kind: MatchKind, gf: number, ga: number, forfeited = false, practice: PracticeLevel = 'normal'): XpPart[] {
  if (forfeited) return [];
  if (kind === 'practice') {
    const name = practice[0].toUpperCase() + practice.slice(1);
    return [{ label: `practice (${name})`, xp: XP.practice[practice] }];
  }
  const parts: XpPart[] = [gf > ga ? { label: 'win', xp: XP.win } : gf === ga ? { label: 'draw', xp: XP.draw } : { label: 'loss', xp: XP.loss }];
  if (gf > 0) parts.push({ label: `${gf} goal${gf === 1 ? '' : 's'}`, xp: gf * XP.goal });
  if (ga === 0) parts.push({ label: 'clean sheet', xp: XP.cleanSheet });
  return parts;
}

/** Cup finishing bonus for the round you went out in (0 = quarter-final) or won the final in. */
export function cupFinishXp(round: number, won: boolean): XpPart | null {
  if (round === 2) return won ? { label: 'cup winners', xp: XP.cup.winner } : { label: 'cup runners-up', xp: XP.cup.runnerUp };
  if (round === 1 && !won) return { label: 'cup semi-final', xp: XP.cup.semiFinal };
  return null;
}

export function leagueFinishXp(position: number): XpPart | null {
  const xp = XP.league[position - 1];
  if (!xp) return null;
  const labels = ['league champions', 'league runners-up'];
  return { label: labels[position - 1] ?? `league ${position}${position === 3 ? 'rd' : 'th'} place`, xp };
}

/** A gain that hasn't added anything yet, starting from the save's current level. */
export function startGain(save: Save): XpGain {
  const level = clubLevel(save);
  return { total: 0, parts: [], levelBefore: level, levelAfter: level };
}

/** Add XP parts to the save (zero parts are dropped) and to `gain`. */
export function award(save: Save, parts: (XpPart | null)[], gain: XpGain = startGain(save)): XpGain {
  for (const p of parts) {
    if (!p || p.xp <= 0) continue;
    save.xp = (save.xp ?? 0) + p.xp;
    gain.parts.push(p);
    gain.total += p.xp;
  }
  gain.levelAfter = clubLevel(save);
  return gain;
}

/** Claim a first-time milestone. Returns its XP part, or null if it was claimed before. Does not add the XP: pass it to award(). */
export function claimMilestone(save: Save, id: MilestoneId): XpPart | null {
  save.milestones ??= [];
  if (save.milestones.includes(id)) return null;
  save.milestones.push(id);
  return { label: MILESTONES[id].label, xp: MILESTONES[id].xp };
}

/** "+150 XP: win 120, 3 goals 30", or "No XP" for an empty gain. */
export function xpSummary(gain: XpGain): string {
  if (!gain.total) return 'No XP';
  return `+${gain.total.toLocaleString('en-GB')} XP: ${gain.parts.map((p) => `${p.label} ${p.xp.toLocaleString('en-GB')}`).join(', ')}`;
}

// ---------------------------------------------------------------------------
// Saves from before levels existed

/** Practice opponents by name (PRACTICE in src/client/ui.ts), so retro XP can tell the difficulties apart. */
const PRACTICE_BY_NAME: Record<string, PracticeLevel> = { 'Reserve XI': 'easy', 'Academy Select': 'normal', 'Veterans Select': 'hard' };

const sum = (parts: (XpPart | null)[]) => parts.reduce((t, p) => t + (p?.xp ?? 0), 0);

function recordXp(m: MatchRecord): number {
  if (m.ranked) return sum(matchXp('ranked', m.goalsFor, m.goalsAgainst));
  if (m.competition) return sum(matchXp('competition', m.goalsFor, m.goalsAgainst));
  return sum(matchXp('practice', m.goalsFor, m.goalsAgainst, false, PRACTICE_BY_NAME[m.opponent] ?? 'normal'));
}

/** Starting sessions in newGame, and what each kind of match paid (see applyResult and the competitions). */
const START_SESSIONS = 6;
function sessionsEarned(m: MatchRecord): number {
  if (m.ranked) return m.goalsFor > m.goalsAgainst ? 3 : 2;
  if (m.competition) return 2;
  return 1;
}

export interface RetroXp {
  xp: number;
  milestones: MilestoneId[];
  parts: XpPart[];
}

/**
 * XP a save from before levels would have earned, from what it records: every
 * match in history (forfeits can't be told apart from 0-3 defeats, so they
 * count as defeats), training sessions spent (sessions earned minus sessions
 * left), cup and league finishes the history and trophies prove, and the
 * milestones it shows (first ranked win, first signing in the news, first
 * trophy). The training-ground milestone can't be known, so it stays
 * claimable from "Replay tutorial".
 */
export function retroXp(save: Save): RetroXp {
  const parts: XpPart[] = [];
  const milestones: MilestoneId[] = [];
  const history = save.history ?? [];
  const trophies = save.trophies ?? [];
  parts.push({ label: `${history.length} matches`, xp: history.reduce((t, m) => t + recordXp(m), 0) });

  const earned = START_SESSIONS + history.reduce((t, m) => t + sessionsEarned(m), 0);
  const spent = Math.max(0, earned - (save.trainingPoints ?? 0));
  parts.push({ label: `${spent} training sessions`, xp: spent * XP.trainingSession });

  const count = (label: string) => history.filter((m) => m.competition === label).length;
  const cupWins = trophies.filter((t) => t.kind === 'cup').length;
  const cup = save.cup;
  const inFinalNow = !!cup && !cup.done && cup.round === 2 && cup.rounds[2]?.some((t) => (t.a === save.club.id || t.b === save.club.id) && t.winner === undefined);
  const finals = count('Cup final');
  const runnersUp = Math.max(0, finals - cupWins);
  const semiExits = Math.max(0, count('Cup semi-final') - finals - (inFinalNow ? 1 : 0));
  parts.push({ label: 'cup runs', xp: cupWins * XP.cup.winner + runnersUp * XP.cup.runnerUp + semiExits * XP.cup.semiFinal });

  // League titles are in the cabinet; any other finished season gets at least the bottom-place bonus.
  const titles = trophies.filter((t) => t.kind === 'season').length;
  // Playing the last matchday is what finishes a season.
  const finished = count(`League matchday ${XP.league.length - 1}`);
  parts.push({ label: 'league seasons', xp: titles * XP.league[0] + Math.max(0, finished - titles) * XP.league[XP.league.length - 1] });

  if (history.some((m) => m.ranked && m.goalsFor > m.goalsAgainst)) milestones.push('first-win');
  if ((save.news ?? []).some((n) => n.startsWith('Signed ') && !n.startsWith('Signed academy'))) milestones.push('first-signing');
  if (trophies.length) milestones.push('first-trophy');
  for (const id of milestones) parts.push({ label: MILESTONES[id].label, xp: MILESTONES[id].xp });

  const kept = parts.filter((p) => p.xp > 0);
  return { xp: sum(kept), milestones, parts: kept };
}

/**
 * Fill in the level fields. Safe to call repeatedly.
 *  - No `xp` at all: a save from before levels. It gets retro XP (retroXp) and
 *    the milestones its history shows.
 *  - No `unlocksSeen`: everything its level reaches, plus anything it is
 *    already using, counts as seen, so an old save neither loses a feature nor
 *    gets a flood of level-up dialogs.
 */
export function ensureLevelFields(save: Save): void {
  // Decided first, so every level read below already uses the earlier of the old and new unlock levels.
  if (save.unlocksV !== UNLOCKS_VERSION) save.legacyUnlocks = true;
  if (save.xp === undefined || !Number.isFinite(save.xp)) {
    const retro = retroXp(save);
    save.xp = retro.xp;
    save.milestones = [...new Set([...(save.milestones ?? []), ...retro.milestones])];
  }
  save.milestones ??= [];
  if (!Array.isArray(save.unlocksSeen)) {
    const level = clubLevel(save);
    save.unlocksSeen = UNLOCKS.filter((u) => unlockLevel(save, u.id) <= level || inUse(save, u.id)).map((u) => u.id);
  }
  // A save from before the gradual unlock table keeps everything the old table gave it, and nothing it was
  // working toward moves later (unlockLevel takes the earlier of the two levels). What its level now opens is
  // marked seen silently: no level-up dialog for features a returning player already had or is about to.
  if (save.unlocksV !== UNLOCKS_VERSION) {
    const level = clubLevel(save);
    const seen = new Set(save.unlocksSeen);
    for (const u of UNLOCKS) if (unlockLevel(save, u.id) <= level) seen.add(u.id);
    save.unlocksSeen = UNLOCKS.filter((u) => seen.has(u.id)).map((u) => u.id);
    save.unlocksV = UNLOCKS_VERSION;
  }
}
