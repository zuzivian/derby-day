// Scripted humans for the fairness harness (scripts/fairness.ts): a handful of
// player behaviours, from someone who never touches the mouse to a sharp
// player, that drive a side through the real step() with humans:[true,false],
// exactly as the client's input would. Pure (no DOM). Each bot reads the state
// and returns a HumanInput; any randomness comes from its own seeded stream,
// never from the match's, so a bot never changes what the CPU would do.

import { bestPassOption } from '../sim/ai.ts';
import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W } from '../sim/constants.ts';
import { attackDir, oppGoal, ownGoal, teamX } from '../sim/field.ts';
import { createMatch, possessionShare, step, type MatchOptions } from '../sim/match.ts';
import { applyResult, clubTeam, newGame, pickOpponent } from './game.ts';
import { HOME_SKILL, learnSkill, opponentSetup, outlook, skillOf, winChance } from './skill.ts';
import { rankedOpen, warmupTeam } from './warmup.ts';
import { makeRng, next, type Rng } from '../sim/rng.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../sim/types.ts';
import { add, clamp, dist, len, norm, scale, sub, type Vec } from '../sim/vec.ts';

export type BotId = 'passive' | 'follow' | 'flail' | 'chaser' | 'competent' | 'strong' | 'strongcpu';
export const BOT_IDS: BotId[] = ['passive', 'follow', 'flail', 'chaser', 'competent', 'strong'];

export const BOT_LABEL: Record<BotId, string> = {
  passive: 'never touches the mouse',
  follow: 'pointer on the ball, no clicks',
  flail: 'pointer jumps about, random clicks',
  chaser: 'runs at the ball, tackles, shoots early',
  competent: 'passes to open teammates, shoots in range',
  strong: 'the CPU passing brain, sharp tackles and shots',
  strongcpu: 'diagnostic: strong on the ball, the CPU positions him off it',
};

type Bot = (s: MatchState, team: 0 | 1) => HumanInput;

const me = (s: MatchState, team: 0 | 1): MatchPlayer => s.players[s.controlled[team]];
const opponentsOf = (s: MatchState, team: 0 | 1) => s.players.filter((o) => o.team !== team && !o.sentOff);

/** Nearest opponent to a point, and how far. */
function nearestOpp(s: MatchState, team: 0 | 1, at: Vec): { o: MatchPlayer | null; d: number } {
  let o: MatchPlayer | null = null;
  let d = Infinity;
  for (const x of opponentsOf(s, team)) {
    const k = dist(x.pos, at);
    if (k < d) {
      d = k;
      o = x;
    }
  }
  return { o, d };
}

/** Distance from point p to segment a-b. */
function segDist(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  const u = l2 > 0 ? clamp(((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2, 0, 1) : 0;
  return dist(p, add(a, scale(ab, u)));
}

/** A cursor `ahead` metres from the player in direction `dir` (sets the speed: 4 m jog, 8 m run, 11+ sprint). */
const towards = (p: MatchPlayer, to: Vec, ahead: number): Vec => add(p.pos, scale(norm(sub(to, p.pos)), ahead));

/** Where to aim a shot: the post the keeper is further from, a little inside. */
function shotAim(s: MatchState, p: MatchPlayer): Vec {
  const goal = oppGoal(p.team);
  const gk = s.players.find((o) => o.team !== p.team && o.role === 'GK' && !o.sentOff);
  const top = { x: goal.x, y: GOAL_TOP + 0.8 };
  const bottom = { x: goal.x, y: GOAL_BOTTOM - 0.8 };
  if (!gk) return goal;
  return segDist(gk.pos, p.pos, top) > segDist(gk.pos, p.pos, bottom) ? top : bottom;
}

/** Defending without the ball: get goal-side of the carrier, tackle when close. Loose ball: run onto it. */
function defend(s: MatchState, team: 0 | 1, p: MatchPlayer, tackleR: number, lead: number, patient = false): HumanInput {
  const b = s.ball;
  const owner = b.owner >= 0 ? s.players[b.owner] : null;
  if (owner && owner.team !== team) {
    const goalSide = add(owner.pos, add(scale(owner.vel, lead), scale(norm(sub(ownGoal(team), owner.pos)), patient ? 1.4 : 1)));
    const d = dist(p.pos, owner.pos);
    // A patient defender only goes in from in front of the man, never through his back.
    const inFront = !patient || (d > 0 && (owner.facing.x * (p.pos.x - owner.pos.x) + owner.facing.y * (p.pos.y - owner.pos.y)) / d > -0.2);
    if (d < tackleR && p.tackleCd === 0 && !b.inHands && inFront) return { cursor: owner.pos, tackle: true, aim: owner.pos, moved: true };
    return { cursor: d < 3 ? goalSide : towards(p, goalSide, Math.max(4, Math.min(14, dist(p.pos, goalSide) + 2))), moved: true };
  }
  const spot = add(b.pos, scale(b.vel, lead));
  return { cursor: towards(p, spot, Math.max(4, Math.min(14, dist(p.pos, spot) + 3))), moved: true };
}

const passive: Bot = () => ({});

const follow: Bot = (s) => ({ cursor: { ...s.ball.pos }, moved: true });

function makeFlail(seed: number): Bot {
  const r = makeRng(seed);
  let cursor: Vec = { x: PITCH_W / 2, y: PITCH_H / 2 };
  return (s) => {
    if (next(r) < 0.03) cursor = { x: s.ball.pos.x + (next(r) - 0.5) * 40, y: clamp(s.ball.pos.y + (next(r) - 0.5) * 30, 0, PITCH_H) };
    const click = next(r);
    if (click < 0.01) return { cursor, pass: true, select: true, moved: true };
    if (click < 0.015) return { cursor, shoot: next(r), tackle: true, moved: true };
    return { cursor, moved: true };
  };
}

const chaser: Bot = (s, team) => {
  const p = me(s, team);
  const b = s.ball;
  if (b.owner === p.i) {
    const goal = oppGoal(team);
    if (dist(p.pos, goal) < 26) return { cursor: goal, shoot: 0.8, aim: shotAim(s, p), moved: true };
    if (b.inHands) return { cursor: goal, shoot: 1, aim: add(p.pos, { x: attackDir(team) * 50, y: 0 }), moved: true };
    return { cursor: towards(p, goal, 12), moved: true };
  }
  return defend(s, team, p, 2.2, 0.3);
};

/** Has the ball: shoot in range, pass to the most open teammate ahead when pressed or after a short carry, else run at goal. */
function makeCompetent(): Bot {
  let held = 0;
  return (s, team) => {
    const p = me(s, team);
    const b = s.ball;
    if (b.owner !== p.i) {
      held = 0;
      return defend(s, team, p, 1.8, 0.4);
    }
    held++;
    const goal = oppGoal(team);
    const dGoal = dist(p.pos, goal);
    const pressure = nearestOpp(s, team, p.pos).d;
    if (!b.inHands && s.phase === 'play' && dGoal < 22 && Math.abs(p.pos.y - PITCH_H / 2) < 15) return { cursor: goal, shoot: 0.72, aim: shotAim(s, p), moved: true };
    if (s.phase === 'restart' || b.inHands || pressure < 3.5 || held > 50) {
      const best = openMate(s, team, p, b.inHands || s.phase === 'restart');
      if (best) return { cursor: p.pos, pass: true, aim: { ...best.pos }, moved: true };
      if (b.inHands) return held > 120 ? { cursor: p.pos, shoot: 0.8, aim: add(p.pos, { x: attackDir(team) * 50, y: 0 }) } : { cursor: p.pos };
    }
    if (s.phase === 'restart') return { cursor: p.pos };
    return { cursor: towards(p, goal, 9), moved: true };
  };
}

/** The teammate a plain player would pick: 6-30 m away, unmarked, the lane clear, the further forward the better. */
function openMate(s: MatchState, team: 0 | 1, p: MatchPlayer, anyDirection: boolean): MatchPlayer | null {
  let best: MatchPlayer | null = null;
  let bestScore = -Infinity;
  const px = teamX(team, p.pos.x);
  for (const m of s.players) {
    if (m.team !== team || m.i === p.i || m.sentOff || m.role === 'GK') continue;
    const d = dist(p.pos, m.pos);
    if (d < 6 || d > 30) continue;
    const marker = nearestOpp(s, team, m.pos).d;
    let lane = Infinity;
    for (const o of opponentsOf(s, team)) lane = Math.min(lane, segDist(o.pos, p.pos, m.pos));
    if (marker < 2.5 || lane < 1.6) continue;
    const gain = (teamX(team, m.pos.x) - px) * PITCH_W;
    if (!anyDirection && gain < -12) continue;
    const score = gain * 0.12 + Math.min(marker, 8) * 0.4 + Math.min(lane, 5) * 0.4 - d * 0.03;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/** A rough chance of scoring from here (the shape of the CPU's own estimate in ai.ts evalShot). */
function shotChance(s: MatchState, p: MatchPlayer, aim: Vec): number {
  const goal = oppGoal(p.team);
  const d = dist(p.pos, goal);
  const dx = Math.max(0.5, Math.abs(goal.x - p.pos.x));
  const angle = Math.abs(Math.atan2(GOAL_BOTTOM - p.pos.y, dx) - Math.atan2(GOAL_TOP - p.pos.y, dx));
  const central = clamp(angle / (2 * Math.atan((GOAL_BOTTOM - GOAL_TOP) / 2 / Math.max(d, 0.5))), 0.15, 1);
  let blockers = 0;
  for (const o of opponentsOf(s, p.team)) if (o.role !== 'GK' && segDist(o.pos, p.pos, aim) < 0.9 && dist(o.pos, p.pos) < d) blockers++;
  return 0.8 * Math.exp(-d / 6.5) * central * (0.55 + 0.7 * p.attrs.shooting) * Math.pow(0.5, blockers);
}

/**
 * Plays like a good human: the CPU's own pass evaluation (no noise) with the pointer's
 * accuracy, a decision every few ticks as a person makes them, shots when the chance is
 * there, a carry into open grass, sharp tackles.
 */
function makeStrong(cpuOffBall = false): Bot {
  let held = 0;
  let nextLook = 0;
  return (s, team) => {
    const p = me(s, team);
    const b = s.ball;
    if (b.owner !== p.i) {
      held = 0;
      nextLook = 0;
      // Diagnostic: leave the pointer still, so after each automatic switch the CPU positions him.
      if (cpuOffBall) return { cursor: { ...p.pos } };
      return defend(s, team, p, 1.5, 0.45, true);
    }
    held++;
    const goal = oppGoal(team);
    const pressure = nearestOpp(s, team, p.pos).d;
    const restart = s.phase === 'restart' || b.inHands;
    const aim = shotAim(s, p);
    // Open grass ahead to carry into.
    let clear = 9;
    for (const o of opponentsOf(s, team)) {
      const to = sub(o.pos, p.pos);
      if (len(to) < 9 && to.x * attackDir(team) > -0.5) clear = Math.min(clear, len(to));
    }
    if (held >= nextLook || pressure < 2.2) {
      nextLook = held + 8;
      if (!restart && shotChance(s, p, aim) > 0.012) return { cursor: goal, shoot: clamp(0.78 + dist(p.pos, goal) * 0.008, 0.6, 0.97), aim, moved: true };
      const opt = bestPassOption(s, p, 0);
      const px = teamX(team, p.pos.x);
      const carry = clamp((clear - 2.5) / 4, 0, 1) * (3 + 2 * clamp((px - 0.45) * 4, 0, 1)) * (px > 0.7 ? 0.45 : 1);
      if (opt && (restart || (pressure < 2.3 && opt.score > -0.4) || opt.score > carry + 1.5 - 0.4 * p.attrs.passing || held > 150)) {
        if (opt.lofted) return { cursor: p.pos, loft: clamp(dist(p.pos, opt.target) / 50, 0.1, 1), aim: { ...opt.target }, moved: true };
        return { cursor: p.pos, pass: true, aim: { ...opt.receiver.pos }, moved: true };
      }
    }
    if (restart) return { cursor: p.pos };
    // Carry toward goal, steering round whoever is in front.
    let way = norm(sub(goal, p.pos));
    for (const o of opponentsOf(s, team)) {
      const to = sub(o.pos, p.pos);
      const d = len(to);
      if (d > 6 || to.x * way.x + to.y * way.y <= 0) continue;
      const side = to.x * way.y - to.y * way.x > 0 ? 1 : -1;
      way = norm(add(way, scale({ x: -way.y * side, y: way.x * side }, ((6 - d) / 6) * 1.3)));
    }
    if (p.pos.y < 4) way.y += 0.8;
    if (p.pos.y > PITCH_H - 4) way.y -= 0.8;
    return { cursor: add(p.pos, scale(norm(way), clear > 5 ? 12 : 7)), moved: true };
  };
}

export function makeBot(id: BotId, seed: number): Bot {
  switch (id) {
    case 'passive':
      return passive;
    case 'follow':
      return follow;
    case 'flail':
      return makeFlail(seed ^ 0xf1a1);
    case 'chaser':
      return chaser;
    case 'competent':
      return makeCompetent();
    case 'strong':
      return makeStrong();
    case 'strongcpu':
      return makeStrong(true);
  }
}

/** What a fairness run measures for the human side (team 0). */
export interface FairnessResult {
  gf: number;
  ga: number;
  shots: number;
  shotsAgainst: number;
  possession: number;
  /** Opponent-carrier ticks when nobody on the human's side was within 3 m of the carrier. */
  unpressed: number;
  /** Opponent-carrier ticks in total. */
  defending: number;
  /** Of the defending ticks, those in which the human's own player was the nearest to the carrier. */
  humanNearest: number;
  /** Times the human's player lost the ball to an opponent (tackled or a pass cut out). */
  humanLosses: number;
  /** Touches (possessions) by the human's player. */
  humanTouches: number;
  /** Defending ticks in which the side's plan had no CPU chaser and the human's man was more than 3 m from the carrier: nobody pressing. */
  noChaser: number;
  /** Defending ticks in which the human's man stood still (under 0.5 m/s) more than 5 m from the carrier. */
  humanStill: number;
}

/** Play one match: team 0 human (bot), or the CPU when bot is null. */
export function playFairness(o: Omit<MatchOptions, 'humanTeam' | 'humans'>, bot: BotId | null): FairnessResult {
  const s = createMatch({ ...o, humans: [bot !== null, false] });
  const drive = bot ? makeBot(bot, o.seed) : null;
  let unpressed = 0;
  let defending = 0;
  let humanNearest = 0;
  let humanLosses = 0;
  let humanTouches = 0;
  let noChaser = 0;
  let humanStill = 0;
  let lastOwner = -1;
  let humanHad = false;
  while (s.phase !== 'fulltime') {
    step(s, drive ? drive(s, 0) : undefined);
    if (s.phase !== 'play') continue;
    const b = s.ball;
    const owner = b.owner >= 0 ? s.players[b.owner] : null;
    if (owner && owner.i !== lastOwner) {
      if (owner.team === 1 && humanHad) humanLosses++;
      // Whoever has the ball on a human side is the human's player (human.ts updateControl).
      humanHad = owner.team === 0;
      if (humanHad) humanTouches++;
      lastOwner = owner.i;
    }
    if (owner && owner.team === 1) {
      defending++;
      let nearest: MatchPlayer | null = null;
      let nd = Infinity;
      for (const m of s.players) {
        if (m.team !== 0 || m.sentOff || m.role === 'GK') continue;
        const d = dist(m.pos, owner.pos);
        if (d < nd) {
          nd = d;
          nearest = m;
        }
      }
      if (nd > 3) unpressed++;
      if (nearest && nearest.i === s.controlled[0]) humanNearest++;
      const h = bot ? s.players[s.controlled[0]] : null;
      const dh = h ? dist(h.pos, owner.pos) : Infinity;
      if ((s.aiPlans?.[0]?.chaser ?? -1) < 0 && dh > 3) noChaser++;
      if (h && dh > 5 && len(h.vel) < 0.5) humanStill++;
    }
  }
  return {
    gf: s.score[0],
    ga: s.score[1],
    shots: s.stats[0].shots,
    shotsAgainst: s.stats[1].shots,
    possession: possessionShare(s)[0],
    unpressed,
    defending,
    humanNearest,
    humanLosses,
    humanTouches,
    noChaser,
    humanStill,
  };
}

/** Seeded per-run rng for picking opponents, separate from any save's. */
export const harnessRng = (seed: number): Rng => makeRng(seed);

// ---------------------------------------------------------------------------
// A career: a new club played match after match the way the game plays it

/** One match of a career, as the harness records it. */
export interface CareerMatch {
  ranked: boolean;
  gf: number;
  ga: number;
  /** The win chance the game showed before kick-off (skill.ts winChance); for warm-ups, the model's chance. */
  shown: number;
  /** The CPU's aiSkill in this match. */
  aiSkill: number;
  /** The skill estimate after the match. */
  est: number;
  /** The opponent club's Elo and our own before kick-off (ranked only). */
  oppElo: number;
  elo: number;
}

/**
 * A new club (newGame(seed)) played for `matches` matches by `bot`, exactly as the client does it:
 * the first match and warm-ups until ranked opens, then ranked against pickOpponent's choice, its
 * CPU skill from the estimate (opponentSetup). The estimate learns after every match (learnSkill)
 * and applyResult moves Elo, XP and the ladder.
 */
export function playCareer(bot: BotId | null, seed: number, matches: number, topMatches = 0): { career: CareerMatch[]; top: CareerMatch[] } {
  const save = newGame(seed);
  const out: CareerMatch[] = [];
  for (let k = 0; k < matches; k++) {
    const home = clubTeam(save, HOME_SKILL);
    const ranked = rankedOpen(save);
    const opp = ranked ? pickOpponent(save) : null;
    const away = opp ? opponentSetup(save, opp, home) : warmupTeam(save, save.history.length === 0).away;
    const shown = opp ? winChance(save, opp) : outlook(skillOf(save).est, home, away).win;
    const elo = save.club.elo;
    const r = playFairness({ seed: (seed * 131 + k * 7919) | 0, home, away }, bot);
    const est = learnSkill(save, home, away, r.gf, r.ga).est;
    if (opp) applyResult(save, opp, { name: away.name, short: away.short }, r.gf, r.ga, true, []);
    else applyResult(save, null, { name: away.name, short: away.short }, r.gf, r.ga, false, [], 'Warm-up friendly', false, 'easy');
    out.push({ ranked, gf: r.gf, ga: r.ga, shown, aiSkill: away.aiSkill, est, oppElo: opp?.elo ?? 0, elo });
  }
  // Then, with the estimate it has earned, a few friendlies against the top of the ladder (nothing recorded).
  const top: CareerMatch[] = [];
  const best = [...save.ladder].sort((a, b) => b.elo - a.elo);
  for (let k = 0; k < topMatches; k++) {
    const opp = best[k % 3];
    const home = clubTeam(save, HOME_SKILL);
    const away = opponentSetup(save, opp, home);
    const r = playFairness({ seed: (seed * 977 + k * 104729) | 0, home, away }, bot);
    top.push({ ranked: true, gf: r.gf, ga: r.ga, shown: winChance(save, opp), aiSkill: away.aiSkill, est: skillOf(save).est, oppElo: opp.elo, elo: save.club.elo });
  }
  return { career: out, top };
}
