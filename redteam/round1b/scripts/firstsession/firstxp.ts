import { newGame } from '/tmp/rt/firstsession/repo/src/meta/game.ts';
import { applyResult } from '/tmp/rt/firstsession/repo/src/meta/game.ts';
import { completeFirstMatch } from '/tmp/rt/firstsession/repo/src/client/firstrun.ts';
for (const [gf, ga] of [[3, 0], [0, 0], [0, 5]]) {
  const s = newGame(42); const prefs: any = {};
  const r = completeFirstMatch(s, prefs, { gf, ga, scorers: [], opponent: { name: 'X', short: 'XXX' } });
  const w = newGame(43);
  const ws = applyResult(w, null, { name: 'Y', short: 'YYY' }, gf, ga, false, [], 'Warm-up friendly', false, 'easy');
  console.log(`${gf}-${ga}: first match +${r.summary.xp.total} (${r.summary.xp.parts.map((p) => p.label + ' ' + p.xp).join(', ')}) | same score in a later warm-up +${ws.xp.total} (${ws.xp.parts.map((p) => p.label + ' ' + p.xp).join(', ')}) | marks after first match: ${JSON.stringify(prefs.marks)}`);
}
