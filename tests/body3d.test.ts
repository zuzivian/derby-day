// The footballer's body mesh (body3d.ts) and the foot-planted gait (player3d.ts).

import { describe, expect, test } from 'bun:test';
import { BI, buildBody, type BodyLook } from '../src/client/r3d/body3d.ts';
import { PlayerKit, createProceduralPlayer, lookFor, type PlayerContext, type SimBody } from '../src/client/r3d/player3d.ts';
import { SkinnedMesh, Vector3 } from '../src/client/r3d/three.ts';

const LOOK: BodyLook = { shirt: '#c8102e', shorts: '#ffffff', socks: '#c8102e', trim: '#ffffff', skin: '#c08657', hair: '#16110d', hairStyle: 0, boots: '#141414', bootSole: '#3a3a3a', bootAccent: '#ff5a1f', gloves: null, longSleeves: false, build: 0 };

describe('body mesh', () => {
  for (const detail of ['high', 'low'] as const) {
    for (const look of [LOOK, { ...LOOK, gloves: '#f4f4f4', longSleeves: true, hairStyle: 2 }, { ...LOOK, hairStyle: 3, build: 1 }, { ...LOOK, hairStyle: 4, build: -1 }]) {
      test(`${detail} detail, hair ${look.hairStyle}${look.longSleeves ? ', keeper' : ''}: valid, skinned to real bones, weights summing to 1, within the triangle budget`, () => {
        const g = buildBody(look, detail);
        const pos = g.attributes.position;
        const nor = g.attributes.normal;
        const si = g.attributes.skinIndex;
        const sw = g.attributes.skinWeight;
        const idx = g.index!;
        const n = pos.count;
        for (let i = 0; i < idx.count; i++) expect(idx.getX(i)).toBeLessThan(n);
        let badW = 0;
        let badN = 0;
        let badBone = 0;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < n; i++) {
          const w = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
          if (Math.abs(w - 1) > 1e-4) badW++;
          const l = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i));
          if (!(Math.abs(l - 1) < 1e-3)) badN++;
          for (const b of [si.getX(i), si.getY(i)]) if (b > BI.chest) badBone++;
          minY = Math.min(minY, pos.getY(i));
          maxY = Math.max(maxY, pos.getY(i));
        }
        expect(badW).toBe(0);
        expect(badN).toBe(0);
        expect(badBone).toBe(0);
        // Boots on the grass, the top of the head a natural height (local units: the root scale makes metres).
        expect(minY).toBeGreaterThan(-0.03);
        expect(minY).toBeLessThan(0.02);
        expect(maxY).toBeGreaterThan(1.72);
        expect(maxY).toBeLessThan(1.85);
        // 24 of these (and the shadow pass) fit the 3D view's triangle budget (budget.ts).
        expect(idx.count / 3).toBeLessThan(detail === 'high' ? 3600 : 2600);
        g.dispose();
      });
    }
  }
});

describe('gait', () => {
  const ctx = (time: number): PlayerContext => ({ time, dtSim: 1 / 60, lead: 0, keeperSet: 0, throwHold: false, holding: false, hasBall: false, wall: false, reducedMotion: true });

  /** Runs a player along +x at `speed` for `secs`; returns each frame's root x and the left ankle's world position. */
  function run(speed: number, secs: number) {
    const kit = new PlayerKit();
    const m = createProceduralPlayer(kit, lookFor('p', { shirt: '#c8102e', shorts: '#fff', socks: '#c8102e', trim: '#fff' }, 7, false, () => 0.4));
    let mesh: SkinnedMesh | null = null;
    m.object.traverse((o) => {
      if (o instanceof SkinnedMesh) mesh = o;
    });
    const ankle = (mesh as unknown as SkinnedMesh).skeleton.bones[BI.anL];
    const body: SimBody = { pos: { x: 30, y: 34 }, vel: { x: speed, y: 0 }, facing: { x: 1, y: 0 } };
    const frames: { x: number; y: number }[] = [];
    let time = 0;
    const p = new Vector3();
    for (let i = 0; i < secs * 60; i++) {
      time += 1 / 60;
      body.pos = { x: body.pos.x + speed / 60, y: 34 };
      m.update(1 / 60, body, [], ctx(time));
      m.object.updateMatrixWorld(true);
      ankle.getWorldPosition(p);
      frames.push({ x: p.x, y: p.y });
    }
    m.dispose();
    kit.dispose();
    return frames;
  }

  for (const speed of [1.6, 4, 7.5]) {
    test(`at ${speed} m/s a planted foot stays put while the body runs on (no skating)`, () => {
      // Skip the first second, while the smoothed speed settles.
      const f = run(speed, 3).slice(60);
      const minY = Math.min(...f.map((q) => q.y));
      // Frames with the left foot down: the ankle within 12 mm of its lowest.
      let worst = 0;
      let stances = 0;
      let start = -1;
      for (let i = 0; i <= f.length; i++) {
        const down = i < f.length && f[i].y < minY + 0.012;
        if (down && start < 0) start = i;
        if (!down && start >= 0) {
          const seg = f.slice(start, i);
          if (seg.length >= 3) {
            stances++;
            const xs = seg.map((q) => q.x);
            worst = Math.max(worst, Math.max(...xs) - Math.min(...xs));
          }
          start = -1;
        }
      }
      expect(stances).toBeGreaterThanOrEqual(2);
      // While it is down the body travels speed × stance time (tens of cm); the foot slides only a few.
      expect(worst).toBeLessThan(0.06);
    });
  }
});
