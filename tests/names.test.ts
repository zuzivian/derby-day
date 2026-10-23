import { describe, expect, test } from 'bun:test';
import {
  asciiFold,
  CLUB_BLOCKLIST,
  clubName,
  clubNickname,
  FAMOUS_BLOCKLIST,
  isBlockedClub,
  isBlockedPlayer,
  nameKey,
  nationOf,
  playerName,
  STYLE_KEYS,
  stadiumName,
} from '../src/meta/names.ts';
import { makeRng } from '../src/sim/rng.ts';

const SAMPLES = 2000;

describe('determinism', () => {
  test('player names are deterministic per seed', () => {
    const a = Array.from({ length: 50 }, (_, i) => playerName(makeRng(i + 1), STYLE_KEYS[i % STYLE_KEYS.length]));
    const b = Array.from({ length: 50 }, (_, i) => playerName(makeRng(i + 1), STYLE_KEYS[i % STYLE_KEYS.length]));
    expect(a).toEqual(b);
  });

  test('club, stadium and nickname are deterministic per seed', () => {
    expect(clubName(makeRng(5))).toEqual(clubName(makeRng(5)));
    expect(stadiumName(makeRng(5))).toBe(stadiumName(makeRng(5)));
    expect(clubNickname(makeRng(5))).toBe(clubNickname(makeRng(5)));
  });
});

describe('blocklists', () => {
  test('2,000 generated player names contain no famous names', () => {
    const r = makeRng(42);
    for (let i = 0; i < SAMPLES; i++) {
      const { first, last } = playerName(r, STYLE_KEYS[i % STYLE_KEYS.length]);
      expect(FAMOUS_BLOCKLIST.has(nameKey(`${first} ${last}`))).toBe(false);
      expect(isBlockedPlayer(first, last)).toBe(false);
    }
  });

  test('2,000 generated club names contain no famous clubs', () => {
    const r = makeRng(43);
    for (let i = 0; i < SAMPLES; i++) {
      const { name } = clubName(r);
      expect(CLUB_BLOCKLIST.has(nameKey(name))).toBe(false);
      expect(isBlockedClub(name)).toBe(false);
    }
  });

  test('known famous names are caught', () => {
    expect(isBlockedPlayer('Lionel', 'Messi')).toBe(true);
    expect(isBlockedPlayer('Luka', 'Modrić')).toBe(true);
    expect(isBlockedPlayer('Edson', 'Pelé')).toBe(true);
    expect(isBlockedClub('Arsenal')).toBe(true);
    expect(isBlockedClub('Inter Milan')).toBe(true);
    expect(isBlockedClub('Port Vale')).toBe(true);
    expect(isBlockedClub('Brennholm Rovers')).toBe(false);
  });
});

describe('short codes', () => {
  test('always exactly three ASCII capitals', () => {
    const r = makeRng(44);
    for (let i = 0; i < SAMPLES; i++) {
      expect(clubName(r).short).toMatch(/^[A-Z]{3}$/);
    }
  });

  test('diacritics fold to ASCII', () => {
    expect(asciiFold('Åsness')).toBe('Asness');
    expect(asciiFold('Örnholm')).toBe('Ornholm');
    expect(asciiFold('Søndergård')).toBe('Sondergard');
  });
});

describe('styles', () => {
  test('ten styles, each with a nation label', () => {
    expect(STYLE_KEYS.length).toBe(10);
    for (const style of STYLE_KEYS) expect(nationOf(style).length).toBeGreaterThan(0);
  });

  test('every style produces non-empty first and last names', () => {
    const r = makeRng(45);
    for (const style of STYLE_KEYS) {
      for (let i = 0; i < 50; i++) {
        const { first, last } = playerName(r, style);
        expect(first.length).toBeGreaterThan(0);
        expect(last.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('stadium and nickname', () => {
  test('are non-empty', () => {
    const r = makeRng(46);
    for (let i = 0; i < 500; i++) {
      expect(stadiumName(r).length).toBeGreaterThan(0);
      expect(clubNickname(r).length).toBeGreaterThan(0);
    }
  });

  test('nickname uses "The <noun>" form', () => {
    const r = makeRng(47);
    for (let i = 0; i < 100; i++) expect(clubNickname(r)).toMatch(/^The \S+/);
  });
});
