// How much does lockstep stall for a given input delay and link? Two peers in
// virtual time over the in-memory network (src/net/memory.ts), bots for inputs.
//
//   bun run scripts/net-probe.ts            default grid
//   bun run scripts/net-probe.ts 1800       ticks per run (default 1800 = 30 s)
//
// "waited" is the share of wall time a peer was due to step but had no input
// from the other side yet: the stutter a player would see.

import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { Lockstep, type LockstepMsg } from '../src/net/lockstep.ts';
import { botInput, drivePair, MemoryNetwork } from '../src/net/memory.ts';
import { createMatch, fingerprint } from '../src/sim/match.ts';

const N = Number(process.argv[2] ?? 1800);
const [a, b] = generateLadder(3, 2);
const sa = ladderSquad(a);
const sb = ladderSquad(b);
const home = toTeamSetup(a, sa, autoLineup(sa));
const away = toTeamSetup(b, sb, autoLineup(sb));

const links: [string, number, number][] = [
  ['same machine (BroadcastChannel-like)', 0, 4],
  ['same city, 10-25 ms one way', 10, 25],
  ['same region, 25-45 ms', 25, 45],
  ['cross-country, 40-70 ms', 40, 70],
  ['intercontinental, 80-120 ms', 80, 120],
];
const delays = [2, 3, 4, 5, 6, 8];

console.log(`${N} ticks per run. Cells: share of time the worse peer waited / how much longer the match took than real time.`);
console.log(['link'.padEnd(38), ...delays.map((d) => `D=${d} (${Math.round((d * 1000) / 60)}ms)`.padStart(16))].join(''));
for (const [name, lo, hi] of links) {
  const cells: string[] = [];
  for (const d of delays) {
    const net = new MemoryNetwork<LockstepMsg>({ seed: d * 101 + lo, minMs: lo, maxMs: hi });
    const mk = (side: 0 | 1) => new Lockstep({ state: createMatch({ seed: 7, home: structuredClone(home), away: structuredClone(away), halfSeconds: 120, humans: [true, true] }), side, transport: net.ends[side], delay: d, now: () => net.now });
    const peers: [Lockstep, Lockstep] = [mk(0), mk(1)];
    const st = drivePair(net, peers, [botInput(1), botInput(2)], N);
    if (fingerprint(peers[0].s) !== fingerprint(peers[1].s)) throw new Error('peers diverged');
    const waited = Math.max(...st.stalledMs) / st.elapsedMs;
    const slow = st.elapsedMs / ((N * 1000) / 60) - 1;
    cells.push(`${(waited * 100).toFixed(1)}% / +${Math.max(0, slow * 100).toFixed(0)}%`.padStart(16));
  }
  console.log([name.padEnd(38), ...cells].join(''));
}
