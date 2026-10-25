import { PITCH_W } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
const s = createMatch({ seed: 77, ...teams(5), halfSeconds: 30, humanTeam: 0 });
const gkX = (team: 0 | 1) => s.players.find((p) => p.team === team && p.role === 'GK')!.pos.x.toFixed(1);
const show = (label: string) => console.log(`${label}: kickoff team ${s.restart?.team ?? s.kickoffTeam}, taker #${s.restart?.taker} (team ${s.players[s.restart!.taker].team}), home keeper x=${gkX(0)}, away keeper x=${gkX(1)}; human (home) attacks toward x=${s.players[s.controlled[0]].team === 0 ? PITCH_W : 0}`);
show('1st half kick-off');
let shown = false;
while (s.phase !== 'fulltime') { step(s, {}); if (s.half === 2 && s.phase === 'kickoff' && !shown) { show('2nd half kick-off'); shown = true; } }
const ht = s.events.find((e) => e.kind === 'halftime')!; const ft = s.events.find((e) => e.kind === 'fulltime')!;
console.log(`halftime at clock tick ${ht.tick} (${ht.minute}'), fulltime at ${ft.tick} (${ft.minute}'), halfTicks ${s.halfTicks}; events with 'added' or stoppage: ${s.events.filter((e) => JSON.stringify(e).includes('added')).length}`);
