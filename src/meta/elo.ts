// Club Elo, with the World Football Elo goal-difference multiplier.

export const START_ELO = 1000;

export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export function goalDiffMultiplier(gd: number): number {
  const d = Math.abs(gd);
  if (d <= 1) return 1;
  if (d === 2) return 1.5;
  return (11 + d) / 8;
}

/** K is higher for a club's first 10 matches so new clubs find their level fast. */
export const kFactor = (played: number): number => (played < 10 ? 40 : 24);

/** Rating change for side A. Side B's change is the negation (when K is equal). */
export function eloDelta(ra: number, rb: number, goalsA: number, goalsB: number, playedA: number): number {
  const actual = goalsA > goalsB ? 1 : goalsA === goalsB ? 0.5 : 0;
  const k = kFactor(playedA) * goalDiffMultiplier(goalsA - goalsB);
  return Math.round(k * (actual - expectedScore(ra, rb)));
}
