// Emulate the first match's coach timeline with a scripted newbie, using the real CoachTracker and timing constants.
import { newGame, clubTeam } from '/tmp/rt/firstsession/repo/src/meta/game.ts';
import { warmupTeam } from '/tmp/rt/firstsession/repo/src/meta/warmup.ts';
import { createMatch, step } from '/tmp/rt/firstsession/repo/src/sim/match.ts';
import { CoachTracker, minTipMs, SEEN_AFTER_MS, tipText, type TipId } from '/tmp/rt/firstsession/repo/src/client/coach.ts';
import type { HumanInput, MatchState } from '/tmp/rt/firstsession/repo/src/sim/types.ts';
import { PITCH_W, PITCH_H } from '/tmp/rt/firstsession/repo/src/sim/constants.ts';

type Policy = 'passive' | 'dribble' | 'clicker';
const policy = (process.argv[2] ?? 'passive') as Policy;
const seeds = Number(process.argv[3] ?? 10);
const autoHideMs = (text: string) => Math.max(10_000, minTipMs(text) + 4000);

for (let seed = 1; seed <= seeds; seed++) {
  const save = newGame(seed * 7919);
  const opp = warmupTeam(save, true);
  const s = createMatch({ seed: seed * 31, home: clubTeam(save, 0.6), away: opp.away, humanTeam: 0 });
  const tr = new CoachTracker([]);
  let shown: TipId | null = null, text = '', age = 0, counted = false;
  const log: string[] = [];
  const seen: TipId[] = [];
  let lostAt = -1, firstKickTick = -1, firstPassTick = -1;
  const dt = 1000 / 60;
  let prevOwner = s.ball.owner;
  for (let t = 0; t < 60 * 60 && s.phase !== 'fulltime'; t++) {
    const me = s.controlled[0];
    const p = s.players[me];
    let inp: HumanInput = { cursor: { x: p.pos.x, y: p.pos.y } };
    if (policy === 'dribble') inp = { cursor: { x: Math.min(PITCH_W - 2, p.pos.x + 9), y: p.pos.y }, moved: true };
    if (policy === 'clicker') {
      inp = { cursor: { x: Math.min(PITCH_W - 2, p.pos.x + 9), y: p.pos.y }, moved: true };
      // clicks to pass once he has been on the ball 1.5 s (a newbie reading the tip), aimed at the nearest forward teammate
      if (s.ball.owner === me && s.phase === 'play' && shown === 'pass' && age > 1500) {
        const mates = s.players.filter((q) => q.team === 0 && q.i !== me && q.pos.x > p.pos.x - 5).sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y));
        if (mates[0]) inp = { cursor: { ...mates[0].pos }, aim: { ...mates[0].pos }, pass: true, moved: true };
      }
    }
    step(s, inp);
    if (firstKickTick < 0 && (Math.hypot(s.ball.vel.x, s.ball.vel.y) > 0.5)) firstKickTick = s.tick;
    if (lostAt < 0 && s.ball.owner >= 0 && s.players[s.ball.owner].team === 1) lostAt = s.tick;
    tr.observe(s, 0);
    if (shown) {
      age += dt;
      if (!counted && age >= SEEN_AFTER_MS) { counted = true; seen.push(shown); }
      if (age >= autoHideMs(text)) { log.push(`${s.tick}:hide(${shown},auto)`); if (!counted) tr.forget(shown); shown = null; }
      else if (tr.queue.length && age >= minTipMs(text)) { log.push(`${s.tick}:hide(${shown},replaced)`); if (!counted) tr.forget(shown); shown = null; }
    }
    if (!shown && tr.queue.length && s.phase !== 'fulltime') {
      const q = [...tr.queue];
      const id = tr.take(s, 0);
      const dropped = q.slice(0, q.indexOf(id as TipId) < 0 ? q.length : q.indexOf(id as TipId));
      if (dropped.length) log.push(`${s.tick}:dropped(${dropped.join(',')})`);
      if (id) { shown = id; age = 0; counted = false; text = tipText(id, 'mouse', false); log.push(`${s.tick}:SHOW(${id}) owner=${s.ball.owner} ph=${s.phase}`); }
    }
  }
  console.log(`seed ${seed} [${policy}] firstBallMove@${firstKickTick} lostToCPU@${lostAt} (${(lostAt / 60).toFixed(1)}s) seen=${seen.join(',')} | ${log.join(' ')}`);
}
