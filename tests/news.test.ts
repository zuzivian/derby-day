import { describe, expect, test } from 'bun:test';
import { applyResult, newGame as freshGame } from '../src/meta/game.ts';

const newGame = () => freshGame(7);
const play = (s: ReturnType<typeof newGame>, gf: number, ga: number, ranked: boolean, scorers: string[] = [], competition?: string) =>
  (applyResult(s, ranked ? s.ladder[0] : null, ranked ? s.ladder[0] : { name: 'Reserve XI', short: 'RES' }, gf, ga, ranked, scorers, competition), s.news.at(-1)!);

describe('club news lines', () => {
  test('name the opponent, score, scorers and Elo', () => {
    const s = newGame();
    const line = play(s, 2, 1, true, ["Ana Reyes 12'", "Ben Cole 80'"]);
    expect(line).toContain(s.ladder[0].name);
    expect(line).toContain('2–1');
    expect(line).toContain("Ana Reyes 12', Ben Cole 80'");
    expect(line).toMatch(/Elo [+−]\d+/);
    expect(line).toContain('First ranked win!');
  });
  test('vary with the result and say what the match was', () => {
    const s = newGame();
    expect(play(s, 5, 0, false)).toMatch(/^Thrashed Reserve XI 5–0 in a friendly\./);
    expect(play(s, 2, 2, false)).toMatch(/^Drew with Reserve XI 2–2 in a friendly\./);
    expect(play(s, 1, 1, false, [], 'Cup semi-final')).toMatch(/^Drew with Reserve XI 1–1 in the Cup semi-final\./);
    expect(play(s, 1, 1, false, [], 'League matchday 2')).toMatch(/^Shared the points with Reserve XI, 1–1 in League matchday 2\./);
    expect(play(s, 0, 1, false, [], 'Cup final')).toMatch(/^Beaten by Reserve XI, 0–1 in the Cup final\./);
    expect(play(s, 0, 4, false, [], 'League matchday 3')).toMatch(/^Lost to Reserve XI 0–4 in League matchday 3\./);
    expect(play(s, 0, 0, false, [], 'Warm-up friendly')).toMatch(/^Goalless against Reserve XI in a warm-up friendly\./);
  });
  test('cap the scorers', () => {
    const line = play(newGame(), 3, 0, false, ["A 1'", "B 2'", "C 3'", "D 4'"]);
    expect(line).toContain("A 1', B 2', C 3' and 1 more.");
  });
});
