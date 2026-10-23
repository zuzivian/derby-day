import { describe, expect, test } from 'bun:test';
import { toTeamSetup } from '../src/meta/club.ts';
import { newGame } from '../src/meta/game.ts';
import { deriveShort, renameClub, rerollColours, rerollName, validateClubName, NAME_MAX } from '../src/meta/identity.ts';
import { checkDrill, createTraining, CARRIER, DRILLS, filterInput, holdFrozen, HUMAN, MARKER, onPitch, sparringSide, stageDrill, type Drill, type DrillId } from '../src/client/drills.ts';
import { step } from '../src/sim/match.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';
import { dist } from '../src/sim/vec.ts';

describe('club name validation', () => {
  test('trims and collapses spaces', () => {
    expect(validateClubName('   Harbour   Lights  FC ')).toEqual({ ok: true, name: 'Harbour Lights FC' });
  });
  test('length bounds are 3 to 28 after trimming', () => {
    expect(validateClubName('  ab ').ok).toBe(false);
    expect(validateClubName('abc').ok).toBe(true);
    expect(validateClubName('a'.repeat(NAME_MAX)).ok).toBe(true);
    expect(validateClubName('a'.repeat(NAME_MAX + 1)).ok).toBe(false);
  });
  test("allows letters, digits, spaces and . ' - &", () => {
    expect(validateClubName("St. Kilda's Rovers-1904 & Co").ok).toBe(true);
    expect(validateClubName('Sjöholm IF').ok).toBe(true);
  });
  test('rejects other characters with a reason', () => {
    const r = validateClubName('Rovers <script>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/letters/);
    expect(validateClubName('Rovers!').ok).toBe(false);
    expect(validateClubName('...').ok).toBe(false);
  });
  test('rejects real club names', () => {
    expect(validateClubName('real  madrid').ok).toBe(false);
  });
});

describe('short codes', () => {
  test('always three ASCII capitals', () => {
    for (const n of ['Harbour Lights FC', 'FC Ås', 'Sjöholm IF', 'United', 'AB 12', 'The Kestrel Park Rangers', 'Xi']) {
      expect(deriveShort(n)).toMatch(/^[A-Z0-9]{3}$/);
    }
  });
  test('skips filler words', () => {
    expect(deriveShort('Brennholm United')).toBe('BNM');
    expect(deriveShort('Harbour Lights FC')).toBe('HLI');
    expect(deriveShort('North East Coast Wanderers')).toBe('NEC');
  });
});

describe('identity edits', () => {
  test('rename updates name, short code and the founding news line', () => {
    const s = newGame(5);
    expect(renameClub(s, '  Harbour Lights ')).toBe(true);
    expect(s.club.name).toBe('Harbour Lights');
    expect(s.club.short).toBe('HLI');
    expect(s.news.some((n) => n.startsWith('Harbour Lights founded.'))).toBe(true);
    expect(renameClub(s, 'x')).toBe(false);
    expect(s.club.name).toBe('Harbour Lights');
  });
  test('name and colours re-roll independently', () => {
    const s = newGame(9);
    const { primary, secondary, name } = s.club;
    rerollName(s);
    expect(s.club.name).not.toBe(name);
    expect([s.club.primary, s.club.secondary]).toEqual([primary, secondary]);
    const n2 = s.club.name;
    rerollColours(s);
    expect(s.club.name).toBe(n2);
    expect(s.club.primary !== primary || s.club.secondary !== secondary).toBe(true);
  });
  test('locked after the first match', () => {
    const s = newGame(9);
    s.club.played = 1;
    const before = { ...s.club };
    rerollName(s);
    rerollColours(s);
    expect(renameClub(s, 'New Name')).toBe(false);
    expect(s.club).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Drills: a scripted "player" must be able to pass each one with the real sim.

function training(seed = 11): MatchState {
  const save = newGame(seed);
  return createTraining(1234, toTeamSetup(save.club, save.squad, save.lineup, 0.6));
}

/** Runs one drill to completion with a simple scripted input; returns ticks taken and retries. */
function runDrill(s: MatchState, id: DrillId, d0: Drill, brain: (s: MatchState, t: number) => HumanInput, limit = 3000) {
  let d = d0;
  let retries = 0;
  let t0 = 0;
  for (let t = 0; t < limit; t++) {
    holdFrozen(s, d);
    step(s, filterInput(id, brain(s, t - t0)));
    holdFrozen(s, d);
    const r = checkDrill(s, d);
    if (r.done) {
      return { ticks: t, retries };
    }
    if (r.retry) {
      retries++;
      d = stageDrill(s, id);
      t0 = t + 1;
    }
  }
  throw new Error(`${id} not completed in ${limit} ticks (${retries} retries)`);
}

describe('training-ground drills', () => {
  test('sparring bibs never match our kit', () => {
    const home = { primary: '#f97316' } as Parameters<typeof sparringSide>[0];
    expect(sparringSide(home).primary).not.toBe('#f97316');
  });

  test('every drill layout is on the pitch and the right player has the ball', () => {
    const s = training();
    for (const id of DRILLS) {
      const d = stageDrill(s, id);
      for (const p of s.players) expect(onPitch(p.pos)).toBe(true);
      expect(s.phase).toBe('play');
      expect(s.ball.owner).toBe(id === 'tackle' ? CARRIER : HUMAN);
      expect(d.frozen.has(HUMAN)).toBe(false);
      expect(d.frozen.has(CARRIER)).toBe(id !== 'tackle');
    }
  });

  test('filterInput only lets through what the drill teaches', () => {
    const all: HumanInput = { cursor: { x: 1, y: 1 }, pass: true, shoot: 0.5, switchPlayer: true };
    expect(filterInput('move', all)).toEqual({ cursor: { x: 1, y: 1 } });
    expect(filterInput('pass', all)).toEqual({ cursor: { x: 1, y: 1 }, pass: true });
    expect(filterInput('shoot', all)).toEqual({ cursor: { x: 1, y: 1 }, shoot: 0.5 });
    expect(filterInput('tackle', all)).toEqual({ cursor: { x: 1, y: 1 }, pass: true });
  });

  test('move: running to the marker passes the drill, mouse and keys', () => {
    const s = training();
    const r = runDrill(s, 'move', stageDrill(s, 'move'), () => ({ cursor: MARKER }));
    expect(r.ticks).toBeLessThan(300);
    const k = training();
    const d = stageDrill(k, 'move');
    const rk = runDrill(k, 'move', d, (st) => {
      const p = st.players[HUMAN].pos;
      return { dir: { x: Math.sign(Math.round(MARKER.x - p.x)), y: Math.sign(Math.round(MARKER.y - p.y)) } };
    });
    expect(rk.ticks).toBeLessThan(400);
  });

  test('move: clicks do nothing yet, so the ball stays with the human', () => {
    const s = training();
    const d = stageDrill(s, 'move');
    for (let t = 0; t < 60; t++) {
      holdFrozen(s, d);
      step(s, filterInput('move', { cursor: { x: 24, y: 30 }, pass: true, shoot: 1 }));
      holdFrozen(s, d);
    }
    expect(s.ball.owner).toBe(HUMAN);
  });

  test('pass: a pass to a teammate passes the drill', () => {
    const s = training();
    runDrill(s, 'move', stageDrill(s, 'move'), () => ({ cursor: MARKER }));
    const d = stageDrill(s, 'pass', false);
    const r = runDrill(s, 'pass', d, (st, t) => {
      const mate = st.players[3].pos;
      return t === 20 ? { cursor: mate, pass: true } : { cursor: st.players[HUMAN].pos };
    });
    expect(r.ticks).toBeLessThan(400);
  });

  test('shoot: a shot at goal scores within a few attempts', () => {
    const s = training();
    const r = runDrill(s, 'shoot', stageDrill(s, 'shoot'), (_st, t) => (t === 10 ? { cursor: { x: 64, y: 20 }, shoot: 0.6 } : { cursor: { x: 64, y: 20 } }));
    expect(r.retries).toBeLessThan(4);
    expect(s.score[0]).toBe(1);
  });

  test('shoot: walking the ball in does not count', () => {
    const s = training();
    const d = stageDrill(s, 'shoot');
    let retry: string | null = null;
    for (let t = 0; t < 600 && !retry; t++) {
      holdFrozen(s, d);
      step(s, filterInput('shoot', { cursor: { x: 66, y: 20 } }));
      holdFrozen(s, d);
      const r = checkDrill(s, d);
      expect(r.done).toBe(false);
      if (!r.done) retry = r.retry;
    }
    expect(retry).toBe('shoot-it');
  });

  test('tackle: chasing the carrier and tackling wins the ball back', () => {
    const s = training();
    const r = runDrill(s, 'tackle', stageDrill(s, 'tackle'), (st, t) => {
      const c = st.players[CARRIER].pos;
      const close = dist(st.players[HUMAN].pos, c) < 1.5;
      return { cursor: c, pass: close && t % 8 === 0 };
    });
    expect(r.retries).toBeLessThan(5);
  });

  test('tackle: standing still lets the carrier through and the drill resets', () => {
    const s = training();
    const d = stageDrill(s, 'tackle');
    let retry: string | null = null;
    for (let t = 0; t < 2400 && !retry; t++) {
      holdFrozen(s, d);
      step(s, filterInput('tackle', { cursor: { x: 28, y: 3 } }));
      holdFrozen(s, d);
      const r = checkDrill(s, d);
      if (!r.done) retry = r.retry;
      else throw new Error('drill passed without a tackle');
    }
    expect(['conceded', 'saved', 'lost-it']).toContain(retry!);
  });
});

describe('training-ground drills, keyboard and edge cases', () => {
  test('pass: a pass into empty space resets the drill instead of stalling', () => {
    const s = training();
    const d = stageDrill(s, 'pass');
    let retry: string | null = null;
    let done = false;
    for (let t = 0; t < 900 && !retry && !done; t++) {
      holdFrozen(s, d);
      // Keyboard pass at the near board with nobody in the cone, then stand still.
      step(s, filterInput('pass', t === 5 ? { dir: { x: 0, y: -1 }, pass: true } : t < 5 ? { dir: { x: 0, y: -1 } } : { dir: { x: 0, y: 0 } }));
      holdFrozen(s, d);
      const r = checkDrill(s, d);
      if (r.done) done = true;
      else retry = r.retry;
    }
    expect(done || retry === 'no-receiver').toBe(true);
  });

  test('tackle: keyboard-only chase and Space wins the ball back', () => {
    const s = training(23);
    const r = runDrill(s, 'tackle', stageDrill(s, 'tackle'), (st, t) => {
      const h = st.players[HUMAN].pos;
      const c = st.players[CARRIER].pos;
      const aim = { x: c.x - 1.5 - h.x, y: c.y - h.y };
      const dir = { x: Math.abs(aim.x) > 0.4 ? Math.sign(aim.x) : 0, y: Math.abs(aim.y) > 0.4 ? Math.sign(aim.y) : 0 };
      return { dir, pass: dist(h, c) < 1.5 && t % 20 === 0 };
    });
    expect(r.retries).toBeLessThan(5);
  });

  test('tackle: a whiff from distance gives the too-far hint', () => {
    const s = training();
    const d = stageDrill(s, 'tackle');
    holdFrozen(s, d);
    step(s, filterInput('tackle', { cursor: s.players[HUMAN].pos, pass: true }));
    holdFrozen(s, d);
    const r = checkDrill(s, d);
    expect(r.done).toBe(false);
    if (!r.done) expect(r.hint).toBe('too-far');
  });
});
