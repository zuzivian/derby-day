import { runShootout, createShootout, recordKick, nextTurn, KICKS_PER_SIDE } from '/tmp/rt/rules/repo/src/meta/shootout.ts';
const side = (n: string, k: number) => ({ name: n, takers: Array.from({ length: 10 }, (_, i) => ({ name: `${n}${i + 1}`, shooting: 0.5 })), keeper: { name: `${n}GK`, goalkeeping: k } });
let badOrder = 0, lens: number[] = [], earlyOk = 0, maxLen = 0, repeatBeforeKeeper = 0;
for (let seed = 1; seed <= 3000; seed++) {
  const s = runShootout(seed, side('A', 0.5), side('B', 0.5));
  // alternate strictly
  for (let i = 1; i < s.kicks.length; i++) if (s.kicks[i].side === s.kicks[i - 1].side) badOrder++;
  if (s.kicks[0].side !== s.first) badOrder++;
  maxLen = Math.max(maxLen, s.kicks.length);
  const takers = s.kicks.filter((k) => k.side === 0).map((k) => k.taker);
  if (takers.length > 10) repeatBeforeKeeper++;
}
// early finish: A scores 3, B misses 3 -> done after B's 3rd
const s = createShootout(1, side('A', 0.5), side('B', 0.5));
const seq: string[] = [];
while (!s.done) { const t = nextTurn(s)!; recordKick(s, t.side, t.taker.name, t.side === s.first ? 'goal' : 'saved'); seq.push(`${t.side}`); }
console.log(`3000 CPU shootouts: kicks out of ABAB order ${badOrder}; longest ${maxLen} kicks; shootouts where a side reused a taker before its keeper kicked: ${repeatBeforeKeeper}`);
console.log(`first side scores every kick, second misses every kick: finished after ${seq.length} kicks (${seq.join('')}), score ${s.score.join('-')}`);
