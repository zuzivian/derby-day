// One mentality's measurement for tests/tactics.test.ts: side A plays `m`, side B Balanced, same squad and skill, over
// `n` matches of `half` seconds a half, home and away in turn; A's metrics averaged. Deterministic: fixed seeds.
// The test runs the five mentalities at once, one Worker each (this file), since each is 64 matches of play.

import { autoLineup, generateSquad, toTeamSetup } from '../../src/meta/club.ts';
import { averageMetrics, measureMatch, type TeamMetrics } from '../../src/meta/tacticsProbe.ts';
import type { Mentality } from '../../src/sim/constants.ts';
import { makeRng } from '../../src/sim/rng.ts';

export function vsBalanced(m: Mentality, n: number, half: number): TeamMetrics {
  const id = (name: string, primary: string) => ({ id: name, name, short: name, primary, secondary: '#fff', crest: 'plain' as const });
  const list: TeamMetrics[] = [];
  for (let i = 0; i < n; i++) {
    const squad = generateSquad(makeRng(5000 + Math.floor(i / 2)), 60);
    const A = toTeamSetup(id('A', '#c00'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', m);
    const B = toTeamSetup(id('B', '#00c'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', 'balanced');
    const aHome = i % 2 === 0;
    const { teams } = measureMatch({ seed: 7100 + i, home: aHome ? A : B, away: aHome ? B : A, halfSeconds: half });
    list.push(teams[aHome ? 0 : 1]);
  }
  return averageMetrics(list);
}

/** vsBalanced in a Worker of its own. */
export function vsBalancedInWorker(m: Mentality, n: number, half: number): Promise<TeamMetrics> {
  const w = new Worker(new URL(import.meta.url).href);
  const done = new Promise<TeamMetrics>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<TeamMetrics>) => resolve(e.data);
    w.onerror = (e) => reject(e instanceof ErrorEvent ? e.error ?? new Error(e.message) : e);
  }).finally(() => w.terminate());
  w.postMessage({ m, n, half });
  return done;
}

if (!Bun.isMainThread) {
  self.onmessage = (e: MessageEvent<{ m: Mentality; n: number; half: number }>) => postMessage(vsBalanced(e.data.m, e.data.n, e.data.half));
}
