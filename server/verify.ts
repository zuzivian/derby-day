// Re-simulate a replay code headlessly and check it against what it claims.
//
//   bun server/verify.ts <replay code>      prints a JSON verdict; exit code 1 if it doesn't hold up
//   echo <code> | bun server/verify.ts -
//
// A replay (src/meta/replay.ts) is the match options plus the input log, and
// it carries the final score and a hash of the final state. The sim is
// deterministic, so a server can replay the inputs and get the true result:
// a client that edits the score, the goals or the inputs after the fact is
// caught here. This is the check a future ranked server runs before trusting
// a submitted result (docs/ROADMAP.md, Phase 2 exit criteria).
//
// What it can't catch: inputs that were really played but by a bot. That
// needs server-side input timing or the server running the match live.

import { decodeReplay, finalHash, replayTo, type Replay } from '../src/meta/replay.ts';
import { SIM_VERSION } from '../src/sim/constants.ts';
import { fingerprint } from '../src/sim/match.ts';
import type { TeamStats } from '../src/sim/types.ts';

export interface Verdict {
  /** The claims all match the re-simulation (and it was simulated on this engine). */
  ok: boolean;
  /** Why not, in words. Empty when ok. */
  problems: string[];
  /** What the re-simulation produced. */
  score: [number, number];
  goals: { tick: number; team: 0 | 1; scorer: string }[];
  stats: [TeamStats, TeamStats];
  /** finalHash() of the re-simulated state, and the full fingerprint string it hashes. */
  fp: number;
  fingerprint: string;
  ticks: number;
  /** The log runs to full-time (a result can only be claimed for a finished match). */
  finished: boolean;
  /** What the replay said. */
  claimed: { score: [number, number]; fp: number; goals: number };
}

export function verifyReplay(r: Replay): Verdict {
  const s = replayTo(r, r.ticks);
  const fp = finalHash(s);
  const problems: string[] = [];
  if (r.sim !== SIM_VERSION) problems.push(`Recorded on sim version ${r.sim}; this server runs ${SIM_VERSION}, so it can't be checked.`);
  if (s.tick !== r.ticks) problems.push(`Log is ${r.ticks} ticks but the match stopped at ${s.tick}.`);
  if (s.phase !== 'fulltime') problems.push('The input log ends before full-time.');
  if (s.score[0] !== r.score[0] || s.score[1] !== r.score[1]) problems.push(`Claims ${r.score[0]}-${r.score[1]}, re-simulation gives ${s.score[0]}-${s.score[1]}.`);
  if (!r.fp) problems.push('No final state hash recorded.');
  else if (r.fp !== fp) problems.push(`Final state hash ${hex(r.fp)} does not match the re-simulation's ${hex(fp)}.`);
  const goalsMatch = r.goals.length === s.goals.length && r.goals.every((g, i) => g.tick === s.goals[i].tick && g.team === s.goals[i].team);
  if (!goalsMatch) problems.push(`Goal list differs (${r.goals.length} claimed, ${s.goals.length} re-simulated).`);
  return {
    ok: problems.length === 0,
    problems,
    score: [s.score[0], s.score[1]],
    goals: s.goals.map((g) => ({ tick: g.tick, team: g.team, scorer: g.scorer })),
    stats: [{ ...s.stats[0] }, { ...s.stats[1] }],
    fp,
    fingerprint: fingerprint(s),
    ticks: s.tick,
    finished: s.phase === 'fulltime',
    claimed: { score: [r.score[0], r.score[1]], fp: r.fp, goals: r.goals.length },
  };
}

/** Decode and verify. A code that doesn't decode is a verdict too, not an exception. */
export function verifyCode(code: string): Verdict | { ok: false; problems: string[] } {
  let r: Replay;
  try {
    r = decodeReplay(code.trim());
  } catch (e) {
    return { ok: false, problems: [`Not a valid replay code: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return verifyReplay(r);
}

const hex = (n: number) => `#${(n >>> 0).toString(16).padStart(8, '0')}`;

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: bun server/verify.ts <replay code | ->');
    process.exit(2);
  }
  const code = arg === '-' ? await new Response(Bun.stdin.stream()).text() : arg;
  const v = verifyCode(code);
  console.log(JSON.stringify(v, null, 2));
  process.exit(v.ok ? 0 : 1);
}
