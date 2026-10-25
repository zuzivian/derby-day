// What a team's tactics actually do on the pitch, measured from a headless
// match. Pure (no DOM): scripts/tactics-probe.ts prints it for many matches
// and tests/tactics.test.ts asserts the directions on fixed seeds.
//
// Everything is sampled during live play only (dead balls, kick-offs and
// celebrations are skipped), in metres from the team's own goal line.

import { PITCH_W } from '../sim/constants.ts';
import { teamX } from '../sim/field.ts';
import { createMatch, possessionShare, step, type MatchOptions } from '../sim/match.ts';
import type { MatchState } from '../sim/types.ts';

export interface TeamMetrics {
  goalsFor: number;
  goalsAgainst: number;
  /** Share of the ball, 0..100. */
  possession: number;
  shots: number;
  shotsAgainst: number;
  passes: number;
  /** Passes played in open play (completed or not), and the share that reached a teammate (%). */
  passAttempts: number;
  passCompletion: number;
  tackles: number;
  fouls: number;
  yellows: number;
  /** Out of possession: the deepest outfield player's distance from his own goal line (the offside line he holds), m. */
  line: number;
  /** Out of possession: distance from the deepest to the highest outfield player, m (vertical compactness). */
  depth: number;
  /** Out of possession: distance between the two widest outfield players, m (horizontal compactness). */
  width: number;
  /** Out of possession: average number of players within 6 m of the opposing ball carrier. */
  pressers: number;
  /** Where the ball was won back in open play, m from own goal (average). */
  regainHeight: number;
  /** Balls won back in open play. */
  regains: number;
  /** In possession: average number of outfield players ahead of the ball. */
  ahead: number;
  /** In possession: average number of outfield players in the opponents' half (how many commit forward). */
  forward: number;
  /** In possession: average number of teammates within 14 m of the carrier with a clear lane for a pass (no opponent within 1.5 m of it). */
  openShort: number;
}

interface Acc {
  line: number;
  depth: number;
  width: number;
  pressers: number;
  out: number;
  ahead: number;
  forward: number;
  openShort: number;
  inPoss: number;
  regainSum: number;
  regains: number;
  passAttempts: number;
}

const newAcc = (): Acc => ({ line: 0, depth: 0, width: 0, pressers: 0, out: 0, ahead: 0, forward: 0, openShort: 0, inPoss: 0, regainSum: 0, regains: 0, passAttempts: 0 });

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const l2 = abx * abx + aby * aby;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / l2));
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Sample one tick of live play into the accumulators. */
function sample(s: MatchState, acc: [Acc, Acc]): void {
  const owner = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
  if (!owner) return;
  for (const team of [0, 1] as const) {
    const a = acc[team];
    const out = s.players.filter((p) => p.team === team && p.role !== 'GK' && !p.sentOff);
    if (!out.length) continue;
    if (owner.team !== team) {
      let lo = Infinity;
      let hi = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      let near = 0;
      for (const p of out) {
        const x = teamX(s, team, p.pos.x) * PITCH_W;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
        top = Math.min(top, p.pos.y);
        bottom = Math.max(bottom, p.pos.y);
        const dx = p.pos.x - owner.pos.x;
        const dy = p.pos.y - owner.pos.y;
        if (dx * dx + dy * dy < 36) near++;
      }
      a.line += lo;
      a.depth += hi - lo;
      a.width += bottom - top;
      a.pressers += near;
      a.out++;
    } else {
      const bx = teamX(s, team, s.ball.pos.x);
      let ahead = 0;
      let open = 0;
      for (const p of out) {
        if (teamX(s, team, p.pos.x) > 0.5) a.forward++;
        if (p.i === owner.i) continue;
        if (teamX(s, team, p.pos.x) > bx + 0.01) ahead++;
        const dx = p.pos.x - owner.pos.x;
        const dy = p.pos.y - owner.pos.y;
        if (dx * dx + dy * dy > 196) continue;
        let lane = Infinity;
        for (const o of s.players) if (o.team !== team && !o.sentOff) lane = Math.min(lane, segDist(o.pos.x, o.pos.y, owner.pos.x, owner.pos.y, p.pos.x, p.pos.y));
        if (lane > 1.5) open++;
      }
      a.ahead += ahead;
      a.openShort += open;
      a.inPoss++;
    }
  }
}

/** Play one CPU-vs-CPU match to the end and measure both sides. */
export function measureMatch(o: Omit<MatchOptions, 'humanTeam' | 'humans'>): { state: MatchState; teams: [TeamMetrics, TeamMetrics] } {
  const s = createMatch({ ...o, humans: [false, false] });
  const acc: [Acc, Acc] = [newAcc(), newAcc()];
  // Team holding the ball in open play, or -1 after a dead ball (a restart is not a regain).
  let holder = -1;
  while (s.phase !== 'fulltime') {
    const kicker = s.ball.owner;
    step(s);
    // A pass: the carrier let it go toward a teammate.
    if (kicker >= 0 && s.ball.owner < 0 && s.ball.receiver >= 0 && s.players[s.ball.receiver].team === s.players[kicker].team) acc[s.players[kicker].team].passAttempts++;
    if (s.phase !== 'play') {
      holder = -1;
      continue;
    }
    const owner = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
    if (owner) {
      if (holder >= 0 && owner.team !== holder) {
        acc[owner.team].regainSum += teamX(s, owner.team, s.ball.pos.x) * PITCH_W;
        acc[owner.team].regains++;
      }
      holder = owner.team;
    }
    if (s.tick % 6 === 0) sample(s, acc);
  }
  const poss = possessionShare(s);
  const metrics = (team: 0 | 1): TeamMetrics => {
    const a = acc[team];
    const st = s.stats[team];
    const them = s.stats[team === 0 ? 1 : 0];
    const per = (v: number, n: number) => (n ? v / n : 0);
    return {
      goalsFor: s.score[team],
      goalsAgainst: s.score[team === 0 ? 1 : 0],
      possession: poss[team],
      shots: st.shots,
      shotsAgainst: them.shots,
      passes: st.passes,
      passAttempts: a.passAttempts,
      passCompletion: a.passAttempts ? Math.min(100, (100 * st.passes) / a.passAttempts) : 0,
      tackles: st.tackles,
      fouls: st.fouls,
      yellows: st.yellows,
      line: per(a.line, a.out),
      depth: per(a.depth, a.out),
      width: per(a.width, a.out),
      pressers: per(a.pressers, a.out),
      regainHeight: per(a.regainSum, a.regains),
      regains: a.regains,
      ahead: per(a.ahead, a.inPoss),
      forward: per(a.forward, a.inPoss),
      openShort: per(a.openShort, a.inPoss),
    };
  };
  return { state: s, teams: [metrics(0), metrics(1)] };
}

/** Average a list of metrics (regain height weighted by the number of regains). */
export function averageMetrics(list: TeamMetrics[]): TeamMetrics {
  const n = Math.max(1, list.length);
  const out = {} as TeamMetrics;
  const keys = Object.keys(list[0] ?? {}) as (keyof TeamMetrics)[];
  for (const k of keys) out[k] = list.reduce((t, m) => t + m[k], 0) / n;
  const regains = list.reduce((t, m) => t + m.regains, 0);
  out.regainHeight = regains ? list.reduce((t, m) => t + m.regainHeight * m.regains, 0) / regains : 0;
  return out;
}
