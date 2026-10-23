// Fixed-timestep, seeded match simulation. step() is a pure function of
// (state, human input): no DOM, no clocks, no Math.random. That property is
// what makes server authority, replays and rollback netcode possible later.

import { aiIntent, passSpeed } from './ai.ts';
import {
  AIR_DRAG,
  BALL_R,
  BOUNCE_DAMP,
  CHIP_Z0,
  DT,
  FORMATION,
  GOAL_BAR_H,
  GRAVITY,
  KEEPER_REACH_Z,
  REACH_Z,
  SPRINT_DRAIN,
  SPRINT_MULT,
  WINDED_BELOW,
  WINDED_RECOVER,
  GOAL_BOTTOM,
  GOAL_DEPTH,
  GOAL_PAUSE,
  GOAL_TOP,
  HALF_SECONDS,
  HALFTIME_PAUSE,
  KICKOFF_PAUSE,
  PITCH_H,
  PITCH_W,
  PLAYER_R,
  TEAM_SIZE,
  TICK_HZ,
} from './constants.ts';
import { attackDir, fromTeam, inGoalMouth, inOwnBox, oppGoal } from './field.ts';
import { chipPlan, humanPass } from './kicks.ts';
import { gauss, makeRng, next, range } from './rng.ts';
import type { HumanInput, Intent, MatchPlayer, MatchState, TeamSetup, TeamStats } from './types.ts';
import { add, clamp, dist, len, norm, rotate, scale, sub, type Vec } from './vec.ts';

export interface MatchOptions {
  seed: number;
  home: TeamSetup;
  away: TeamSetup;
  halfSeconds?: number;
  humanTeam?: 0 | 1 | -1;
}

const emptyStats = (): TeamStats => ({ shots: 0, onTarget: 0, passes: 0, tackles: 0, possessionTicks: 0 });

export function createMatch(o: MatchOptions): MatchState {
  if (o.home.players.length !== TEAM_SIZE || o.away.players.length !== TEAM_SIZE) {
    throw new Error(`Each team needs exactly ${TEAM_SIZE} players`);
  }
  const players: MatchPlayer[] = [];
  ([o.home, o.away] as const).forEach((t, team) => {
    t.players.forEach((ps, slot) => {
      players.push({
        i: players.length,
        team: team as 0 | 1,
        slot,
        role: FORMATION[slot].role,
        id: ps.id,
        name: ps.name,
        number: ps.number,
        attrs: ps.attrs,
        pos: { x: 0, y: 0 },
        vel: { x: 0, y: 0 },
        facing: { x: attackDir(team as 0 | 1), y: 0 },
        energy: 1,
        sprinting: false,
        winded: false,
        stun: 0,
        tackleCd: 0,
        kickCd: 0,
        aiTimer: 0,
        jitter: { x: 0, y: 0 },
        jitterTimer: 0,
        holdTicks: 0,
      });
    });
  });
  const humanTeam = o.humanTeam ?? 0;
  const s: MatchState = {
    tick: 0,
    rng: makeRng(o.seed),
    teams: [o.home, o.away],
    players,
    ball: { pos: { x: PITCH_W / 2, y: PITCH_H / 2 }, vel: { x: 0, y: 0 }, owner: -1, lastTouch: -1, receiver: -1, passFrom: -1, noPickup: players.map(() => 0), z: 0, vz: 0, touch: 0 },
    score: [0, 0],
    phase: 'kickoff',
    phaseTicks: KICKOFF_PAUSE,
    half: 1,
    clock: 0,
    halfTicks: Math.round((o.halfSeconds ?? HALF_SECONDS) * TICK_HZ),
    kickoffTeam: 0,
    humanTeam,
    controlled: humanTeam >= 0 ? humanTeam * TEAM_SIZE + 5 : -1,
    switchTimer: 0,
    events: [],
    stats: [emptyStats(), emptyStats()],
  };
  resetKickoff(s, 0);
  return s;
}

export function matchMinute(s: MatchState): number {
  return Math.min(90, Math.floor((s.clock / (s.halfTicks * 2)) * 90) + 1);
}

function resetKickoff(s: MatchState, team: 0 | 1): void {
  for (const p of s.players) {
    const slot = FORMATION[p.slot];
    let nx = Math.min(slot.x * 0.85, 0.44);
    let ny = slot.y;
    if (p.team === team && p.role === 'FWD') {
      nx = 0.5 - 1.2 / PITCH_W;
      ny = 0.5;
    }
    p.pos = fromTeam(p.team, nx, ny);
    p.vel = { x: 0, y: 0 };
    p.facing = { x: attackDir(p.team), y: 0 };
    p.stun = 0;
    p.tackleCd = 0;
    p.kickCd = 0;
    p.holdTicks = 0;
    p.sprinting = false;
  }
  const b = s.ball;
  b.pos = { x: PITCH_W / 2, y: PITCH_H / 2 };
  b.vel = { x: 0, y: 0 };
  b.owner = s.players.find((p) => p.team === team && p.role === 'FWD')!.i;
  b.lastTouch = b.owner;
  b.receiver = -1;
  b.passFrom = -1;
  b.noPickup.fill(0);
  b.z = 0;
  b.vz = 0;
  b.touch = 0;
  s.kickoffTeam = team;
  s.phase = 'kickoff';
  s.phaseTicks = KICKOFF_PAUSE;
  if (s.humanTeam === team) s.controlled = b.owner;
}

// ---------------------------------------------------------------------------
// Human control

function humanIntent(s: MatchState, p: MatchPlayer, input: HumanInput): Intent {
  let move: Vec = { x: 0, y: 0 };
  let throttle = 0;
  if (input.cursor) {
    const d = sub(input.cursor, p.pos);
    const l = len(d);
    move = norm(d);
    throttle = clamp((l - 0.35) / 2.2, 0, 1);
  } else if (input.dir && (input.dir.x !== 0 || input.dir.y !== 0)) {
    move = norm(input.dir);
    throttle = 1;
  }
  const hasBall = s.ball.owner === p.i;
  const sprint = !!input.sprint;
  const aimDefault = add(p.pos, scale(throttle > 0 ? move : p.facing, 14));
  const aim = input.cursor ?? aimDefault;

  if (hasBall && input.shoot !== undefined) {
    const goal = oppGoal(p.team);
    const target = input.cursor ?? { x: goal.x, y: goal.y + (input.dir?.y ?? 0) * 2.4 };
    const power = clamp(input.shoot, 0, 1);
    if (input.chip) return { move, throttle, sprint, action: { kind: 'chip', target, power } };
    return { move, throttle, sprint, action: { kind: 'shoot', target, power } };
  }
  if (input.pass) {
    if (hasBall) {
      const r = humanPass(s, p, aim, !!input.through);
      return { move, throttle, sprint, action: { kind: 'pass', target: r.target, receiver: r.receiver, through: !!input.through } };
    }
    return { move, throttle, sprint, action: { kind: 'tackle', target: s.ball.pos } };
  }
  return { move, throttle, sprint };
}

function updateControl(s: MatchState, input: HumanInput): void {
  if (s.humanTeam < 0) return;
  const team = s.humanTeam;
  const ball = s.ball;
  const outfield = s.players.filter((p) => p.team === team && p.role !== 'GK');
  const owner = ball.owner >= 0 ? s.players[ball.owner] : null;

  if (owner && owner.team === team) {
    if (owner.role !== 'GK') s.controlled = owner.i;
    return;
  }
  if (ball.receiver >= 0 && s.players[ball.receiver].team === team && s.players[ball.receiver].role !== 'GK') {
    s.controlled = ball.receiver;
    return;
  }
  const spot = add(ball.pos, scale(ball.vel, 0.3));
  const byDist = [...outfield].sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot));
  if (input.switchPlayer) {
    const pick = byDist[0].i === s.controlled ? byDist[1] : byDist[0];
    s.controlled = pick.i;
    s.switchTimer = 30;
    return;
  }
  if (--s.switchTimer > 0) return;
  s.switchTimer = 12;
  const cur = s.players[s.controlled];
  if (dist(cur.pos, spot) - dist(byDist[0].pos, spot) > 5) s.controlled = byDist[0].i;
}

// ---------------------------------------------------------------------------
// Actions

function kick(s: MatchState, p: MatchPlayer, target: Vec, speed: number, errSigma: number, receiver: number): void {
  const b = s.ball;
  const dir = rotate(norm(sub(target, b.pos)), gauss(s.rng) * errSigma);
  b.vel = scale(dir, speed);
  b.owner = -1;
  b.lastTouch = p.i;
  b.receiver = receiver;
  b.noPickup[p.i] = 14;
  b.touch = 0;
  b.z = 0;
  b.vz = 0;
  p.kickCd = 18;
}

function applyAction(s: MatchState, p: MatchPlayer, intent: Intent): void {
  const a = intent.action;
  if (!a || p.stun > 0) return;
  const b = s.ball;
  const team = p.team;

  if (a.kind === 'pass' && b.owner === p.i) {
    const d = dist(b.pos, a.target);
    const err = 0.14 - 0.115 * p.attrs.passing;
    kick(s, p, a.target, passSpeed(d, p.attrs.passing) * (a.through ? 1.05 : 1), err, a.receiver);
    b.passFrom = p.i;
    return;
  }
  if (a.kind === 'chip' && b.owner === p.i) {
    const plan = chipPlan(b.pos, a.target, a.power);
    const err = 0.03 + 0.09 * a.power * a.power * (1.3 - p.attrs.shooting);
    kick(s, p, plan.landing, plan.speed, err, -1);
    b.z = CHIP_Z0;
    b.vz = plan.vz;
    b.passFrom = -1;
    const goalX = oppGoal(team).x;
    const gap = goalX - p.pos.x;
    const carries = Math.abs(plan.landing.x - p.pos.x) > Math.abs(gap) * 0.8;
    if (Math.sign(gap) === Math.sign(b.vel.x) && Math.abs(gap) < 30 && carries) {
      s.stats[team].shots++;
      const t = gap / b.vel.x;
      if (inGoalMouth(b.pos.y + b.vel.y * t)) s.stats[team].onTarget++;
    }
    return;
  }
  if (a.kind === 'shoot' && b.owner === p.i) {
    const power = a.power;
    const speed = (13 + 17 * power) * (0.8 + 0.3 * p.attrs.shooting);
    const err = 0.02 + 0.12 * power * power * (1.3 - p.attrs.shooting);
    kick(s, p, a.target, speed, err, -1);
    b.passFrom = -1;
    const goalX = oppGoal(team).x;
    const shooting = Math.sign(goalX - b.pos.x) === Math.sign(b.vel.x) && Math.abs(goalX - b.pos.x) < 30;
    if (shooting) {
      s.stats[team].shots++;
      const t = (goalX - b.pos.x) / b.vel.x;
      if (inGoalMouth(b.pos.y + b.vel.y * t)) s.stats[team].onTarget++;
    }
    return;
  }
  if (a.kind === 'tackle' && p.tackleCd === 0 && b.owner !== p.i) {
    p.tackleCd = 36;
    const lunge = norm(sub(a.target, p.pos));
    p.vel = add(p.vel, scale(lunge, 3));
    const owner = b.owner >= 0 ? s.players[b.owner] : null;
    if (!owner || owner.team === team || dist(owner.pos, p.pos) > 1.7) {
      p.stun = 10;
      return;
    }
    let pWin = clamp(0.35 + 0.7 * p.attrs.defending - 0.5 * owner.attrs.dribbling, 0.1, 0.88);
    if (owner.role === 'GK' && inOwnBox(owner.team, owner.pos)) pWin *= 0.25;
    if (next(s.rng) < pWin) {
      b.owner = -1;
      b.vel = add(scale(norm(sub(b.pos, p.pos)), 3.5), scale(p.vel, 0.3));
      b.lastTouch = p.i;
      b.receiver = -1;
      b.touch = 0;
      b.noPickup[owner.i] = 24;
      owner.stun = 18;
      s.stats[team].tackles++;
    } else {
      p.stun = 26;
      p.tackleCd = 50;
    }
  }
}

// ---------------------------------------------------------------------------
// Physics

function movePlayer(s: MatchState, p: MatchPlayer, intent: Intent): void {
  const hasBall = s.ball.owner === p.i;
  // The human's player is more responsive than a CPU player: quicker to
  // accelerate and turn, so the ball swings round with the mouse.
  const human = s.humanTeam >= 0 && p.i === s.controlled;
  if (p.winded && p.energy >= WINDED_RECOVER) p.winded = false;
  else if (!p.winded && p.energy <= WINDED_BELOW) p.winded = true;
  p.sprinting = !!intent.sprint && intent.throttle > 0.5 && p.stun === 0 && !p.winded;

  const energyFactor = 0.82 + 0.18 * p.energy;
  const topSpeed = 5 + 3.4 * p.attrs.pace;
  let maxSpeed = topSpeed * energyFactor;
  if (p.sprinting) maxSpeed *= SPRINT_MULT;
  if (hasBall) maxSpeed *= 0.86 + 0.08 * p.attrs.dribbling;
  if (p.stun > 0) maxSpeed *= 0.15;
  const desired = scale(intent.move, maxSpeed * intent.throttle);
  const accel = (hasBall ? (human ? 26 : 18) : human ? 32 : 24) * (p.sprinting ? 1.15 : 1) * DT;
  const dv = sub(desired, p.vel);
  const dl = len(dv);
  p.vel = dl <= accel ? desired : add(p.vel, scale(dv, accel / dl));
  p.pos = add(p.pos, scale(p.vel, DT));

  const speed = len(p.vel);
  const effort = Math.min(1, speed / topSpeed);
  let e = p.energy - effort * effort * DT * 0.0035 * (1.4 - p.attrs.stamina);
  if (p.sprinting) e -= SPRINT_DRAIN * DT * (1.5 - 0.8 * p.attrs.stamina);
  else if (effort < 0.25) e += 0.04 * DT;
  else if (effort < 0.7) e += 0.02 * DT;
  p.energy = clamp(e, 0.4, 1);

  const steering = human && intent.throttle > 0.15;
  if (speed > 0.3 || steering) {
    const base = hasBall ? 6 + 6 * p.attrs.dribbling : 14;
    const turn = base * (human ? 1.7 : 1) * DT;
    // A human's facing follows where they are steering, not where they have got to.
    const want = steering ? intent.move : scale(p.vel, 1 / speed);
    p.facing = norm(add(p.facing, scale(sub(want, p.facing), Math.min(1, turn))));
  }
  p.pos.x = clamp(p.pos.x, PLAYER_R, PITCH_W - PLAYER_R);
  p.pos.y = clamp(p.pos.y, PLAYER_R, PITCH_H - PLAYER_R);
}

function separate(s: MatchState): void {
  const ps = s.players;
  for (let a = 0; a < ps.length; a++) {
    for (let b = a + 1; b < ps.length; b++) {
      const d = sub(ps[b].pos, ps[a].pos);
      const l = len(d);
      const overlap = PLAYER_R * 2 - l;
      if (overlap > 0 && l > 1e-6) {
        const push = scale(d, (overlap / l) * 0.5);
        ps[a].pos = sub(ps[a].pos, push);
        ps[b].pos = add(ps[b].pos, push);
      }
    }
  }
}

function scoreGoal(s: MatchState, team: 0 | 1): void {
  s.score[team]++;
  const last = s.ball.lastTouch >= 0 ? s.players[s.ball.lastTouch] : null;
  const scorer = last ? (last.team === team ? last.name : `${last.name} (OG)`) : 'Unknown';
  s.events.push({ tick: s.tick, minute: matchMinute(s), team, scorer });
  s.phase = 'goal';
  s.phaseTicks = GOAL_PAUSE;
  s.ball.owner = -1;
  s.ball.receiver = -1;
  s.kickoffTeam = team === 0 ? 1 : 0;
}

function bounceWalls(s: MatchState, prevX: number): void {
  const b = s.ball;
  const p = b.pos;
  // A fast ball can travel past the end wall in one tick, so only treat it as in
  // the net if it crossed the line inside the mouth and under the bar (or was
  // already in the net). Anything else falls through to the wall bounce below.
  const wasInNet = prevX < 0 || prevX > PITCH_W;
  const inNet = (p.x < 0 || p.x > PITCH_W) && inGoalMouth(p.y) && (wasInNet || b.z <= GOAL_BAR_H);
  if (inNet) {
    // Inside the goal frame: net on three sides.
    const backX = p.x < 0 ? -GOAL_DEPTH : PITCH_W + GOAL_DEPTH;
    if ((p.x < 0 && p.x < backX + BALL_R) || (p.x > PITCH_W && p.x > backX - BALL_R)) {
      p.x = p.x < 0 ? backX + BALL_R : backX - BALL_R;
      b.vel.x *= -0.2;
    }
    if (p.y < GOAL_TOP + BALL_R) { p.y = GOAL_TOP + BALL_R; b.vel.y *= -0.2; }
    if (p.y > GOAL_BOTTOM - BALL_R) { p.y = GOAL_BOTTOM - BALL_R; b.vel.y *= -0.2; }
    return;
  }
  if (p.y < BALL_R) { p.y = BALL_R; b.vel.y = Math.abs(b.vel.y) * 0.65; }
  if (p.y > PITCH_H - BALL_R) { p.y = PITCH_H - BALL_R; b.vel.y = -Math.abs(b.vel.y) * 0.65; }
  // A ball arriving above the bar is bounced back like the frame.
  const mouth = inGoalMouth(p.y) && b.z <= GOAL_BAR_H;
  if (!mouth && p.x < BALL_R) { p.x = BALL_R; b.vel.x = Math.abs(b.vel.x) * 0.65; }
  if (!mouth && p.x > PITCH_W - BALL_R) { p.x = PITCH_W - BALL_R; b.vel.x = -Math.abs(b.vel.x) * 0.65; }
  // Posts
  for (const post of [
    { x: 0, y: GOAL_TOP }, { x: 0, y: GOAL_BOTTOM }, { x: PITCH_W, y: GOAL_TOP }, { x: PITCH_W, y: GOAL_BOTTOM },
  ]) {
    const d = sub(p, post);
    const l = len(d);
    if (l < BALL_R + 0.12 && l > 1e-6) {
      const n = scale(d, 1 / l);
      b.pos = add(post, scale(n, BALL_R + 0.12));
      const vn = b.vel.x * n.x + b.vel.y * n.y;
      if (vn < 0) b.vel = sub(b.vel, scale(n, 1.7 * vn));
    }
  }
}

function updateBall(s: MatchState, live: boolean): void {
  const b = s.ball;
  for (let i = 0; i < b.noPickup.length; i++) if (b.noPickup[i] > 0) b.noPickup[i]--;

  if (b.owner >= 0) {
    const o = s.players[b.owner];
    // A keeper holding the ball always faces upfield, so it can't drift over the line.
    if (o.role === 'GK' && inOwnBox(o.team, o.pos)) o.facing = { x: attackDir(o.team), y: 0 };
    const spot = add(o.pos, scale(o.facing, PLAYER_R + BALL_R + 0.12));
    b.z = 0;
    b.vz = 0;
    if (b.touch > 0) {
      // First touch: the ball keeps some of its momentum and settles into the
      // feet over a few ticks instead of snapping to them.
      b.vel = add(b.vel, scale(sub(o.vel, b.vel), 0.22));
      b.pos = add(b.pos, scale(b.vel, DT));
      b.pos = add(b.pos, scale(sub(spot, b.pos), 0.18 + 0.32 * (1 - b.touch / 14)));
      b.touch--;
    } else {
      b.pos = add(b.pos, scale(sub(spot, b.pos), 0.5));
      b.vel = { ...o.vel };
    }
    b.pos.y = clamp(b.pos.y, BALL_R, PITCH_H - BALL_R);
    if (!inGoalMouth(b.pos.y)) b.pos.x = clamp(b.pos.x, BALL_R, PITCH_W - BALL_R);
  } else {
    const speed = len(b.vel);
    if (b.z > 0 || b.vz > 0) {
      // In the air: gravity, light drag, damped bounce. z never goes below 0.
      b.vz -= GRAVITY * DT;
      b.z += b.vz * DT;
      b.vel = scale(b.vel, 1 - AIR_DRAG * DT);
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -1.5) {
          b.vz = -b.vz * BOUNCE_DAMP;
          b.vel = scale(b.vel, 0.82);
        } else b.vz = 0;
      }
    } else if (speed > 0) {
      const ns = Math.max(0, speed - (1.6 + 0.35 * speed) * DT);
      b.vel = scale(b.vel, ns / speed);
    }
    const prevX = b.pos.x;
    b.pos = add(b.pos, scale(b.vel, DT));
    bounceWalls(s, prevX);
    if (live) pickup(s);
  }

  if (!live) return;
  if (b.pos.x < -BALL_R && inGoalMouth(b.pos.y)) scoreGoal(s, 1);
  else if (b.pos.x > PITCH_W + BALL_R && inGoalMouth(b.pos.y)) scoreGoal(s, 0);
}

function pickup(s: MatchState): void {
  const b = s.ball;
  const speed = len(b.vel) + Math.abs(b.vz) * 0.5;
  let best: MatchPlayer | null = null;
  let bestD = Infinity;
  for (const p of s.players) {
    if (p.stun > 0 || b.noPickup[p.i] > 0) continue;
    const keeper = p.role === 'GK' && inOwnBox(p.team, p.pos);
    if (b.z > (keeper ? KEEPER_REACH_Z : REACH_Z)) continue; // too high to take
    const reach = keeper ? 1.1 + 0.7 * p.attrs.goalkeeping : PLAYER_R + BALL_R + 0.25;
    const d = dist(p.pos, b.pos);
    if (d < reach && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (!best) return;
  const p = best;
  const keeper = p.role === 'GK' && inOwnBox(p.team, p.pos);
  const control = keeper ? 10 + 20 * p.attrs.goalkeeping : 6 + 11 * p.attrs.dribbling + (b.receiver === p.i ? 5 : 0);

  if (speed <= control) {
    const from = b.passFrom >= 0 ? s.players[b.passFrom] : null;
    if (from && from.team === p.team && from.i !== p.i) s.stats[p.team].passes++;
    b.owner = p.i;
    b.lastTouch = p.i;
    b.receiver = -1;
    b.passFrom = -1;
    b.touch = clamp(Math.round(speed * 1.2), 4, 14);
    b.vz = 0;
    p.holdTicks = 0;
    p.aiTimer = Math.max(p.aiTimer, 4);
    return;
  }
  // Too hot to control: parry or deflect.
  b.lastTouch = p.i;
  b.receiver = -1;
  b.touch = 0;
  b.noPickup[p.i] = 12;
  if (keeper) {
    const away = attackDir(p.team);
    b.vel = { x: Math.abs(b.vel.x) * 0.35 * away, y: b.vel.y * 0.3 + range(s.rng, -5, 5) };
  } else {
    b.vel = rotate(scale(b.vel, 0.5), range(s.rng, -0.7, 0.7));
  }
}

// ---------------------------------------------------------------------------

export function step(s: MatchState, input: HumanInput = {}): void {
  s.tick++;
  for (const p of s.players) {
    if (p.stun > 0) p.stun--;
    if (p.tackleCd > 0) p.tackleCd--;
    if (p.kickCd > 0) p.kickCd--;
  }

  if (s.phase === 'fulltime') return;
  if (s.phase === 'kickoff') {
    if (--s.phaseTicks <= 0) s.phase = 'play';
    updateBall(s, false);
    return;
  }
  if (s.phase === 'goal' || s.phase === 'halftime') {
    for (const p of s.players) movePlayer(s, p, { move: { x: 0, y: 0 }, throttle: 0 });
    updateBall(s, false);
    if (--s.phaseTicks <= 0) {
      if (s.phase === 'halftime') {
        s.half = 2;
        resetKickoff(s, 1);
      } else resetKickoff(s, s.kickoffTeam);
    }
    return;
  }

  updateControl(s, input);
  const intents = s.players.map((p) => (p.i === s.controlled ? humanIntent(s, p, input) : aiIntent(s, p)));
  s.players.forEach((p, i) => applyAction(s, p, intents[i]));
  s.players.forEach((p, i) => movePlayer(s, p, intents[i]));
  separate(s);
  updateBall(s, true);

  if (s.ball.owner >= 0) s.stats[s.players[s.ball.owner].team].possessionTicks++;
  s.clock++;
  if (s.phase === 'play' && s.clock >= s.halfTicks * s.half) {
    if (s.half === 1) {
      s.phase = 'halftime';
      s.phaseTicks = HALFTIME_PAUSE;
    } else s.phase = 'fulltime';
  }
}

/** Run a whole match with no human, as fast as possible. Used for tests, balance and quick-sim. */
export function simulate(o: Omit<MatchOptions, 'humanTeam'>): MatchState {
  const s = createMatch({ ...o, humanTeam: -1 });
  while (s.phase !== 'fulltime') step(s);
  return s;
}

/** Compact fingerprint of the state, for determinism checks. */
export function fingerprint(s: MatchState): string {
  const r = (n: number) => Math.round(n * 1000);
  return [
    s.tick,
    s.score.join(':'),
    r(s.ball.pos.x),
    r(s.ball.pos.y),
    r(s.ball.z),
    ...s.players.map((p) => `${r(p.pos.x)},${r(p.pos.y)},${r(p.energy)}`),
  ].join('|');
}

export function possessionShare(s: MatchState): [number, number] {
  const a = s.stats[0].possessionTicks;
  const b = s.stats[1].possessionTicks;
  const t = a + b || 1;
  return [Math.round((a / t) * 100), Math.round((b / t) * 100)];
}

