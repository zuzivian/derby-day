// Run many CPU-vs-CPU matches and audit Law compliance tick by tick.
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams, MID } from './lib.ts';
import { PITCH_W, PITCH_H, RETREAT, BOX_DEPTH, BOX_W, CENTRE_R, GOAL_TOP, GOAL_BOTTOM, BALL_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { inOwnBox, teamX } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
const N = Number(process.argv[2] ?? 30);
const agg: Record<string, number> = {};
const inc = (k: string, n = 1) => (agg[k] = (agg[k] ?? 0) + n);
const samples: Record<string, string[]> = {};
const sample = (k: string, v: string) => { (samples[k] ??= []).length < 6 && samples[k].push(v); };
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 1000 + m, ...teams(m + 3), humans: [false, false] });
  let lastWatchTick = -1;
  let watchSetPiece: string | null = null;
  const watchInfo = new Map<number, string | null>();
  let prevBall = { ...s.ball.pos };
  let prevPhase = s.phase;
  let evIdx = 0;
  let prevSetPiece: string | null = null;
  while (s.phase !== 'fulltime') {
    const preRestart = s.restart ? { ...s.restart, spot: { ...s.restart.spot } } : null;
    const prePlayers = s.players.map((p) => ({ ...p.pos }));
    const preBall = { ...s.ball.pos };
    step(s);
    if (s.offside && s.offside.tick !== lastWatchTick) {
      lastWatchTick = s.offside.tick;
      watchInfo.set(s.offside.tick, s.ball.setPiece);
    }
    // keeper handling outside his box
    const b = s.ball;
    if (b.owner >= 0 && b.inHands && s.players[b.owner].role === 'GK' && s.phase === 'play') {
      const gk = s.players[b.owner];
      if (!inOwnBox(gk.team, gk.pos)) { inc('gk holding outside box (ticks)'); sample('gkOut', `m${m} t${s.tick} gk at ${gk.pos.x.toFixed(1)},${gk.pos.y.toFixed(1)}`); }
    }
    for (; evIdx < s.events.length; evIdx++) {
      const e: any = s.events[evIdx];
      inc('ev:' + e.kind + (e.restart ? ':' + e.restart : '') + (e.color ? ':' + e.color : ''));
      if (e.kind === 'offside') {
        const sp = s.offside ? null : null;
        // find watch: the latest watch tick before this event
        const ticks = [...watchInfo.keys()].filter((t) => t <= e.tick);
        const wt = ticks.length ? Math.max(...ticks) : -1;
        const spAt = watchInfo.get(wt) ?? null;
        if (spAt === 'throwin' || spAt === 'goalkick' || spAt === 'corner') { inc('offside from exempt restart'); sample('offEx', `m${m} t${e.tick} from ${spAt}`); }
        if (teamX(e.team, e.spot.x) < 0.5) { inc('offside IFK spot in own half'); sample('offOwn', `m${m} t${e.tick} spot ${e.spot.x.toFixed(1)}`); }
      }
      if (e.kind === 'restartTaken' && preRestart) {
        const r = preRestart;
        let minOpp = Infinity; let minOppBox = 0;
        for (const p of s.players) {
          if (p.sentOff || p.team === r.team) continue;
          const pp = prePlayers[p.i];
          minOpp = Math.min(minOpp, dist(pp, r.spot));
          if (r.kind === 'goalkick' && inOwnBox(r.team, pp)) minOppBox++;
        }
        if ((r.kind === 'freekick' || r.kind === 'corner') && minOpp < RETREAT - 0.05) {
          // a defender on his goal line for an IFK is allowed
          inc(`${r.kind} taken with opp < 9.15m`); sample(r.kind + 'dist', `m${m} t${e.tick} ${minOpp.toFixed(2)}m spot ${r.spot.x.toFixed(1)},${r.spot.y.toFixed(1)} direct ${r.direct}`);
        }
        if (r.kind === 'throwin' && minOpp < 1.95) inc('throwin opp < 2m');
        if (r.kind === 'goalkick' && minOppBox) inc('goalkick opp in box');
        if (r.kind === 'kickoff') {
          for (const p of s.players) {
            if (p.sentOff) continue;
            const pp = prePlayers[p.i];
            if (teamX(p.team, pp.x) > 0.5 + 1e-9) inc('kickoff player in opp half');
            if (p.team !== r.team && dist(pp, { x: PITCH_W / 2, y: MID }) < CENTRE_R - 0.01) inc('kickoff opp in circle');
          }
        }
        inc('taken:' + r.kind);
      }
      if (e.kind === 'restart' && e.reason === 'out' && e.restart === 'throwin') {
        // compare to ball crossing x
        const dx = Math.abs(e.spot.x - s.ball.pos.x);
        if (dx > 1.5) { inc('throwin spot >1.5m from exit'); sample('thr', `m${m} t${e.tick} spot ${e.spot.x.toFixed(1)} ball ${s.ball.pos.x.toFixed(1)}`); }
      }
      if (e.kind === 'goal') {
        const bp = s.ball.pos;
        if (!(bp.y > GOAL_TOP && bp.y < GOAL_BOTTOM)) inc('goal outside posts');
      }
    }
    prevBall = preBall;
  }
  const alive = [0, 1].map((t) => s.players.filter((p) => p.team === t && !p.sentOff).length);
  if (Math.min(...alive) < 7) inc('team below 7');
  inc('matches');
  inc('goals', s.score[0] + s.score[1]);
}
console.log(agg);
console.log(samples);
