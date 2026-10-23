import { describe, expect, test } from 'bun:test';
import { generateLadder, generateSquad, autoLineup, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { createMatch, fingerprint, simulate, step } from '../src/sim/match.ts';
import { makeRng } from '../src/sim/rng.ts';
import type { HumanInput } from '../src/sim/types.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

describe('match sim', () => {
  test('same seed and inputs give the same match', () => {
    const run = () => {
      const s = createMatch({ seed: 42, ...teams(7), halfSeconds: 20 });
      const inputs: HumanInput[] = [];
      for (let t = 0; t < 3000; t++) inputs.push(t % 90 === 0 ? { cursor: { x: 50, y: 10 + (t % 20) }, pass: true } : { cursor: { x: 40, y: 20 } });
      for (const i of inputs) step(s, i);
      return fingerprint(s);
    };
    expect(run()).toBe(run());
  });

  test('different seeds diverge', () => {
    const a = simulate({ seed: 1, ...teams(7), halfSeconds: 30 });
    const b = simulate({ seed: 2, ...teams(7), halfSeconds: 30 });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test('a CPU match finishes with a plausible scoreline and real play', () => {
    const s = simulate({ seed: 99, ...teams(3), halfSeconds: 120 });
    expect(s.phase).toBe('fulltime');
    const total = s.score[0] + s.score[1];
    expect(total).toBeLessThan(25);
    expect(s.stats[0].passes + s.stats[1].passes).toBeGreaterThan(20);
    expect(s.stats[0].shots + s.stats[1].shots).toBeGreaterThan(2);
    for (const p of s.players) {
      expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)).toBe(true);
    }
  });

  test('stronger squads win more often', () => {
    let strongWins = 0;
    let weakWins = 0;
    for (let i = 0; i < 12; i++) {
      const r = makeRng(1000 + i);
      const strong = generateSquad(r, 78);
      const weak = generateSquad(r, 46);
      const id = { id: 'x', name: 'S', short: 'S', primary: '#000', secondary: '#fff', crest: 'plain' as const };
      const s = simulate({ seed: i, home: toTeamSetup(id, strong, autoLineup(strong)), away: toTeamSetup(id, weak, autoLineup(weak)), halfSeconds: 90 });
      if (s.score[0] > s.score[1]) strongWins++;
      if (s.score[1] > s.score[0]) weakWins++;
    }
    expect(strongWins).toBeGreaterThan(weakWins);
  });
});
