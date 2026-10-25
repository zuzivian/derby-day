// At the tick each restart is taken in CPU matches, check every player's position against the Law.
import { PITCH_W, PITCH_H, RETREAT, BOX_DEPTH, BOX_W, CENTRE_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { inOwnBox, teamX, attackDir } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 30);
const stats: Record<string, { n: number; bad: number; minOpp: number; ex: string[] }> = {};
const rec = (k: string) => (stats[k] ??= { n: 0, bad: 0, minOpp: 1e9, ex: [] });
let throwSpotErr = 0, throwN = 0;
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 3000 + m, ...teams(m + 21), humans: [false, false] });
  let snap: any = null;
  while (s.phase !== 'fulltime') {
    // positions before the step (the kick happens inside step; players move after)
    const before = s.players.map((p) => ({ ...p.pos }));
    const r = s.restart ? { ...s.restart, spot: { ...s.restart.spot } } : null;
    const nEv = s.events.length;
    const bpos = { ...s.ball.pos }; const bvel = { ...s.ball.vel };
    step(s);
    for (const e of s.events.slice(nEv)) {
      if (e.kind === 'restart' && (e as any).restart === 'throwin' && (e as any).reason === 'out') {
        // where did the ball cross the touchline? back-project from the last position
        throwN++;
      }
      if (e.kind !== 'restartTaken') continue;
      const kind = (e as any).restart as string; const team = e.team; const spot = (e as any).spot;
      const st = rec(kind); st.n++;
      let bad = '';
      for (const p of s.players) {
        if (p.sentOff || p.i === e.player) continue;
        const pos = before[p.i]; const opp = p.team !== team;
        const d = Math.hypot(pos.x - spot.x, pos.y - spot.y);
        if (opp) st.minOpp = Math.min(st.minOpp, d);
        if (kind === 'kickoff') { if (teamX(p.team, pos.x) > 0.5 + 0.01 / PITCH_W) bad ||= `#${p.i} not in own half x=${pos.x.toFixed(2)}`; if (opp && d < CENTRE_R - 0.01) bad ||= `opponent #${p.i} inside circle d=${d.toFixed(2)}`; }
        if ((kind === 'freekick' || kind === 'corner') && opp && d < RETREAT - 0.05) {
          const onLine = Math.abs(pos.x - (p.team === 0 ? 0 : PITCH_W)) < 0.6 && Math.abs(pos.y - PITCH_H / 2) < 3.66;
          if (!onLine) bad ||= `opponent #${p.i} ${d.toFixed(2)} m from the ball`;
        }
        if (kind === 'freekick' && opp && inOwnBox(team, spot) && inOwnBox(team, pos)) bad ||= `opponent #${p.i} inside the kicker's penalty area`;
        if (kind === 'goalkick' && opp && inOwnBox(team, pos)) bad ||= `opponent #${p.i} inside the penalty area`;
        if (kind === 'throwin' && opp && d < 2 - 0.05) bad ||= `opponent #${p.i} ${d.toFixed(2)} m from the thrower's spot`;
        if (kind === 'penalty' && p.role !== 'GK') { if (inOwnBox(team === 0 ? 1 : 0, pos) || d < RETREAT - 0.05) bad ||= `#${p.i} in the area/arc d=${d.toFixed(2)}`; }
      }
      if (bad) { st.bad++; if (st.ex.length < 3) st.ex.push(`seed ${3000 + m} tick ${s.tick}: ${bad}`); }
    }
  }
}
for (const [k, v] of Object.entries(stats)) console.log(`${k}: taken ${v.n}, illegal positions ${v.bad}, closest opponent ${v.minOpp.toFixed(2)} m ${v.ex.join(' | ')}`);
