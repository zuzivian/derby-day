// Player dots (review of #19): in the long view on an upright phone players are drawn 4 to 5 px
// tall, too small to tell apart; then each gets a shirt-coloured dot DOT_PX across. On a desktop,
// and in a close view, they stay off. Uses the real MatchCamera, longView and sim.

import { describe, expect, test } from 'bun:test';
import { avoidClash, CLASH_DE, worstDiff } from '../src/client/kits.ts';
import { MatchCamera } from '../src/client/r3d/camera3d.ts';
import { DOT_BELOW, DOT_PX, dotAlpha, playerPx } from '../src/client/r3d/dots3d.ts';
import { longView } from '../src/client/r3d/renderer3d.ts';
import { sx, sz } from '../src/client/r3d/space.ts';
import { Vector3 } from '../src/client/r3d/three.ts';
import { keeperColors } from '../src/client/r3d/player3d.ts';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { KIT_COLORS } from '../src/meta/names.ts';
import type { TeamSetup } from '../src/sim/types.ts';
import { createMatch, step } from '../src/sim/match.ts';

/** The keeper with the ball in his hands; the camera settled on the long view at this canvas size. */
function keeperLongView(w: number, h: number) {
  const [a, b] = generateLadder(3, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const s = createMatch({ seed: 3, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 600, humans: [true, false] });
  for (let t = 0; t < 400; t++) step(s, {});
  const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
  s.ball.owner = gk.i;
  s.ball.inHands = true;
  s.ball.pos = { ...gk.pos };
  const lv = longView(s, 0)!;
  expect(lv).not.toBeNull();
  const cam = new MatchCamera();
  const focus = { x: sx(gk.pos.x), z: sz(gk.pos.y), vx: 0, vz: 0, air: 0, attack: 0, phase: 'play' as const, close: null, humanDir: 1 as const, long: { points: lv.points.map((p) => ({ x: sx(p.x), z: sz(p.y) })), corner: false } };
  for (let i = 0; i < 400; i++) cam.update(1 / 60, focus, w / h, w, false);
  return cam;
}

/** How tall a 1.8 m player at this sim spot is drawn, px. */
function tallAt(cam: MatchCamera, x: number, y: number, h: number): number {
  const f = new Vector3(sx(x), 0, sz(y)).project(cam.camera);
  const t = new Vector3(sx(x), 1.8, sz(y)).project(cam.camera);
  return ((t.y - f.y) / 2) * h;
}

describe('player dots', () => {
  test('dotAlpha: full below DOT_BELOW - 3 px, none at DOT_BELOW and above', () => {
    expect(dotAlpha(4)).toBe(1);
    expect(dotAlpha(DOT_BELOW - 3)).toBe(1);
    expect(dotAlpha(DOT_BELOW)).toBe(0);
    expect(dotAlpha(20)).toBe(0);
    expect(dotAlpha(DOT_BELOW - 1.5)).toBeCloseTo(0.5, 5);
  });

  test('upright phone (390x844, a 358x636 canvas), the long view: players are 4 to 5 px tall, so the dots are fully on and twice their height', () => {
    const [w, h] = [358, 636];
    const cam = keeperLongView(w, h);
    const px = playerPx(cam.camera, cam.target, h);
    for (const [x, y] of [
      [4, 34],
      [30, 34],
      [52.5, 12],
      [52.5, 56],
    ]) {
      const t = tallAt(cam, x, y, h);
      expect(t).toBeGreaterThan(3);
      expect(t).toBeLessThan(6);
    }
    expect(px).toBeLessThan(6);
    expect(dotAlpha(px)).toBe(1);
    expect(DOT_PX).toBeGreaterThanOrEqual(2 * px);
  });

  test('desktop (a 1012x677 canvas), the long view: players are about 12 px tall, no dots', () => {
    const [w, h] = [1012, 677];
    const cam = keeperLongView(w, h);
    const px = playerPx(cam.camera, cam.target, h);
    expect(px).toBeGreaterThan(DOT_BELOW);
    expect(dotAlpha(px)).toBe(0);
  });

  test('a team-mate\'s dot and an opponent\'s stay distinct under normal, protan and deutan vision, keepers too', () => {
    // A dot is its player's shirt colour, so this is the kit choice (avoidClash, keeperColors) seen as dots.
    const team = (primary: string, secondary: string) => ({ primary, secondary }) as unknown as TeamSetup;
    const bad: string[] = [];
    for (const [hp, hs] of KIT_COLORS) {
      for (const [ap, as] of KIT_COLORS) {
        const away = avoidClash(team(hp, hs), team(ap, as));
        // As the renderer picks them: the home keeper, then the away keeper differing from him too.
        const homeKeeper = keeperColors(hp, away.primary).shirt;
        const dots = [hp, away.primary, homeKeeper, keeperColors(away.primary, hp, homeKeeper).shirt];
        for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
          // Each pair is a player against an opponent, or against a keeper (his own or theirs).
          const d = worstDiff(dots[i], dots[j]);
          if (d < CLASH_DE) bad.push(`${hp} v ${ap}: ${dots[i]} / ${dots[j]} ${d.toFixed(1)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
