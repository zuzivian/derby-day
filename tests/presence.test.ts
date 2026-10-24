import { describe, expect, test } from 'bun:test';
import { ABANDON_MS, PeerWatch, SILENT_MS, type Presence, type PresenceInput } from '../src/net/presence.ts';

/** Update every 100 ms (like a slow frame loop) from `from` to `to`; returns the last result. */
function run(w: PeerWatch, from: number, to: number, f: (now: number) => Omit<PresenceInput, 'now'>): Presence {
  let p: Presence = { state: 'ok' };
  for (let now = from; now <= to; now += 100) p = w.update({ now, ...f(now) });
  return p;
}

describe('peer presence', () => {
  test('brief stalls with the peer still talking are not a disconnect', () => {
    const w = new PeerWatch();
    expect(run(w, 0, 60_000, (t) => ({ stalled: true, lastHeardAt: t - 50, away: false })).state).toBe('ok');
  });

  test('silence while stalled starts the countdown after SILENT_MS, and talking again clears it', () => {
    const w = new PeerWatch();
    expect(run(w, 1000, 1000 + SILENT_MS, () => ({ stalled: true, lastHeardAt: 1000, away: false })).state).toBe('ok');
    const p = run(w, 1000 + SILENT_MS + 100, 1000 + SILENT_MS + 5100, () => ({ stalled: true, lastHeardAt: 1000, away: false }));
    expect(p.state).toBe('lost');
    expect((p as { remainingMs: number }).remainingMs).toBe(ABANDON_MS - 5100); // 51 updates of 100 ms
    expect(w.update({ now: 8200, stalled: false, lastHeardAt: 8190, away: false }).state).toBe('ok');
    // A fresh loss gets the full window again.
    w.update({ now: 8300, stalled: false, lastHeardAt: 8290, away: true });
    expect(w.update({ now: 8400, stalled: false, lastHeardAt: 8290, away: true })).toEqual({ state: 'lost', remainingMs: ABANDON_MS - 200 });
  });

  test('lost for the whole window is abandoned, and stays abandoned', () => {
    const w = new PeerWatch();
    expect(run(w, 0, ABANDON_MS - 100, () => ({ stalled: true, lastHeardAt: 0, away: true })).state).toBe('lost');
    expect(w.update({ now: ABANDON_MS, stalled: true, lastHeardAt: 0, away: true }).state).toBe('abandoned');
    expect(w.update({ now: ABANDON_MS + 100, stalled: false, lastHeardAt: ABANDON_MS + 100, away: false }).state).toBe('abandoned');
  });

  test('our own freeze does not count against the opponent', () => {
    const w = new PeerWatch();
    run(w, 0, 1000, (t) => ({ stalled: true, lastHeardAt: t, away: false }));
    // This tab freezes for 25 s (shader compile, backgrounded). On the first frame back the
    // peer's queued messages haven't been read yet: still not "lost", and certainly not abandoned.
    expect(w.update({ now: 26_000, stalled: true, lastHeardAt: 1000, away: false }).state).toBe('ok');
    expect(run(w, 26_100, 27_000, () => ({ stalled: true, lastHeardAt: 1000, away: false })).state).toBe('ok');
    // Even with the relay saying "away", each frozen gap counts at most 250 ms.
    w.update({ now: 30_000, stalled: true, lastHeardAt: 1000, away: true });
    const p = w.update({ now: 60_000, stalled: true, lastHeardAt: 1000, away: true });
    expect(p).toEqual({ state: 'lost', remainingMs: ABANDON_MS - 500 });
  });
});
