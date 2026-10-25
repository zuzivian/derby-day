// The club-management loop: squad, transfers, training, ladder and Elo.
// Everything here is plain data in, plain data out, so it can move behind an
// API unchanged when the economy goes server-side.

import { DEFAULT_FORMATION, FORMATIONS, TEAM_SIZE, type FormationId, type Role } from '../sim/constants.ts';
import { chance, makeRng, next, pick, type Rng } from '../sim/rng.ts';
import type { TeamSetup } from '../sim/types.ts';
import {
  assignNumbers,
  autoLineup,
  eloForQuality,
  emptyRecord,
  generateIdentity,
  generateSquad,
  toTeamSetup,
  type ClubIdentity,
  type ClubRecord,
  type LadderClub,
} from './club.ts';
import type { Cup, Season, Trophy } from './competitions.ts';
import { eloDelta, expectedScore, START_ELO } from './elo.ts';
import type { SeasonReview } from './progression.ts';
import { pushHistory, type ClubRecords, type SeasonSummary } from './history.ts';
import { award, claimMilestone, isUnlocked, marketSize, matchXp, squadCap, startGain, UNLOCKS_VERSION, winTrainingBonus, XP, type MilestoneId, type PracticeLevel, type UnlockId, type XpGain } from './levels.ts';
import type { PendingMatch } from './pending.ts';
import { divisionMoney, divisionXp, generateWorld, playerDivision, START_DIVISION, WORLD_CPU_CLUBS } from './world.ts';
import { ATTR_KEYS, ATTR_NAME, generatePlayer, marketValue, overall, shortName, trainingGain, type AttrKey, type Player } from './player.ts';

export const SAVE_VERSION = 1;
/**
 * Squad size rules for eleven-a-side. A new club has 18 (11 starters and 7 on
 * the bench). The cap is 24 (club-level perks add up to three more, squadCap
 * in levels.ts); you can't sell or retire below 14: an XI plus a keeper and
 * two outfield cover. Saves from the six-a-side days are topped up to 18 and
 * get an eleven-man lineup on load (ensureElevenASide).
 */
export const MAX_SQUAD = 24;
export const MIN_SQUAD = TEAM_SIZE + 3;
/** CPU clubs in the world: four divisions of eight with you (src/meta/world.ts). */
export const LADDER_SIZE = WORLD_CPU_CLUBS;
/** Ranked or league matches to play after a cup before the next one can start. */
export const CUP_WAIT = 4;
/** The transfer market also refreshes when this long has passed (client clock), whatever you play. */
export const MARKET_REFRESH_MS = 6 * 3600 * 1000;

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
  /** Left early or abandoned: recorded as 0–3. */
  forfeited?: boolean;
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
  /** Version of the unlock table this save has been migrated to (UNLOCKS_VERSION in levels.ts). */
  unlocksV?: number;
  /** Set when the save was migrated from the old unlock table: features open at the earlier of the old and new levels. */
  legacyUnlocks?: boolean;
  /** The club's formation (FORMATIONS in sim/constants.ts). Default 4-4-2. The lineup is in its slot order. */
  formation?: FormationId;
  // The world (src/meta/world.ts) and the economy around it. Optional so older
  // saves still load; ensureWorldFields() and ensureHistoryFields() fill them.
  /** Your division, 1 (top) to DIVISIONS. */
  division?: number;
  /** The ranked opponent on offer (a ladder club id). Fixed once offered, so a reload can't change it. */
  nextOpp?: string | null;
  /** A recorded match that kicked off and hasn't finished (src/meta/pending.ts). Settled as a forfeit on the next boot. */
  pending?: PendingMatch | null;
  /** Matches dropped off the front of `history` (HISTORY_CAP in history.ts). */
  historyBase?: number;
  /** Lifetime totals and records, which outlive the capped history. */
  records?: ClubRecords;
  /** One entry per finished calendar year. */
  seasons?: SeasonSummary[];
  /** Notes for this year's club history entry ("Cup 6: winners"). */
  yearNotes?: string[];
  /** Ranked or league matches still to play before another cup can start. */
  cupWait?: number;
  /** When the transfer market was last refreshed (client clock, ms). Only the timed refresh reads it. */
  marketAt?: number;
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
    lineup: autoLineup(squad, DEFAULT_FORMATION),
    formation: DEFAULT_FORMATION,
    budget: 1_200_000,
    trainingPoints: 6,
    eloHistory: [START_ELO],
    ladder: generateWorld(seed ^ 0x5eed),
    division: START_DIVISION,
    nextOpp: null,
    pending: null,
    historyBase: 0,
    seasons: [],
    yearNotes: [],
    cupWait: 0,
    market: [],
    history: [],
    week: 0,
    year: 1,
    review: null,
    offers: [],
    xp: 0,
    unlocksSeen: [],
    unlocksV: UNLOCKS_VERSION,
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

/** A signed change as players read it everywhere: "+3", "−17" (a true minus), "±0". */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0';
}

export function formatMoney(n: number): string {
  if (n >= 1_000_000) return `ƒ${(n / 1_000_000).toFixed(2)}m`;
  return `ƒ${Math.round(n / 1000)}k`;
}

const round5k = (n: number) => Math.round(n / 5_000) * 5_000;
export const askingPrice = (p: Player): number => round5k(marketValue(p) * 1.1);
export const salePrice = (p: Player): number => round5k(marketValue(p) * 0.8);

/** Refresh the market if MARKET_REFRESH_MS has passed since the last refresh. `now` is the client's clock. Returns true if it refreshed. */
export function refreshMarketIfStale(save: Save, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  // The first stamp only starts the clock, and a clock that went backwards just restarts it.
  if (save.marketAt === undefined || now < save.marketAt) {
    save.marketAt = now;
    return false;
  }
  if (now - save.marketAt < MARKET_REFRESH_MS) return false;
  save.marketAt = now;
  refreshMarket(save);
  return true;
}

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
  if (save.lineup.includes(id)) save.lineup = autoLineup(save.squad, save.formation);
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

/** Has the club picked a full XI? */
export const lineupReady = (save: Save): boolean => save.lineup.filter(Boolean).length >= TEAM_SIZE;

/** The player's own club as the sim sees it. */
export function clubTeam(save: Save, aiSkill: number): TeamSetup {
  return toTeamSetup(save.club, save.squad, save.lineup, aiSkill, save.formation);
}

/** Change formation: the lineup is re-picked for the new slots. */
export function setFormation(save: Save, formation: FormationId): void {
  if (!FORMATIONS[formation]) return;
  save.formation = formation;
  save.lineup = autoLineup(save.squad, formation);
}

/**
 * Bring a save from the six-a-side game up to eleven-a-side: top the squad up
 * to 18 with players of about its current level (two of each outfield role
 * at least, a second keeper), and pick an eleven-man lineup. Safe to call on
 * every load.
 */
export function ensureElevenASide(save: Save): void {
  save.formation ??= DEFAULT_FORMATION;
  if (save.squad.length < 18) {
    const r = makeRng((save.seed ^ 0x11a51de) | 0);
    const avg = save.squad.length ? Math.round(save.squad.reduce((t, p) => t + overall(p), 0) / save.squad.length) : 54;
    const want: Record<Role, number> = { GK: 2, DEF: 6, MID: 6, FWD: 4 };
    for (const p of save.squad) want[p.role]--;
    const roles = (['DEF', 'MID', 'FWD', 'GK'] as Role[]).flatMap((role) => new Array(Math.max(0, want[role])).fill(role) as Role[]);
    while (save.squad.length < 18) {
      const role = roles.shift() ?? (['DEF', 'MID', 'FWD'] as Role[])[save.squad.length % 3];
      save.squad.push(generatePlayer(r, { role, quality: avg - 3 + Math.floor(next(r) * 5) }));
    }
    assignNumbers(save.squad);
    save.news.push('The club moves up to eleven-a-side: the board has signed players to make up a squad of 18.');
  }
  const ok = save.lineup.length === TEAM_SIZE && save.lineup.every((id) => save.squad.some((p) => p.id === id)) && new Set(save.lineup).size === TEAM_SIZE;
  if (!ok) save.lineup = autoLineup(save.squad, save.formation);
}

/**
 * The ranked opponent on offer. It is picked once (pickOpponent) and kept on
 * the save until that match is played, so reloading can't re-roll it.
 */
export function offeredOpponent(save: Save): LadderClub {
  const kept = save.nextOpp ? save.ladder.find((c) => c.id === save.nextOpp) : undefined;
  if (kept) return kept;
  const opp = pickOpponent(save);
  save.nextOpp = opp.id;
  return opp;
}

/**
 * What a ranked match against `opp` pays, as a multiplier on the money and XP
 * tables (cup and league matches use its XP side): the opponent's division (DIVISION_MONEY, DIVISION_XP), times 0.7 to
 * 1.3 by how unlikely you were to win (expected score 1 to 0). Beating a weak
 * club pays less than beating an equal one, so losing Elo on purpose to meet
 * weaker clubs never pays.
 */
export function rankedScale(save: Save, opp: LadderClub): { xp: number; money: number } {
  const odds = 0.7 + 0.6 * (1 - expectedScore(save.club.elo, opp.elo));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { xp: r2(divisionXp(opp.division) * odds), money: r2(divisionMoney(opp.division) * odds) };
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

/** Ranked money by result, before rankedScale: a win, a draw, a defeat, and each goal scored. */
export const RANKED_MONEY = { win: 120_000, draw: 50_000, loss: 20_000, goal: 5_000 } as const;

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
  /** For a cup or league match (src/meta/competitions.ts): which one. With `opponent` it moves Elo and pays XP like a ranked match (rankedScale); prize money is the competition's. */
  comp?: 'cup' | 'league',
): ResultSummary {
  const c = save.club;
  const xp = startGain(save);
  // Checked before this match's XP lands, so the calendar starts with the match after it unlocks.
  const calendarOn = isUnlocked(save, 'calendar');
  const eloBefore = c.elo;
  let delta = 0;
  let money = 0;
  let tp = 1;
  let xpScale = 1;
  const win = goalsFor > goalsAgainst;
  // Ranked, cup and league matches all move Elo, both ways. Only ranked ones count in the ladder record.
  const rated = !!opponent && (ranked || !!comp);
  // Read before the Elo moves, so the stake is the one shown before kick-off. Cup and league matches pay XP the same way.
  const scale = rated ? rankedScale(save, opponent) : null;
  if (scale) xpScale = scale.xp;
  if (rated) {
    delta = eloDelta(c.elo, opponent.elo, goalsFor, goalsAgainst, c.played);
    const oppDelta = eloDelta(opponent.elo, c.elo, goalsAgainst, goalsFor, opponent.played);
    c.elo += delta;
    opponent.elo += oppDelta;
    save.eloHistory.push(c.elo);
  }
  if (ranked && opponent && scale) {
    tallyRecord(c, goalsFor, goalsAgainst);
    tallyRecord(opponent, goalsAgainst, goalsFor);
    const draw = goalsFor === goalsAgainst;
    const base = (win ? RANKED_MONEY.win : draw ? RANKED_MONEY.draw : RANKED_MONEY.loss) + goalsFor * RANKED_MONEY.goal;
    money = forfeited ? 0 : Math.round((base * scale.money) / 5_000) * 5_000;
    tp = win ? 3 : 2;
    save.budget += money;
    simulateLadderRound(save, opponent.id);
    save.nextOpp = null; // the next offer is picked fresh
  }
  if ((ranked || competition) && win) tp += winTrainingBonus(save);
  if (forfeited) tp = 0;
  save.trainingPoints += tp;
  // Every match you finish brings new names to the market (time does too: refreshMarketIfStale).
  if (!forfeited) refreshMarket(save);
  // A cup can start again once enough ranked or league matches have been played since the last one.
  if (!forfeited && (ranked || comp === 'league') && (save.cupWait ?? 0) > 0) save.cupWait = save.cupWait! - 1;

  // Experience: the match itself, then a first ranked win. Forfeits earn nothing.
  award(save, matchXp(ranked ? 'ranked' : competition ? 'competition' : 'practice', goalsFor, goalsAgainst, forfeited, practice, xpScale), xp);
  if (ranked && win && !forfeited) award(save, [claimMilestone(save, 'first-win')], xp);

  // One week passes per ranked or competition match played once the season
  // calendar is unlocked (club level 10); friendlies and forfeits never move it.
  const counted = (ranked || !!competition) && calendarOn && !forfeited;
  if (counted) save.week = (save.week ?? 0) + 1;
  save.pending = null; // whatever kicked off has now been recorded

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

  pushHistory(save, { opponent: opponentName.name, opponentShort: opponentName.short, goalsFor, goalsAgainst, ranked, eloBefore, eloAfter: c.elo, scorers, ...(competition ? { competition } : {}), ...(counted ? { week: save.week } : {}), ...(forfeited ? { forfeited } : {}) });
  const verb = goalsFor > goalsAgainst ? 'beat' : goalsFor === goalsAgainst ? 'drew with' : 'lost to';
  save.news.push(`${ranked ? 'Ranked' : competition ?? 'Friendly'}: ${verb} ${opponentName.name} ${goalsFor}–${goalsAgainst}${rated ? ` (Elo ${signed(delta)})` : ''}.`);
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

/**
 * Other ladder clubs play each other too, so the table moves between your
 * matches. The odds come from the clubs' squad quality (eloForQuality), not
 * their Elo, so a club's Elo drifts toward what its squad is worth: beating a
 * club takes its Elo, never its players.
 */
function simulateLadderRound(save: Save, skipId: string): void {
  const pool = save.ladder.filter((c) => c.id !== skipId);
  for (let i = 0; i < 3; i++) {
    const a = pick(save.rng, pool);
    const b = pick(save.rng, pool.filter((c) => c.id !== a.id));
    const ea = expectedScore(eloForQuality(a.quality), eloForQuality(b.quality));
    const roll = next(save.rng);
    const [ga, gb] = roll < ea * 0.8 ? [2, 1] : roll > 1 - (1 - ea) * 0.8 ? [1, 2] : [1, 1];
    const da = eloDelta(a.elo, b.elo, ga, gb, a.played);
    const db = eloDelta(b.elo, a.elo, gb, ga, b.played);
    a.elo += da;
    b.elo += db;
    tallyRecord(a, ga, gb);
    tallyRecord(b, gb, ga);
  }
}

export interface LadderRow {
  name: string;
  /** Division, 1 (top) to DIVISIONS. */
  division: number;
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
    ...save.ladder.map((c) => ({ ...pickRow(c), division: c.division ?? START_DIVISION, you: false })),
    { ...pickRow(save.club), division: playerDivision(save), you: true },
  ];
  return rows.sort((a, b) => b.elo - a.elo);
}

function pickRow(c: ClubIdentity & ClubRecord & { elo: number }): Omit<LadderRow, 'you' | 'division'> {
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
    numOrUndef(s.xp) && (s.unlocksSeen === undefined || Array.isArray(s.unlocksSeen)) && (s.milestones === undefined || Array.isArray(s.milestones)) &&
    // World and history fields (also optional).
    numOrUndef(s.division) && numOrUndef(s.historyBase) && numOrUndef(s.cupWait) && numOrUndef(s.marketAt) &&
    (s.nextOpp === undefined || s.nextOpp === null || typeof s.nextOpp === 'string') && objOrNull(s.pending) && objOrNull(s.records) &&
    (s.seasons === undefined || Array.isArray(s.seasons)) && (s.yearNotes === undefined || Array.isArray(s.yearNotes))
  );
}
