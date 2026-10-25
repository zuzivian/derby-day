// Shared scene helpers for the controls red-team (scratch, not part of the repo).
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '/tmp/rt/controls/repo/src/meta/club.ts';
import { createMatch, step } from '/tmp/rt/controls/repo/src/sim/match.ts';
import type { HumanInput, MatchPlayer, MatchState } from '/tmp/rt/controls/repo/src/sim/types.ts';
import { dist, len, type Vec } from '/tmp/rt/controls/repo/src/sim/vec.ts';

export function teams(seed: number, aiSkill?: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb), aiSkill) };
}

export function livePlay(seed = 5, teamSeed = 7, aiSkill?: number): MatchState {
  const s = createMatch({ seed, ...teams(teamSeed, aiSkill), halfSeconds: 600, humans: [true, false] });
  while (s.phase !== 'play') step(s);
  return s;
}

/** Everyone but `keep` is out of it: far away and on the floor. */
export function isolate(s: MatchState, ...keep: MatchPlayer[]): void {
  for (const p of s.players) {
    if (keep.includes(p)) continue;
    p.stun = 100000;
    p.pos = { x: 100 + (p.i % 5), y: -2 - (p.i % 3) };
    p.vel = { x: 0, y: 0 };
  }
}

export const mid = (s: MatchState, team: 0 | 1, k = 0) => s.players.filter((p) => p.team === team && p.role === 'MID')[k];

export function giveBall(s: MatchState, me: MatchPlayer, at: Vec, facing: Vec = { x: 1, y: 0 }) {
  me.pos = { ...at };
  me.vel = { x: 0, y: 0 };
  me.facing = { ...facing };
  me.stun = 0;
  s.controlled[me.team] = me.i;
  const b = s.ball;
  b.owner = me.i;
  b.pos = { x: at.x + facing.x * 0.99, y: at.y + facing.y * 0.99 };
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
  b.receiver = -1;
  b.touch = 0;
  b.inHands = false;
  b.noPickup.fill(0);
}

export const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
export { createMatch, step, dist, len };
export type { HumanInput, MatchPlayer, MatchState, Vec };
