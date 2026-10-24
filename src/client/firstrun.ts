// What the end of the very first match changes, as one pure step so it can be tested without a DOM. The caller
// writes the save and the prefs right after it and BEFORE the celebration renders: by the time the celebration is
// on screen the match is recorded, the XP and milestone are in, the unlocks it opens are marked seen (the
// celebration names them), the setup is over (onboarded) and the tab marks start from the tabs now open. A reload
// on the celebration screen therefore lands on Home, not on the welcome or a level-up dialog.

import { applyResult, type ResultSummary, type Save } from '../meta/game.ts';
import { award, claimMilestone, markUnlocksSeen, pendingUnlocks } from '../meta/levels.ts';
import { openTabs } from './coach.ts';
import type { Prefs } from './store.ts';

export interface FirstMatchResult {
  gf: number;
  ga: number;
  scorers: string[];
  opponent: { name: string; short: string };
}

export interface FirstMatchOutcome {
  summary: ResultSummary;
  /** Names of what the new level opens, said once on the celebration. */
  opened: string[];
}

export function completeFirstMatch(save: Save, prefs: Prefs, r: FirstMatchResult): FirstMatchOutcome {
  const summary = applyResult(save, null, r.opponent, r.gf, r.ga, false, r.scorers, undefined, false, 'easy');
  award(save, [claimMilestone(save, 'first-match')], summary.xp);
  const opened = pendingUnlocks(save).map((u) => u.name);
  markUnlocksSeen(save);
  prefs.onboarded = true;
  prefs.coachSeen ??= [];
  prefs.marks = openTabs(save);
  return { summary, opened };
}
