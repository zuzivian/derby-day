// The warm-up friendly: until the club reaches level 3 (ranked matches), the hero Kick off on Home plays a
// gentle, generated CPU club instead of a ladder club near the player's Elo. The opponent is seeded from the
// save, so it is stable until a match is played and a reload shows the same club. The very first match uses the
// same maker with a slightly gentler CPU. Pure: no DOM, nothing here touches the sim's randomness.

import { autoLineup, generateIdentity, generateSquad, toTeamSetup, type ClubIdentity } from './club.ts';
import type { Save } from './game.ts';
import { isUnlocked } from './levels.ts';
import { makeRng } from '../sim/rng.ts';
import type { TeamSetup } from '../sim/types.ts';

export const WARMUP = { quality: 50, aiSkill: 0.25 } as const;
export const FIRST_MATCH = { quality: 46, aiSkill: 0.15 } as const;

/** Ranked matches arrive with the 'ranked' unlock; before it Kick off is a warm-up friendly. */
export const rankedOpen = (save: Save): boolean => isUnlocked(save, 'ranked');

/** The Elo win-chance gauge is a distraction for a new player: it stays hidden for the first three ranked matches. */
export const RANKED_GAUGE_AFTER = 3;
export const showGauge = (save: Save): boolean => save.history.filter((m) => m.ranked).length >= RANKED_GAUGE_AFTER;

const seedOf = (save: Save, first: boolean) => (save.seed ^ (first ? 0x1f5a : 0x77a3 + save.history.length * 0x9e37)) | 0;

/** Name, colours and crest of the next warm-up (or first-match) opponent. Cheap: no squad is built. */
export function warmupIdentity(save: Save, first = false): ClubIdentity {
  return generateIdentity(makeRng(seedOf(save, first)));
}

/** The full opponent: the same club as warmupIdentity, with a squad and lineup. */
export function warmupTeam(save: Save, first = false): { id: ClubIdentity; away: TeamSetup } {
  const r = makeRng(seedOf(save, first));
  const id = generateIdentity(r);
  const tune = first ? FIRST_MATCH : WARMUP;
  const squad = generateSquad(r, tune.quality);
  return { id, away: toTeamSetup(id, squad, autoLineup(squad), tune.aiSkill) };
}
