// The club-management loop: squad, transfers, training, ladder and Elo.
// Everything here is plain data in, plain data out, so it can move behind an
// API unchanged when the economy goes server-side.

import { TEAM_SIZE } from '../sim/constants.ts';
import { chance, makeRng, next, pick, type Rng } from '../sim/rng.ts';
import {
  assignNumbers,
  autoLineup,
  emptyRecord,
  generateIdentity,
  generateLadder,
  generateSquad,
  qualityForElo,
  type ClubIdentity,
  type ClubRecord,
  type LadderClub,
} from './club.ts';
import type { Cup, Season, Trophy } from './competitions.ts';
import { eloDelta, expectedScore, START_ELO } from './elo.ts';
import type { SeasonReview } from './progression.ts';
import { award, claimMilestone, isUnlocked, marketSize, matchXp, squadCap, startGain, winTrainingBonus, XP, type MilestoneId, type PracticeLevel, type UnlockId, type XpGain } from './levels.ts';
import { ATTR_KEYS, ATTR_NAME, generatePlayer, marketValue, overall, shortName, trainingGain, type AttrKey, type Player } from './player.ts';

export const SAVE_VERSION = 1;
/** Base squad cap. Club-level perks raise it (squadCap in levels.ts). */
export const MAX_SQUAD = 14;
export const MIN_SQUAD = TEAM_SIZE + 1;
export const LADDER_SIZE = 15;

export interface MatchRecord {
  opponent: string;
  opponentShort: string;
  goalsFor: number;
  goalsAgainst: number;
  ranked: boolean;
  eloBefore: number;
  eloAfter: number;
  scorers: string[];
  /** Set for cup and league matches, e.g. "Cup semi-final". */
  competition?: string;
  /** Club-calendar week this match was played in (ranked and competition matches only). */
  week?: number;
}

export interface Save {
  version: number;
  seed: number;
  rng: Rng;
  club: ClubIdentity & ClubRecord & { elo: number };
  squad: Player[];
  lineup: string[];
  budget: number;
  trainingPoints: number;
  eloHistory: number[];
  ladder: LadderClub[];
  market: Player[];
  history: MatchRecord[];
  news: string[];
  // Competitions (src/meta/competitions.ts). Optional so saves from before
  // they existed still load; ensureCompetitionFields() fills the defaults.
  cup?: Cup | null;
  season?: Season | null;
  trophies?: Trophy[];
  cupEditions?: number;
  seasonEditions?: number;
  // Club calendar (src/meta/progression.ts). Optional so older saves still load;
  // ensureProgressionFields() fills the defaults.
  /** Ranked and competition matches played; one week passes per match. */
  week?: number;
  /** Calendar year (1-based). Year N ends when week reaches N * SEASON_WEEKS. */
  year?: number;
  /** The latest end-of-season review (shown once, can be reopened). */
  review?: SeasonReview | null;
  /** Academy prospects who couldn't join because the squad was full. They expire at the next rollover. */
  offers?: Player[];
  // Club level (src/meta/levels.ts). Optional so older saves still load;
  // ensureLevelFields() fills them, granting retro XP from the match history.
  /** Total experience earned. The level is derived from it. */
  xp?: number;
  /** Unlocks the player has been told about. Anything listed stays unlocked. */
  unlocksSeen?: UnlockId[];
  /** First-time milestones already claimed. */
  milestones?: MilestoneId[];
}

export function newGame(seed: number): Save {
  const r = makeRng(seed);
  const identity = generateIdentity(r);
  const squad = generateSquad(r, 54);
  const save: Save = {
    version: SAVE_VERSION,
    seed,
    rng: r,
    club: { ...identity, ...emptyRecord(), elo: START_ELO },
    squad,
    lineup: autoLineup(squad),
    budget: 1_200_000,
    trainingPoints: 6,
    eloHistory: [START_ELO],
    ladder: generateLadder(seed ^ 0x5eed, LADDER_SIZE),
    market: [],
    history: [],
    week: 0,
    year: 1,
    review: null,
    offers: [],
    xp: 0,
    unlocksSeen: ['club', 'squad', 'ranked', 'practice'],
    milestones: [],
    news: [`${identity.name} founded. The board has given you ${formatMoney(1_200_000)} to build a squad.`],
  };
  refreshMarket(save);
  return save;
}

/** New name and colours, same players. Only before the first match. */
export function rerollIdentity(save: Save): void {
  if (save.club.played > 0) return;
  const identity = generateIdentity(save.rng);
  save.club = { ...save.club, ...identity };
  save.news[save.news.length - 1] = `${identity.name} founded. The board has given you ${formatMoney(save.budget)} to build a squad.`;
}

export function formatMoney(n: number): string {
  if (n >= 1_000_000) return `ƒ${(n / 1_000_000).toFixed(2)}m`;
  return `ƒ${Math.round(n / 1000)}k`;
}

const round5k = (n: number) => Math.round(n / 5_000) * 5_000;
export const askingPrice = (p: Player): number => round5k(marketValue(p) * 1.1);
export const salePrice = (p: Player): number => round5k(marketValue(p) * 0.8);

export function refreshMarket(save: Save): void {
  const r = save.rng;
  const base = Math.max(48, Math.min(80, Math.round(averageOverall(save)) + 2));
  save.market = Array.from({ length: marketSize(save) }, () => {
    const p = generatePlayer(r, { quality: base + (next(r) - 0.45) * 22 });
    return p;
  }).sort((a, b) => overall(b) - overall(a));
}

export function averageOverall(save: Save): number {
  const ps = save.lineup.map((id) => save.squad.find((p) => p.id === id)).filter((p): p is Player => !!p);
  return ps.reduce((s, p) => s + overall(p), 0) / Math.max(1, ps.length);
}

export type Outcome = { ok: true; message: string } | { ok: false; message: string };

export function buyPlayer(save: Save, id: string): Outcome {
  const p = save.market.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'That player is no longer on the market.' };
  const cap = squadCap(save);
  if (save.squad.length >= cap) return { ok: false, message: `Squad is full (${cap}). Sell someone first.` };
  const price = askingPrice(p);
  if (price > save.budget) return { ok: false, message: `You need ${formatMoney(price - save.budget)} more to sign ${shortName(p)}.` };
  save.budget -= price;
  save.market = save.market.filter((x) => x.id !== id);
  p.number = 0;
  save.squad.push(p);
  assignNumbers(save.squad);
  save.news.push(`Signed ${shortName(p)} (${p.role}, ${overall(p)}) for ${formatMoney(price)}.`);
  const first = award(save, [claimMilestone(save, 'first-signing')]);
  return { ok: true, message: `${shortName(p)} signed for ${formatMoney(price)}.${first.total ? ` +${first.total} XP for your first signing.` : ''}` };
}

export function sellPlayer(save: Save, id: string): Outcome {
  const p = save.squad.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'Player not found.' };
  if (save.squad.length <= MIN_SQUAD) return { ok: false, message: `You need at least ${MIN_SQUAD} players.` };
  const price = salePrice(p);
  save.squad = save.squad.filter((x) => x.id !== id);
  save.budget += price;
  if (save.lineup.includes(id)) save.lineup = autoLineup(save.squad);
  save.news.push(`Sold ${shortName(p)} for ${formatMoney(price)}.`);
  return { ok: true, message: `${shortName(p)} sold for ${formatMoney(price)}.` };
}

export function train(save: Save, playerId: string, attr: AttrKey): Outcome {
  const p = save.squad.find((x) => x.id === playerId);
  if (!p) return { ok: false, message: 'Player not found.' };
  if (save.trainingPoints <= 0) return { ok: false, message: 'No training sessions left. Play a match to earn more.' };
  save.trainingPoints--;
  const before = overall(p);
  const gain = trainingGain(save.rng, p, attr);
  p.attrs[attr] = Math.min(99, p.attrs[attr] + gain);
  const after = overall(p);
  award(save, [{ label: 'training session', xp: XP.trainingSession }]);
  const msg =
    gain === 0
      ? `${shortName(p)} trained ${ATTR_NAME[attr].toLowerCase()} but didn't improve.`
      : `${shortName(p)} +${gain} ${ATTR_NAME[attr].toLowerCase()}${after > before ? ` (overall ${before} → ${after})` : ''}.`;
  return { ok: true, message: `${msg} +${XP.trainingSession} XP.` };
}

/** Put a player in a lineup slot. If they're already in the lineup, the two swap. */
export function setLineupSlot(save: Save, slot: number, playerId: string): void {
  const current = save.lineup.indexOf(playerId);
  const displaced = save.lineup[slot];
  save.lineup[slot] = playerId;
  if (current >= 0 && current !== slot) save.lineup[current] = displaced;
}

export function pickOpponent(save: Save): LadderClub {
  const last = save.history.at(-1)?.opponent;
  const pool = [...save.ladder]
    .filter((c) => c.name !== last)
    .sort((a, b) => Math.abs(a.elo - save.club.elo) - Math.abs(b.elo - save.club.elo))
    .slice(0, 3);
  return pick(save.rng, pool);
}

export interface ResultSummary {
  eloDelta: number;
  money: number;
  trainingPoints: number;
  developments: string[];
  /** Experience from this match (competitions add their finishing bonuses to it). */
  xp: XpGain;
}

export function applyResult(
  save: Save,
  opponent: LadderClub | null,
  opponentName: { name: string; short: string },
  goalsFor: number,
  goalsAgainst: number,
  ranked: boolean,
  scorers: string[],
  /** For a non-ranked competition match: what it was, e.g. "Cup final". Recorded in history and news. */
  competition?: string,
  /** Left the match early. The result and Elo stand, but it pays no money, sessions or development. */
  forfeited = false,
  /** For a practice friendly: the difficulty, which sets its XP. */
  practice: PracticeLevel = 'normal',
): ResultSummary {
  const c = save.club;
  const xp = startGain(save);
  // Checked before this match's XP lands, so the calendar starts with the match after it unlocks.
  const calendarOn = isUnlocked(save, 'calendar');
  const eloBefore = c.elo;
  let delta = 0;
  let money = 0;
  let tp = 1;
  const win = goalsFor > goalsAgainst;
  if (ranked && opponent) {
    delta = eloDelta(c.elo, opponent.elo, goalsFor, goalsAgainst, c.played);
    const oppDelta = eloDelta(opponent.elo, c.elo, goalsAgainst, goalsFor, opponent.played);
    c.elo += delta;
    opponent.elo += oppDelta;
    tallyRecord(c, goalsFor, goalsAgainst);
    tallyRecord(opponent, goalsAgainst, goalsFor);
    const draw = goalsFor === goalsAgainst;
    money = forfeited ? 0 : (win ? 120_000 : draw ? 50_000 : 20_000) + goalsFor * 5_000;
    tp = win ? 3 : 2;
    save.budget += money;
    save.eloHistory.push(c.elo);
    simulateLadderRound(save, opponent.id);
    refreshMarket(save);
  }
  if ((ranked || competition) && win) tp += winTrainingBonus(save);
  if (forfeited) tp = 0;
  save.trainingPoints += tp;

  // Experience: the match itself, then a first ranked win. Forfeits earn nothing.
  award(save, matchXp(ranked ? 'ranked' : competition ? 'competition' : 'practice', goalsFor, goalsAgainst, forfeited, practice), xp);
  if (ranked && win && !forfeited) award(save, [claimMilestone(save, 'first-win')], xp);

  // One week passes per ranked or competition match once the season calendar
  // is unlocked (club level 10); friendlies never move it.
  const counted = (ranked || !!competition) && calendarOn;
  if (counted) save.week = (save.week ?? 0) + 1;

  // Match minutes develop players a little; the young ones more.
  const developments: string[] = [];
  for (const id of save.lineup) {
    const p = save.squad.find((x) => x.id === id);
    if (!p) continue;
    if (p.scout) p.scout--; // scouting fog lifts as a prospect plays
    if (forfeited) continue;
    const pGrow = p.age < 21 ? 0.35 : p.age <= 25 ? 0.2 : 0.08;
    if (overall(p) < p.potential && chance(save.rng, pGrow)) {
      const attr = pick(save.rng, ATTR_KEYS.filter((k) => k !== 'goalkeeping' || p.role === 'GK'));
      p.attrs[attr] = Math.min(99, p.attrs[attr] + 1);
      developments.push(`${shortName(p)} +1 ${ATTR_NAME[attr].toLowerCase()}`);
    }
  }

  save.history.push({ opponent: opponentName.name, opponentShort: opponentName.short, goalsFor, goalsAgainst, ranked, eloBefore, eloAfter: c.elo, scorers, ...(competition ? { competition } : {}), ...(counted ? { week: save.week } : {}) });
  const verb = goalsFor > goalsAgainst ? 'beat' : goalsFor === goalsAgainst ? 'drew with' : 'lost to';
  save.news.push(`${ranked ? 'Ranked' : competition ?? 'Friendly'}: ${verb} ${opponentName.name} ${goalsFor}–${goalsAgainst}${ranked ? ` (Elo ${delta >= 0 ? '+' : ''}${delta})` : ''}.`);
  if (save.news.length > 40) save.news.splice(0, save.news.length - 40);
  return { eloDelta: delta, money, trainingPoints: tp, developments, xp };
}

function tallyRecord(r: ClubRecord, gf: number, ga: number): void {
  r.played++;
  r.gf += gf;
  r.ga += ga;
  if (gf > ga) r.won++;
  else if (gf === ga) r.drawn++;
  else r.lost++;
}

/** Other ladder clubs play each other too, so the table moves between your matches. */
function simulateLadderRound(save: Save, skipId: string): void {
  const pool = save.ladder.filter((c) => c.id !== skipId);
  for (let i = 0; i < 3; i++) {
    const a = pick(save.rng, pool);
    const b = pick(save.rng, pool.filter((c) => c.id !== a.id));
    const ea = expectedScore(a.elo, b.elo);
    const roll = next(save.rng);
    const [ga, gb] = roll < ea * 0.8 ? [2, 1] : roll > 1 - (1 - ea) * 0.8 ? [1, 2] : [1, 1];
    const da = eloDelta(a.elo, b.elo, ga, gb, a.played);
    const db = eloDelta(b.elo, a.elo, gb, ga, b.played);
    a.elo += da;
    b.elo += db;
    tallyRecord(a, ga, gb);
    tallyRecord(b, gb, ga);
    a.quality = qualityForElo(a.elo);
    b.quality = qualityForElo(b.elo);
  }
}

export interface LadderRow {
  name: string;
  short: string;
  elo: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  you: boolean;
  primary: string;
  secondary: string;
}

export function ladderTable(save: Save): LadderRow[] {
  const rows: LadderRow[] = [
    ...save.ladder.map((c) => ({ ...pickRow(c), you: false })),
    { ...pickRow(save.club), you: true },
  ];
  return rows.sort((a, b) => b.elo - a.elo);
}

function pickRow(c: ClubIdentity & ClubRecord & { elo: number }): Omit<LadderRow, 'you'> {
  return { name: c.name, short: c.short, elo: c.elo, played: c.played, won: c.won, drawn: c.drawn, lost: c.lost, primary: c.primary, secondary: c.secondary };
}

export function isSave(x: unknown): x is Save {
  const s = x as Save;
  if (!(!!s && s.version === SAVE_VERSION && Array.isArray(s.squad) && Array.isArray(s.ladder) && !!s.club)) return false;
  // Competition fields are optional (older saves lack them) but must be the right shape when present.
  const objOrNull = (v: unknown) => v === undefined || v === null || typeof v === 'object';
  const numOrUndef = (v: unknown) => v === undefined || typeof v === 'number';
  return (
    objOrNull(s.cup) && objOrNull(s.season) && (s.trophies === undefined || Array.isArray(s.trophies)) &&
    // Club calendar fields (also optional).
    numOrUndef(s.week) && numOrUndef(s.year) && objOrNull(s.review) && (s.offers === undefined || Array.isArray(s.offers)) &&
    // Club level fields (also optional).
    numOrUndef(s.xp) && (s.unlocksSeen === undefined || Array.isArray(s.unlocksSeen)) && (s.milestones === undefined || Array.isArray(s.milestones))
  );
}
