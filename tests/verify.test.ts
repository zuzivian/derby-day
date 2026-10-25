import { describe, expect, test } from 'bun:test';
import { verifyCode, verifyReplay } from '../server/verify.ts';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { decodeReplay, encodeReplay, ReplayRecorder, type Replay } from '../src/meta/replay.ts';
import { createMatch, step } from '../src/sim/match.ts';

function played(seed = 3): { code: string; replay: Replay } {
  const [a, b] = generateLadder(7, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const opts = { seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 20, humanTeam: 0 as const };
  const s = createMatch(opts);
  const rec = new ReplayRecorder(opts, 'Ranked');
  for (let t = 0; s.phase !== 'fulltime'; t++) {
    step(s, rec.push({ cursor: { x: 30 + 20 * Math.sin(t / 70), y: 20 + 12 * Math.cos(t / 45) }, moved: true, pass: t % 120 === 0, sprint: t % 300 < 80 }));
  }
  const replay = rec.finish(s, 1_700_000_000);
  return { code: encodeReplay(replay), replay };
}

describe('server/verify', () => {
  const { code, replay } = played();

  test('an honest replay verifies, with the true score, stats and fingerprint', () => {
    const v = verifyCode(code);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    if (!('score' in v)) throw new Error('no verdict');
    expect(v.score).toEqual(replay.score);
    expect(v.fp).toBe(replay.fp);
    expect(v.finished).toBe(true);
    expect(v.stats[0].passes).toBeGreaterThan(0);
    expect(v.fingerprint.length).toBeGreaterThan(100);
  });

  test('an edited score is caught', () => {
    const r = decodeReplay(code);
    r.score = [r.score[0] + 3, r.score[1]];
    const v = verifyReplay(decodeReplay(encodeReplay(r)));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/Claims/);
    expect(v.score).toEqual(replay.score);
  });

  test('a tampered input log is caught even when the claims are left alone', () => {
    const r = decodeReplay(code);
    // Nudge the pointer for a stretch in each quarter: a different match, same claimed result and hash.
    // (Several stretches, so one that falls where input is ignored, a kick-off line-up or the break, still leaves others.)
    for (const q of [1, 2, 3]) {
      const k = Math.floor((r.runs.length * q) / 4);
      for (let i = k; i < k + 40; i++) {
        const inp = r.runs[i].input;
        r.runs[i] = { n: r.runs[i].n, input: { ...inp, cursor: { x: 50, y: 5 }, moved: true, pass: true } };
      }
    }
    const v = verifyReplay(decodeReplay(encodeReplay(r)));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/state hash/);
  });

  test('a log cut short before full-time is not a result', () => {
    const r = decodeReplay(code);
    r.ticks = Math.floor(r.ticks / 2);
    const v = verifyReplay(r);
    expect(v.ok).toBe(false);
    expect(v.finished).toBe(false);
    expect(v.problems.join(' ')).toMatch(/before full-time/);
  });

  test('a replay from another sim version is not vouched for', () => {
    const r = decodeReplay(code);
    r.sim = r.sim + 1;
    expect(verifyReplay(r).problems.join(' ')).toMatch(/sim version/);
  });

  test('garbage is a verdict, not a crash', () => {
    expect(verifyCode('not a replay')).toMatchObject({ ok: false, problems: [expect.stringMatching(/Not a valid replay/)] });
  });
});
