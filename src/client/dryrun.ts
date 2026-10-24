// Before an imported club replaces the real one, run it through the same steps the game takes at boot and
// draw every screen's markup once. A club that gets through backup.ts's field checks but still throws here
// would crash the game on every launch, so it never gets committed.

import type { Save } from '../meta/game.ts';
import { clubTeam, ensureElevenASide, lineupReady, pickOpponent } from '../meta/game.ts';
import { ensureLevelFields } from '../meta/levels.ts';
import { ensureProgressionFields } from '../meta/progression.ts';
import { competitionsScreen } from './competitions.ts';
import { homeScreen } from './home.ts';
import { clubScreen, ladderScreen, shell, squadScreen, trainingScreen, transfersScreen, type App, type Screen } from './ui.ts';
import { loadPrefs } from './store.ts';

/** null when the save boots and draws; otherwise what went wrong. Never mutates the save it is given. */
export function dryRunBoot(input: Save): string | null {
  try {
    const save = structuredClone(input);
    ensureProgressionFields(save);
    ensureElevenASide(save);
    ensureLevelFields(save);
    const app: App = { save, screen: 'home', nextOpp: pickOpponent(save), trainee: null, marketRole: 'ALL', confirmSell: null, confirmReset: false, prefs: loadPrefs(), result: null };
    if (lineupReady(save)) clubTeam(save, 0.6);
    const screens: Record<Screen, (a: App) => string> = {
      home: homeScreen,
      club: clubScreen,
      squad: squadScreen,
      transfers: transfersScreen,
      training: trainingScreen,
      ladder: ladderScreen,
      competitions: competitionsScreen,
    };
    for (const [name, draw] of Object.entries(screens)) {
      app.screen = name as Screen;
      shell(app, draw(app));
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
