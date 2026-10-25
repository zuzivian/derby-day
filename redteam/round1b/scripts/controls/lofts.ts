// Hold-to-loft passes and crosses through the sim: the hold the human needs, where it lands, and who wins it.
import { loftPower, CLICK_MS, LOFT_RAMP_MS } from '/tmp/rt/controls/repo/src/client/input.ts';
import { loftRange, loftPlan } from '/tmp/rt/controls/repo/src/sim/kicks.ts';
import { PITCH_H, PITCH_W } from '/tmp/rt/controls/repo/src/sim/constants.ts';
import { goalkeeper } from '/tmp/rt/controls/repo/src/sim/field.ts';
import { fmt, giveBall, isolate, livePlay, step, dist, len, type Vec } from './lib.ts';

// Hold needed (ms) to just reach d metres.
const holdFor = (d: number) => CLICK_MS + Math.max(0, Math.min(1, (d - 12) / 28)) * LOFT_RAMP_MS;
console.log('hold needed: ' + [12, 15, 20, 25, 30, 35, 40].map((d) => `${d} m ${Math.round(holdFor(d))} ms`).join(', '));

type Res = 'mate' | 'def' | 'loose' | 'out' | 'other';
function loft(d: number, ang: number, defOff: number | null, holdMs: number, seed: number) {
  const s = livePlay(seed);
  const me = s.players[s.controlled[0]];
  const mate = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== me.i)!;
  const def = s.players.find((p) => p.team === 1 && p.role === 'DEF')!;
  isolate(s, ...(defOff === null ? [me, mate] : [me, mate, def]));
  s.switchTimer[0] = 1e9;
  const at = { x: 8, y: 34 };
  giveBall(s, me, at);
  const a = (ang * Math.PI) / 180;
  mate.pos = { x: at.x + Math.cos(a) * d, y: at.y + Math.sin(a) * d };
  mate.vel = { x: 0, y: 0 };
  if (defOff !== null) {
    def.pos = { x: mate.pos.x + defOff, y: mate.pos.y };
    def.vel = { x: 0, y: 0 };
    def.stun = 0;
  }
  const aim = { ...mate.pos };
  const hold = loftPower(holdMs);
  step(s, { cursor: aim, aim, loft: hold });
  let res: Res = 'other';
  let maxZ = 0;
  let firstTouchZ = -1;
  let land: Vec | null = null;
  let t = 0;
  for (; t < 400; t++) {
    const prevZ = s.ball.z;
    step(s, { cursor: aim });
    maxZ = Math.max(maxZ, s.ball.z);
    if (!land && prevZ > 0 && s.ball.z === 0) land = { ...s.ball.pos };
    if (firstTouchZ < 0 && s.ball.lastTouch !== me.i) firstTouchZ = prevZ;
    if (s.phase !== 'play') { res = 'out'; break; }
    if (s.ball.owner >= 0) { res = s.ball.owner === mate.i ? 'mate' : s.ball.owner === def.i ? 'def' : 'other'; break; }
    if (len(s.ball.vel) < 0.05 && s.ball.z === 0) { res = 'loose'; break; }
  }
  return { res, maxZ, land, t: t / 60, firstTouchZ, firstToucher: s.ball.lastTouch === mate.i ? 'mate' : s.ball.lastTouch === def.i ? 'def' : 'me/other' };
}

for (const defOff of [null, 1.5, 3]) {
  for (const d of [15, 25, 35]) {
    for (const extra of [0, 250]) {
      const ms = holdFor(d) + extra;
      const rs = [-30, 0, 30].flatMap((ang) => [1, 2, 3].map((seed) => loft(d, ang, defOff, ms, seed)));
      const c = (r: Res) => rs.filter((x) => x.res === r).length;
      const land = rs.filter((x) => x.land);
      console.log(`def ${defOff ?? 'none'} d=${d} hold ${Math.round(ms)} ms: mate ${c('mate')}/${rs.length}, def ${c('def')}, loose ${c('loose')}, out ${c('out')}; peak ${fmt(rs.reduce((a, x) => a + x.maxZ, 0) / rs.length, 1)} m; time to control ${fmt(rs.filter((x) => x.res === 'mate').reduce((a, x) => a + x.t, 0) / Math.max(1, c('mate')))} s; first touch by ${[...new Set(rs.map((x) => x.firstToucher))].join('/')}`);
    }
  }
}

// Crosses: winger at the byline-ish, striker at the penalty spot, a centre-back marking him goal-side, the keeper set.
console.log('\nCrosses from (95, 6) to the penalty spot area');
for (const marked of [false, true]) {
  for (const target of [{ x: 93.5, y: 34 }, { x: 99, y: 31 }, { x: 99, y: 38 }]) {
    const out: string[] = [];
    for (const ms of [500, 700, 900]) {
      const tally: Record<string, number> = {};
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const s = livePlay(seed);
        const me = s.players.find((p) => p.team === 0 && p.role === 'MID')!;
        const st = s.players.find((p) => p.team === 0 && p.role === 'FWD')!;
        const cb = s.players.find((p) => p.team === 1 && p.role === 'DEF')!;
        const gk = goalkeeper(s, 1);
        isolate(s, ...(marked ? [me, st, cb, gk] : [me, st, gk]));
        gk.stun = 0;
        gk.pos = { x: PITCH_W - 1.5, y: PITCH_H / 2 };
        s.switchTimer[0] = 1e9;
        giveBall(s, me, { x: 95, y: 6 }, { x: 0, y: 1 });
        st.pos = { ...target };
        st.vel = { x: 0, y: 0 };
        if (marked) { cb.pos = { x: target.x + 1.2, y: target.y }; cb.vel = { x: 0, y: 0 }; cb.stun = 0; }
        const g0 = s.score[0];
        step(s, { cursor: target, aim: target, loft: loftPower(ms) });
        let r = 'none';
        for (let t = 0; t < 300; t++) {
          step(s, { cursor: target });
          if (s.score[0] > g0) { r = 'GOAL'; break; }
          if (s.phase !== 'play') { r = 'dead'; break; }
          const lt = s.ball.lastTouch;
          if (lt === st.i) { r = 'striker'; break; }
          if (lt === cb.i) { r = 'cb'; break; }
          if (lt === gk.i) { r = 'gk'; break; }
        }
        tally[r] = (tally[r] ?? 0) + 1;
      }
      out.push(`${ms} ms: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' ')}`);
    }
    console.log(`${marked ? 'marked' : 'free'} striker at (${target.x},${target.y}): ${out.join(' | ')}`);
  }
}
