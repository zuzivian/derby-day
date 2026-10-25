// Shot distance bands, metres from the middle of the goal being attacked. The shot counting
// itself lives in attackProbe.ts (AttackObserver), which scripts/balance.ts and
// scripts/attack-probe.ts use for their shots-by-distance tables.

/** Distance bands, metres from the goal: 0-11, 11-18, 18-30, 30 and beyond. */
export const SHOT_BANDS = [11, 18, 30, Infinity] as const;
export const SHOT_BAND_LABELS = ['0-11 m', '11-18 m', '18-30 m', '30+ m'];
