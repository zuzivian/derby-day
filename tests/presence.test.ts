import { describe, expect, test } from 'bun:test';
import { ABANDON_MS, PeerWatch, SILENT_MS } from '../src/net/presence.ts';

describe('peer presence', () => {
  test('brief stalls with the peer still talking are not a disconnect', () => {
    const w = new PeerWatch();
    for (let t = 0; t < 60_000; t += 100) expect(w.update({ now: t, stalled: true, lastHeardAt: t - 50, away: false }).state).toBe('ok');
  });

  test('silence while stalled starts the countdown after SILENT_MS, and talking again clears it', () => {
    const w = new PeerWatch();
    expect(w.update({ now: 1000 + SILENT_MS - 1, stalled: true, lastHeardAt: 1000, away: false }).state).toBe('ok');
    expect(w.update({ now: 1000 + SILENT_MS + 1, stalled: true, lastHeardAt: 1000, away: false })).toEqual({ state: 'lost', remainingMs: ABANDON_MS });
    expect(w.update({ now: 1000 + SILENT_MS + 5001, stalled: true, lastHeardAt: 1000, away: false })).toEqual({ state: 'lost', remainingMs: ABANDON_MS - 5000 });
    expect(w.update({ now: 9000, stalled: false, lastHeardAt: 8990, away: false }).state).toBe('ok');
    // A fresh loss gets the full window again.
    expect(w.update({ now: 20_000, stalled: false, lastHeardAt: 19_990, away: true })).toEqual({ state: 'lost', remainingMs: ABANDON_MS });
  });

  test('lost for the whole window is abandoned, and stays abandoned', () => {
    const w = new PeerWatch();
    w.update({ now: 0, stalled: true, lastHeardAt: 0, away: true });
    expect(w.update({ now: ABANDON_MS - 1, stalled: true, lastHeardAt: 0, away: true }).state).toBe('lost');
    expect(w.update({ now: ABANDON_MS, stalled: true, lastHeardAt: 0, away: true }).state).toBe('abandoned');
    expect(w.update({ now: ABANDON_MS + 1, stalled: false, lastHeardAt: ABANDON_MS + 1, away: false }).state).toBe('abandoned');
  });
});
