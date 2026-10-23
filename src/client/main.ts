import { autoLineup, generateSquad, ladderSquad, toTeamSetup, type LadderClub } from '../meta/club.ts';
import { applyResult, buyPlayer, newGame, pickOpponent, rerollIdentity, sellPlayer, setLineupSlot, train, type Save } from '../meta/game.ts';
import type { AttrKey } from '../meta/player.ts';
import { possessionShare } from '../sim/match.ts';
import { int, makeRng } from '../sim/rng.ts';
import type { MatchState, TeamSetup } from '../sim/types.ts';
import type { Role } from '../sim/constants.ts';
import { captureFocus, focusKeyOf, hideToast, initLiveRegions, restoreFocus, showToast, tabFromKey, trapTab, type FocusKey } from './a11y.ts';
import { mountMatch } from './matchView.ts';
import { mountOnboarding } from './onboarding.ts';
import { clearSave, loadPrefs, loadSave, writePrefs, writeSave } from './store.ts';
import { mountTutorial } from './tutorial.ts';
import { clubScreen, ladderScreen, PRACTICE, shell, squadScreen, trainingScreen, transfersScreen, type App, type Screen } from './ui.ts';

const root = document.getElementById('app')!;

function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) | 0;
}

function boot(save: Save): App {
  return {
    save,
    screen: 'club',
    nextOpp: pickOpponent(save),
    trainee: null,
    marketRole: 'ALL',
    confirmSell: null,
    confirmReset: false,
    prefs: loadPrefs(),
    result: null,
  };
}

initLiveRegions();
const existing = loadSave();
let app = boot(existing ?? newGame(freshSeed()));
// First run (no save) gets setup; an older save that predates setup skips it.
if (!existing) app.prefs.onboarded = false;
else if (app.prefs.onboarded === undefined) app.prefs.onboarded = true;
writePrefs(app.prefs);
let saved = writeSave(app.save);
/** True while a match, setup or the training ground owns #app. */
let takeover = false;
/** Where focus goes after the next render, when it isn't simply "where it was". */
let pendingFocus: FocusKey | null = null;
/** The control that started the last match, to return focus to after the result dialog. */
let matchOrigin: FocusKey | null = null;

const keyFor = (data: FocusKey['data']): FocusKey => ({ elId: '', data, index: 0 });

function toast(text: string, ok = true) {
  showToast(text, ok);
}

function persist() {
  saved = writeSave(app.save);
  if (!saved) toast('This browser blocked storage, so progress will be lost when you close the tab.', false);
}

function render() {
  if (takeover) return;
  const screens: Record<Screen, (a: App) => string> = {
    club: clubScreen,
    squad: squadScreen,
    transfers: transfersScreen,
    training: trainingScreen,
    ladder: ladderScreen,
  };
  const hadModal = !!root.querySelector('.modal');
  const key = pendingFocus ?? captureFocus(root);
  pendingFocus = null;
  root.innerHTML = shell(app, screens[app.screen](app));
  if (app.result && !hadModal) root.querySelector<HTMLElement>('#result-title')?.focus();
  else restoreFocus(root, key, '#main');
}

function focusMain() {
  root.querySelector<HTMLElement>('#main')?.focus();
}

function startOnboarding() {
  takeover = true;
  hideToast();
  const stop = mountOnboarding(root, {
    save: app.save,
    prefs: app.prefs,
    nextOpp: app.nextOpp,
    persist,
    savePrefs: () => writePrefs(app.prefs),
    onDone: () => {
      stop();
      takeover = false;
      app.prefs.onboarded = true;
      writePrefs(app.prefs);
      app.screen = 'club';
      render();
      focusMain();
    },
  });
}

function startTraining() {
  const s = app.save;
  if (s.lineup.filter(Boolean).length < 6) {
    toast('Pick six players first.', false);
    return;
  }
  takeover = true;
  hideToast();
  window.scrollTo({ top: 0 });
  const stop = mountTutorial(root, {
    home: toTeamSetup(s.club, s.squad, s.lineup, 0.6),
    controls: app.prefs.controls,
    headingLevel: 1,
    onDone: (completed) => {
      stop();
      takeover = false;
      pendingFocus = keyFor({ action: 'replay-tutorial' });
      render();
      if (completed) toast('Training done.');
    },
  });
}

// ---------------------------------------------------------------------------
// Matches

/** Away side switches to its second kit if the colours are too close to ours. */
function avoidClash(home: TeamSetup, away: TeamSetup): TeamSetup {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const near = (a: string, b: string) => {
    const [x, y] = [rgb(a), rgb(b)];
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 120;
  };
  if (!near(home.primary, away.primary)) return away;
  const swapped = { ...away, primary: away.secondary, secondary: away.primary };
  if (!near(home.primary, swapped.primary)) return swapped;
  return { ...away, primary: near(home.primary, '#f5f5f5') ? '#1c1c1c' : '#f5f5f5', secondary: near(home.primary, '#f5f5f5') ? '#f5f5f5' : '#1c1c1c' };
}

function startMatch(ranked: boolean, opp: LadderClub | null, practiceLevel?: (typeof PRACTICE)[number]) {
  const s = app.save;
  if (s.lineup.filter(Boolean).length < 6) {
    toast('Pick six players first.', false);
    return;
  }
  const home = toTeamSetup(s.club, s.squad, s.lineup, 0.6);
  let away: TeamSetup;
  let crest = opp?.crest ?? 'plain';
  if (opp) {
    const squad = ladderSquad(opp);
    away = toTeamSetup(opp, squad, autoLineup(squad));
  } else {
    const lvl = practiceLevel!;
    const squad = generateSquad(makeRng(lvl.quality * 7919), lvl.quality);
    const id = { id: lvl.id, name: lvl.name, short: lvl.short, primary: lvl.primary, secondary: lvl.secondary, crest: 'hoops' as const };
    crest = 'hoops';
    away = toTeamSetup(id, squad, autoLineup(squad), lvl.aiSkill);
  }
  away = avoidClash(home, away);
  const seed = int(s.rng, 1, 2 ** 31 - 1);
  matchOrigin = captureFocus(root) ?? keyFor(ranked || !practiceLevel ? { action: 'play-ranked' } : { action: 'play-practice', level: practiceLevel.id });
  takeover = true;
  hideToast();

  const unmount = mountMatch(root, {
    seed,
    home,
    away,
    halfSeconds: app.prefs.halfSeconds,
    humanTeam: 0,
    crests: [s.club.crest, crest],
    label: ranked ? 'Ranked' : 'Friendly',
    controls: app.prefs.controls,
    onEnd: (m, forfeited) => {
      unmount();
      takeover = false;
      endMatch(m, forfeited, ranked, opp, away, crest);
    },
  });
}

function endMatch(m: MatchState, forfeited: boolean, ranked: boolean, opp: LadderClub | null, away: TeamSetup, crest: LadderClub['crest']) {
  const s = app.save;
  let [gf, ga] = m.score;
  if (forfeited && ranked) [gf, ga] = [0, Math.max(3, ga)];
  const scorersFor = m.events.filter((e) => e.team === 0).map((e) => `${e.scorer} ${e.minute}'`);
  const scorersAgainst = m.events.filter((e) => e.team === 1).map((e) => `${e.scorer} ${e.minute}'`);
  const eloBefore = s.club.elo;
  const skipRecord = forfeited && !ranked;
  const summary = skipRecord ? null : applyResult(s, ranked ? opp : null, { name: away.name, short: away.short }, gf, ga, ranked, scorersFor);
  app.result = {
    ranked,
    forfeited,
    gf,
    ga,
    opp: { name: away.name, short: away.short, primary: away.primary, secondary: away.secondary, crest },
    summary,
    eloBefore,
    eloAfter: s.club.elo,
    stats: m.stats,
    possession: possessionShare(m),
    scorersFor,
    scorersAgainst,
  };
  if (ranked) app.nextOpp = pickOpponent(s);
  persist();
  app.screen = 'club';
  render();
}

// ---------------------------------------------------------------------------
// Events

root.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el || takeover) return;
  const s = app.save;
  const id = el.dataset.id ?? '';
  const action = el.dataset.action;
  if (action !== 'sell-confirm' && action !== 'sell') app.confirmSell = null;
  if (action !== 'reset-confirm' && action !== 'reset') app.confirmReset = false;

  switch (action) {
    case 'skip-to-main':
      e.preventDefault();
      focusMain();
      return;
    case 'nav':
      app.screen = el.dataset.screen as Screen;
      pendingFocus = focusKeyOf(el, root);
      break;
    case 'replay-tutorial':
      startTraining();
      return;
    case 'play-ranked':
      startMatch(true, app.nextOpp);
      return;
    case 'play-practice':
      startMatch(false, null, PRACTICE.find((p) => p.id === el.dataset.level));
      return;
    case 'auto-lineup':
      s.lineup = autoLineup(s.squad);
      toast('Best six picked.');
      persist();
      break;
    case 'market-role':
      app.marketRole = el.dataset.role as Role | 'ALL';
      break;
    case 'buy': {
      const r = buyPlayer(s, id);
      toast(r.message, r.ok);
      if (r.ok) persist();
      break;
    }
    case 'sell':
      app.confirmSell = id;
      break;
    case 'sell-confirm': {
      const r = sellPlayer(s, id);
      app.confirmSell = null;
      toast(r.message, r.ok);
      if (r.ok) persist();
      break;
    }
    case 'trainee':
      app.trainee = id;
      break;
    case 'train': {
      const r = train(s, id, el.dataset.attr as AttrKey);
      toast(r.message, r.ok);
      if (r.ok) persist();
      break;
    }
    case 'reroll':
      rerollIdentity(s);
      persist();
      break;
    case 'reset':
      app.confirmReset = true;
      break;
    case 'reset-confirm':
      clearSave();
      app = boot(newGame(freshSeed()));
      app.prefs.onboarded = true;
      persist();
      pendingFocus = keyFor({ action: 'reset' });
      toast(`${app.save.club.name} founded.`);
      break;
    case 'reset-cancel':
      break;
    case 'close-result':
      app.result = null;
      pendingFocus = matchOrigin ?? keyFor({ action: 'play-ranked' });
      break;
    default:
      return;
  }
  render();
});

root.addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement;
  if (el.dataset.change === 'slot') {
    setLineupSlot(app.save, Number(el.dataset.slot), el.value);
    persist();
    render();
  } else if (el.dataset.change === 'half') {
    app.prefs.halfSeconds = Number(el.value);
    writePrefs(app.prefs);
  }
});

// Keyboard: arrow keys between tabs; Esc closes and Tab stays inside the result dialog.
root.addEventListener('keydown', (e) => {
  if (takeover) return;
  const t = e.target as HTMLElement;
  if (t.getAttribute('role') === 'tab') {
    const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
    const to = tabFromKey(e, tabs);
    if (to && to !== t) {
      app.screen = to.dataset.screen as Screen;
      app.confirmSell = null;
      app.confirmReset = false;
      pendingFocus = focusKeyOf(to, root);
      render();
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (takeover || !app.result) return;
  const modal = root.querySelector<HTMLElement>('.modal');
  if (!modal) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    app.result = null;
    pendingFocus = matchOrigin ?? keyFor({ action: 'play-ranked' });
    render();
  } else trapTab(modal, e);
});

if (app.prefs.onboarded === false) startOnboarding();
else render();
if (!saved) toast('This browser blocked storage, so progress will be lost when you close the tab.', false);
