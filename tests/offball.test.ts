// Off the ball with the human on it (playtest: "other players are nearby following me when they should be
// spreading out and creating chances for passing, through balls, crossing"). Scripted human matches
// (src/meta/offballProbe.ts humanBot: runs at goal, plays in runners, passes to the most forward open man),
// sampled while his man has the ball.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateSquad, toTeamSetup } from '../src/meta/club.ts';
import { humanBot } from '../src/meta/offballProbe.ts';
import { PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { teamX } from '../src/sim/field.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { makeRng } from '../src/sim/rng.ts';

const id = (name: string, primary: string) => ({ id: name, name, short: name.slice(0, 3).toUpperCase(), primary, secondary: '#fff', crest: 'plain' as const });

/** Per sample of the human carrying: teammates within 12 m, teammates more than 5 m ahead of the ball, and (in the final third) a man wide. */
function measure(matches: number) {
  let n = 0;
  let near = 0;
  let ahead = 0;
  let f3 = 0;
  let wide = 0;
  for (let i = 0; i < matches; i++) {
    const squad = generateSquad(makeRng(5000 + Math.floor(i / 2)), 60);
    const A = toTeamSetup(id('A', '#c00'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', 'balanced');
    const B = toTeamSetup(id('B', '#00c'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', 'balanced');
    const s = createMatch({ seed: 7100 + i, home: A, away: B, halfSeconds: 180, humans: [true, false] });
    const held = { since: -1 };
    while (s.phase !== 'fulltime') {
      step(s, [humanBot(s, 0, held), {}]);
      if (s.phase !== 'play' || s.tick % 6) continue;
      const c = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
      if (!c || c.team !== 0 || c.i !== s.controlled[0] || c.role === 'GK') continue;
      const bx = teamX(s, 0, c.pos.x) * PITCH_W;
      const mates = s.players.filter((m) => m.team === 0 && m.i !== c.i && m.role !== 'GK' && !m.sentOff);
      n++;
      near += mates.filter((m) => Math.hypot(m.pos.x - c.pos.x, m.pos.y - c.pos.y) < 12).length;
      ahead += mates.filter((m) => teamX(s, 0, m.pos.x) * PITCH_W > bx + 5).length;
      if (bx > 0.6 * PITCH_W) {
        f3++;
        if (mates.some((m) => Math.min(m.pos.y, PITCH_H - m.pos.y) < 10 && teamX(s, 0, m.pos.x) * PITCH_W > bx - 5)) wide++;
      }
    }
  }
  return { near: near / n, ahead: ahead / n, wide: wide / f3 };
}

describe('off the ball, with the human on it', () => {
  test('his teammates spread out ahead of him and wide, rather than following him about', () => {
    const m = measure(16);
    // Measured on these 16 matches: before, 1.99 teammates within 12 m of him, 2.15 more than 5 m ahead of the
    // ball and a man out wide 37% of the time in the final third; after (SIM_VERSION 29) 1.81, 2.34 and 44%.
    expect(m.near).toBeLessThan(1.9);
    expect(m.ahead).toBeGreaterThan(2.25);
    expect(m.wide).toBeGreaterThan(0.4);
  }, 120_000);
});
