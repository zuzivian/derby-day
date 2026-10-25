// Click passes at 8/15/25/35 m, with and without a defender near the lane.
import { fmt, giveBall, isolate, livePlay, mid, step, dist, len, type MatchState, type Vec } from './lib.ts';

type Outcome = 'mate' | 'def' | 'loose' | 'out' | 'other';

function scene(d: number, angDeg: number, defOff: number | null, mateRun: Vec | null, aimErr: Vec, seed: number) {
  const s = livePlay(seed);
  const me = s.players[s.controlled[0]];
  const mate = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== me.i)!;
  const def = s.players.find((p) => p.team === 1 && p.role === 'DEF')!;
  const keep = defOff === null ? [me, mate] : [me, mate, def];
  isolate(s, ...keep);
  s.switchTimer[0] = 1e9;
  const at = { x: 8, y: 34 };
  giveBall(s, me, at);
  const a = (angDeg * Math.PI) / 180;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  mate.pos = { x: at.x + dir.x * d, y: at.y + dir.y * d };
  mate.vel = mateRun ? { ...mateRun } : { x: 0, y: 0 };
  mate.facing = { x: -dir.x, y: -dir.y };
  if (defOff !== null) {
    // Halfway along the lane, `defOff` metres to the side of it.
    def.pos = { x: at.x + dir.x * d * 0.5 - dir.y * defOff, y: at.y + dir.y * d * 0.5 + dir.x * defOff };
    def.vel = { x: 0, y: 0 };
    def.stun = 0;
  }
  return { s, me, mate, def };
}

function run(d: number, ang: number, defOff: number | null, mateRun: Vec | null, aimErr: Vec, seed: number) {
  const { s, me, mate, def } = scene(d, ang, defOff, mateRun, aimErr, seed);
  const aim = { x: mate.pos.x + aimErr.x, y: mate.pos.y + aimErr.y };
  step(s, { cursor: aim, aim, pass: true });
  const kickV = len(s.ball.vel);
  const rec = s.ball.receiver;
  let t = 0;
  let maxZ = 0;
  let arrival = 0;
  let out: Outcome = 'other';
  let minGap = Infinity;
  let passedHim = false;
  const start = { ...s.ball.pos };
  while (t < 300) {
    const prevV = len(s.ball.vel);
    step(s, { cursor: aim });
    t++;
    maxZ = Math.max(maxZ, s.ball.z);
    minGap = Math.min(minGap, dist(s.ball.pos, mate.pos));
    // Ball further from the passer than the receiver is and more than 1.5 m past him: it beat him.
    if (s.ball.owner < 0 && dist(start, s.ball.pos) > dist(start, mate.pos) + 1.5 && dist(s.ball.pos, mate.pos) > 1.5) passedHim = true;
    if (s.phase !== 'play') {
      out = 'out';
      break;
    }
    if (s.ball.owner >= 0) {
      arrival = prevV;
      out = s.ball.owner === mate.i ? 'mate' : s.ball.owner === def.i ? 'def' : 'other';
      if (s.ball.owner === me.i) out = 'other';
      break;
    }
    if (len(s.ball.vel) < 0.05) {
      out = 'loose';
      break;
    }
  }
  return { kickV, rec: rec === mate.i, t: t / 60, maxZ, arrival, out, passedHim, minGap };
}

const angles = [-60, -30, 0, 30, 60, 90, 150];
console.log('Static receiver, pointer exactly on him');
for (const defOff of [null, 3, 2, 1.2]) {
  for (const d of [8, 15, 25, 35]) {
    const rs = angles.flatMap((a) => [1, 2, 3].map((seed) => run(d, a, defOff, null, { x: 0, y: 0 }, seed)));
    const n = rs.length;
    const c = (o: Outcome) => rs.filter((r) => r.out === o).length;
    const mates = rs.filter((r) => r.out === 'mate');
    const avg = (f: (r: (typeof rs)[number]) => number, arr = mates) => (arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : NaN);
    console.log(
      `def ${defOff === null ? 'none' : defOff + 'm'} d=${d}m: complete ${c('mate')}/${n}, def ${c('def')}, loose ${c('loose')}, out ${c('out')}, other ${c('other')} | assist ${rs.filter((r) => r.rec).length}/${n} | kick ${fmt(avg((r) => r.kickV, rs), 1)} m/s, arrive ${fmt(avg((r) => r.arrival), 1)} m/s, t ${fmt(avg((r) => r.t))} s, airborne ${rs.filter((r) => r.maxZ > 0.05).length}, passedHim ${rs.filter((r) => r.passedHim).length}`,
    );
  }
}

console.log('\nReceiver running across at 6 m/s (perpendicular), pointer on him');
for (const d of [8, 15, 25, 35]) {
  const rs = [-30, 0, 30].flatMap((a) => [1, 2, 3].map((seed) => {
    const r = (a * Math.PI) / 180;
    return run(d, a, null, { x: -Math.sin(r) * 6, y: Math.cos(r) * 6 }, { x: 0, y: 0 }, seed);
  }));
  const mates = rs.filter((r) => r.out === 'mate');
  console.log(`d=${d}: complete ${mates.length}/${rs.length}, assist ${rs.filter((r) => r.rec).length}, t ${fmt(mates.reduce((a, r) => a + r.t, 0) / mates.length)} s, outcomes ${rs.map((r) => r.out).join(',')}`);
}

console.log('\nPointer error (3D depth): click lands 2.3 m behind him (screen-up = -y here), and 1.5 m to one side');
for (const err of [{ x: 0, y: -2.3 }, { x: 0, y: 2.3 }, { x: 2.3, y: 0 }, { x: -2.3, y: 0 }, { x: 1.5, y: 1.5 }]) {
  for (const d of [8, 15, 25, 35]) {
    const rs = angles.map((a) => run(d, a, null, null, err, 1));
    console.log(`err (${err.x},${err.y}) d=${d}: assist ${rs.filter((r) => r.rec).length}/${rs.length}, complete ${rs.filter((r) => r.out === 'mate').length}, outcomes ${rs.map((r) => r.out).join(',')}`);
  }
}
