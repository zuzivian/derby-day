// Difficulty that fits the player. Every club carries a hidden skill estimate,
// separate from Elo: Elo stays the honest ladder rating between clubs, the
// estimate is how well this person plays. It is on the CPU's own aiSkill scale:
// an estimate of 0.3 means "about an even match against a CPU side of skill
// 0.3 with a squad like yours".
//
// The estimate chooses the CPU's aiSkill for ranked and competition opponents,
// within a band around the club's natural skill: a new or struggling player
// meets a slower-thinking side, a strong one a sharper one, but a ladder club is
// never turned into a pushover or a machine. Its squad is never touched. Practice
// levels stay fixed, as labelled. The win chance shown before a match comes from
// the same model, fitted to what the fairness harness measures (scripts/fairness.ts),
// so the number on the screen is the chance the player really has.
//
// Pure: data in, data out, no randomness.

import { AI_SKILL_MIN } from '../sim/ai.ts';
import type { TeamSetup } from '../sim/types.ts';
import { cpuTeam, ladderSquad, type LadderClub } from './club.ts';
import type { Save } from './game.ts';

export interface SkillEstimate {
  /** The estimate, on the aiSkill scale (may go a little past 0..1 for the very weak or very strong). */
  est: number;
  /** CPU matches it has learned from. */
  n: number;
}

/** The aiSkill of a human's CPU teammates (client/main.ts playLive), which the model was fitted with. */
export const HOME_SKILL = 0.6;

/** Where a new player starts: a beginner's level, so the first ranked matches are winnable. */
export const NEW_EST = 0.1;
export const EST_MIN = -1;
export const EST_MAX = 1.3;

/**
 * The result model, fitted by `bun run fairness --calibrate`. The edge x = est - aiSkill -
 * STRENGTH_W * (their squad - ours, rating points); then win = L((x - DRAW_W) / SPREAD),
 * loss = L((-x - DRAW_W) / SPREAD), the rest a draw (an ordered logit).
 */
export const MODEL = { spread: 0.22, drawW: 0.1, strengthW: 0.03 } as const;

/** How far the CPU's aiSkill may go below and above a club's natural skill (club.ts toTeamSetup). */
export const BAND_DOWN = 0.75;
export const BAND_UP = 0.25;
/** The chance of a win the band aims at. About a quarter of matches are drawn, so this is a fair fight, a little in the player's favour. */
export const TARGET_WIN = 0.6;

const logistic = (x: number): number => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** A team's strength as the sim sees it: mean of each player's attributes (his goalkeeping for a keeper), 0..100. */
export function setupStrength(t: TeamSetup): number {
  let sum = 0;
  for (const p of t.players) {
    const a = p.attrs;
    sum += p.role === 'GK' ? a.goalkeeping : (a.pace + a.passing + a.shooting + a.dribbling + a.defending + a.stamina) / 6;
  }
  return (100 * sum) / Math.max(1, t.players.length);
}

export interface Outlook {
  win: number;
  draw: number;
  loss: number;
}

/** The chances of a human of estimate `est` steering `home` against the CPU `away` (its aiSkill as set). */
export function outlook(est: number, home: TeamSetup, away: TeamSetup): Outlook {
  const x = edge(est, away.aiSkill, setupStrength(away) - setupStrength(home));
  return outlookAt(x);
}

const edge = (est: number, aiSkill: number, gap: number): number => est - aiSkill - MODEL.strengthW * gap;

function outlookAt(x: number): Outlook {
  const win = logistic((x - MODEL.drawW) / MODEL.spread);
  const loss = logistic((-x - MODEL.drawW) / MODEL.spread);
  return { win, loss, draw: Math.max(0, 1 - win - loss) };
}

/** The edge at which the chance of a win is TARGET_WIN (the inverse of outlookAt's win). */
const TARGET_EDGE = MODEL.drawW + MODEL.spread * Math.log(TARGET_WIN / (1 - TARGET_WIN));

/** The club's estimate; a save from before estimates existed gets one from its record (ensureSkill). */
export const skillOf = (save: Save): SkillEstimate => save.skill ?? { est: NEW_EST, n: 0 };

/**
 * The aiSkill a CPU side with natural skill `natural` plays this human at: the one that gives
 * him a TARGET_WIN chance of winning, kept within BAND_DOWN below and BAND_UP above `natural`,
 * and between a rookie side (AI_SKILL_MIN, below the CPU's usual 0..1) and 1.
 */
export function bandedSkill(est: number, natural: number, gap: number): number {
  const want = est - MODEL.strengthW * gap - TARGET_EDGE;
  return Math.round(clamp(clamp(want, natural - BAND_DOWN, natural + BAND_UP), AI_SKILL_MIN, 1) * 1000) / 1000;
}

/** A ladder club as it lines up against this player: its own squad and shape, the CPU's skill from the band. */
export function opponentSetup(save: Save, opp: LadderClub, home: TeamSetup): TeamSetup {
  const natural = cpuTeam(opp, ladderSquad(opp));
  return { ...natural, aiSkill: bandedSkill(skillOf(save).est, natural.aiSkill, setupStrength(natural) - setupStrength(home)) };
}

/** Learning rate: fast for the first few matches so a newcomer's level is found quickly, then steadier. */
export const kFor = (n: number): number => (n < 4 ? 0.6 : n < 10 ? 0.35 : 0.15);

/**
 * Learn from a finished match against the CPU (any: ranked, competition, practice, warm-up),
 * Elo-style: move the estimate by whether he won against the chance the model gave him, a
 * bigger margin counting a little more. It learns from wins, not points, because the win
 * chance is what the gauge shows: a player who draws 0–0 a lot but never wins (one who never
 * shoots) has his chance fall toward nothing, as it really is. A forfeit counts as a defeat.
 */
export function learnSkill(save: Save, home: TeamSetup, away: TeamSetup, goalsFor: number, goalsAgainst: number): SkillEstimate {
  const cur = skillOf(save);
  const e = outlook(cur.est, home, away).win;
  const actual = goalsFor > goalsAgainst ? 1 : 0;
  const margin = 1 + 0.25 * Math.min(3, Math.max(0, Math.abs(goalsFor - goalsAgainst) - 1));
  const next = { est: clamp(cur.est + kFor(cur.n) * margin * (actual - e), EST_MIN, EST_MAX), n: cur.n + 1 };
  save.skill = next;
  return next;
}

/** A save from before estimates existed starts as a newcomer, nudged by its last 20 ranked results. */
export function ensureSkill(save: Save): void {
  if (save.skill && Number.isFinite(save.skill.est) && Number.isFinite(save.skill.n)) return;
  if (!save.history.length) {
    delete save.skill;
    return;
  }
  const recent = save.history.filter((m) => m.ranked).slice(-20);
  const pts = recent.reduce((t, m) => t + (m.goalsFor > m.goalsAgainst ? 1 : m.goalsFor === m.goalsAgainst ? 0.5 : 0), 0);
  const share = recent.length ? pts / recent.length : 0.5;
  // Winning every match of six or more lifts it 0.3; losing every one drops it as far.
  save.skill = { est: clamp(NEW_EST + (share - 0.5) * 0.6 * Math.min(1, recent.length / 6), EST_MIN, EST_MAX), n: Math.min(recent.length, 12) };
}
