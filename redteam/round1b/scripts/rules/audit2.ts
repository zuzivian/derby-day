// Frequency of restart takers touching the ball again before anyone else (CPU v CPU), and keeper catch positions.
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { inOwnBox } from '/tmp/rt/rules/repo/src/sim/field.ts';
const N = Number(process.argv[2] ?? 60);
const agg: Record<string, number> = {};
const inc = (k: string, n = 1) => (agg[k] = (agg[k] ?? 0) + n);
const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 5000 + m, ...teams(m + 11), humans: [false, false] });
  let watch: { kind: string; taker: number; tick: number } | null = null;
  let evIdx = 0;
  let wasHands = false;
  while (s.phase !== 'fulltime') {
    step(s);
    for (; evIdx < s.events.length; evIdx++) {
      const e: any = s.events[evIdx];
      if (e.kind === 'restartTaken') { watch = { kind: e.restart, taker: e.player, tick: e.tick }; inc('taken:' + e.restart); }
      if (e.kind === 'restart' || e.kind === 'goal' || e.kind === 'halftime') watch = null;
    }
    const b = s.ball;
    if (watch && s.phase === 'play' && s.tick > watch.tick) {
      if (b.lastTouch !== watch.taker && b.lastTouch >= 0) watch = null;
      else if (b.owner === watch.taker) {
        inc('retouch:' + watch.kind + (b.inHands ? ' (in hands)' : ''));
        if (ex.length < 10) ex.push(`m${m} ${watch.kind} taker ${watch.taker} retouch ${((s.tick - watch.tick) / 60).toFixed(2)}s${b.inHands ? ' HANDS' : ''}`);
        watch = null;
      }
    }
    const hands = b.owner >= 0 && b.inHands && s.players[b.owner].role === 'GK';
    if (hands && !wasHands && s.phase === 'play') {
      const gk = s.players[b.owner];
      inc('keeper catches');
      if (!inOwnBox(gk.team, b.pos)) inc('catch with ball outside box');
    }
    wasHands = hands;
  }
}
console.log(agg); console.log(ex);
