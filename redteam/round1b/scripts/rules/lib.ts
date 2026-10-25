import { cpuTeam, generateLadder, ladderSquad } from '/tmp/rt/rules/repo/src/meta/club.ts';
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { PITCH_H, PITCH_W } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import type { MatchPlayer, MatchState } from '/tmp/rt/rules/repo/src/sim/types.ts';
export const MID = PITCH_H / 2;
export function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)) };
}
export function live(seed = 5, cpu = false, halfSeconds = 120): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds, humanTeam: cpu ? -1 : 0 });
  while (s.phase !== 'play') step(s);
  return s;
}
export function clearPitch(s: MatchState): void {
  s.players.forEach((p, k) => {
    p.stun = 100000;
    p.pos = { x: 30 + (k % 11) * 2, y: p.team === 0 ? 20 : 48 };
    p.vel = { x: 0, y: 0 };
  });
}
export const player = (s: MatchState, team: 0 | 1, sub: MatchPlayer['sub'], nth = 0) => s.players.filter((p) => p.team === team && p.sub === sub && !p.sentOff)[nth]!;
export function toReady(s: MatchState): void {
  for (let t = 0; t < 600 && s.restart && s.restart.stage !== 'ready'; t++) step(s, {});
}
export const evs = (s: MatchState, from = 0) => s.events.slice(from).map((e: any) => `${e.tick} ${e.kind}${e.restart ? ':' + e.restart : ''}${e.color ? ':' + e.color : ''} t${e.team} p${e.player}${e.reason ? ' ' + e.reason : ''}`);
export { PITCH_H, PITCH_W, step };
