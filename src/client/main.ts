import { autoLineup, generateSquad, ladderSquad, toTeamSetup, type LadderClub } from '../meta/club.ts';
import { applyResult, buyPlayer, newGame, pickOpponent, rerollIdentity, sellPlayer, setLineupSlot, train, type Save } from '../meta/game.ts';
import type { AttrKey } from '../meta/player.ts';
import { possessionShare } from '../sim/match.ts';
import { int, makeRng } from '../sim/rng.ts';
import type { MatchState, TeamSetup } from '../sim/types.ts';
import type { Role } from '../sim/constants.ts';
import type { CrestPattern } from '../meta/names.ts';
import { competitionAction, competitionsScreen } from './competitions.ts';
import { announce, captureFocus, focusKeyOf, hideToast, initLiveRegions, restoreFocus, showToast, tabFromKey, trapTab, type FocusKey } from './a11y.ts';
import { award, claimMilestone, ensureLevelFields, isUnlocked, markUnlocksSeen, pendingUnlocks, replaySlots, xpSummary, type PracticeLevel, type UnlockId } from '../meta/levels.ts';
import { setCrest, setKit } from '../meta/identity.ts';
import { levelUpAnnouncement, levelUpOpen } from './levels.ts';
import { setReplaySlots } from './replayStore.ts';
import { mountMatch } from './matchView.ts';
import { mountShootout, type ShootoutResult, type ShootoutViewOptions } from './shootout.ts';
import { ensureProgressionFields, maybeRollover } from '../meta/progression.ts';
import { reviewAction, reviewOpen } from './review.ts';
import { initReplayUi } from './replayView.ts';
import { mountOnboarding } from './onboarding.ts';
import { clearSave, loadPrefs, loadSave, writePrefs, writeSave } from './store.ts';
import { mountTutorial } from './tutorial.ts';
import { mountLink, mountLocal2P, type VersusOptions } from './versus.ts';
import { clubScreen, ladderScreen, PRACTICE, practiceUnlocked, screenUnlocked, shell, squadScreen, trainingScreen, transfersScreen, type App, type Screen } from './ui.ts';

const root = document.getElementById('app')!;

function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) | 0;
}

function boot(save: Save): App {
  ensureProgressionFields(save);
  ensureLevelFields(save); // older saves get retro XP and keep what they already use
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
initReplayUi(root);
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
/** Where focus goes back to when the level-up dialog closes. */
let levelOrigin: FocusKey | null = null;
/** When the last signing happened, to swallow the second click of a double-click. */
let lastBuyAt = -Infinity;

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
    competitions: competitionsScreen,
  };
  // A tab can only be open once it is unlocked (club level).
  if (!screenUnlocked(app.save, app.screen)) app.screen = 'club';
  setReplaySlots(replaySlots(app.save));
  const hadResult = !!root.querySelector('#result-title');
  const hadReview = !!root.querySelector('#review-title');
  const hadLevelUp = !!root.querySelector('#levelup-title');
  const key = pendingFocus ?? captureFocus(root);
  pendingFocus = null;
  root.innerHTML = shell(app, screens[app.screen](app));
  const levelUp = !app.result && levelUpOpen(app.save);
  if (app.result && !hadResult) root.querySelector<HTMLElement>('#result-title')?.focus();
  else if (levelUp && !hadLevelUp) {
    levelOrigin = key;
    root.querySelector<HTMLElement>('#levelup-title')?.focus();
    announce(levelUpAnnouncement(app.save));
  } else if (!app.result && !levelUp && reviewOpen(app.save) && !hadReview) root.querySelector<HTMLElement>('#review-title')?.focus();
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
      if (!root.querySelector('.modal')) focusMain();
    },
  });
}

/** First completion of the training ground (setup or Replay tutorial) earns its milestone XP. */
function tutorialXp(): string {
  const gain = award(app.save, [claimMilestone(app.save, 'tutorial')]);
  if (!gain.total) return '';
  persist();
  return xpSummary(gain);
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
      const xp = completed ? tutorialXp() : '';
      render();
      if (completed) toast(xp ? `Training done. ${xp}.` : 'Training done.');
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

/**
 * Mount a live match against `opponent` and hand back the final state. Shared
 * by ranked, practice and competition matches. Returns false (with a toast)
 * when the lineup isn't complete.
 */
function playLive(
  opponent: TeamSetup,
  crest: CrestPattern,
  label: string,
  onDone: (m: MatchState, forfeited: boolean, away: TeamSetup) => void,
  forfeitText?: string,
): boolean {
  const s = app.save;
  if (s.lineup.filter(Boolean).length < 6) {
    toast('Pick six players first.', false);
    return false;
  }
  const home = toTeamSetup(s.club, s.squad, s.lineup, 0.6);
  const away = avoidClash(home, opponent);
  const seed = int(s.rng, 1, 2 ** 31 - 1);
  matchOrigin = captureFocus(root) ?? keyFor({ action: 'play-ranked' });
  takeover = true;
  hideToast();
  const unmount = mountMatch(root, {
    seed,
    home,
    away,
    halfSeconds: app.prefs.halfSeconds,
    humanTeam: 0,
    crests: [s.club.crest, crest],
    label,
    forfeitText,
    controls: app.prefs.controls,
    onEnd: (m, forfeited) => {
      unmount();
      takeover = false;
      onDone(m, forfeited, away);
    },
  });
  return true;
}

/** Mount the live penalty shootout for a drawn cup tie and hand back its result. */
function playShootout(opts: Omit<ShootoutViewOptions, 'onEnd'>, onDone: (r: ShootoutResult) => void) {
  takeover = true;
  hideToast();
  const unmount = mountShootout(root, {
    ...opts,
    onEnd: (r) => {
      unmount();
      takeover = false;
      onDone(r);
    },
  });
}

function startMatch(ranked: boolean, opp: LadderClub | null, practiceLevel?: (typeof PRACTICE)[number]) {
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
  const practice = (practiceLevel?.id ?? 'normal') as PracticeLevel;
  playLive(away, crest, ranked ? 'Ranked' : 'Friendly', (m, forfeited, shown) => endMatch(m, forfeited, ranked, opp, shown, crest, practice));
}

/** Local 2P or Link two tabs (versus.ts): two humans, nothing recorded. */
function startVersus(mount: (root: HTMLElement, o: VersusOptions) => () => void) {
  matchOrigin = captureFocus(root);
  takeover = true;
  hideToast();
  window.scrollTo({ top: 0 });
  const stop = mount(root, {
    save: app.save,
    prefs: app.prefs,
    avoidClash,
    onDone: (result) => {
      stop();
      takeover = false;
      app.result = result;
      app.screen = 'club';
      if (!result) pendingFocus = matchOrigin;
      render();
    },
  });
}

function endMatch(m: MatchState, forfeited: boolean, ranked: boolean, opp: LadderClub | null, away: TeamSetup, crest: LadderClub['crest'], practice: PracticeLevel = 'normal') {
  const s = app.save;
  let [gf, ga] = m.score;
  if (forfeited && ranked) [gf, ga] = [0, Math.max(3, ga)];
  // A forfeit is recorded as 0–3, so the goals actually scored before it don't stand.
  const scorersFor = forfeited ? [] : m.events.filter((e) => e.team === 0).map((e) => `${e.scorer} ${e.minute}'`);
  const scorersAgainst = forfeited ? [] : m.events.filter((e) => e.team === 1).map((e) => `${e.scorer} ${e.minute}'`);
  const eloBefore = s.club.elo;
  const skipRecord = forfeited && !ranked;
  const summary = skipRecord ? null : applyResult(s, ranked ? opp : null, { name: away.name, short: away.short }, gf, ga, ranked, scorersFor, undefined, forfeited, practice);
  maybeRollover(s); // a new season starts after the 10th ranked or competition match; the review shows once the result is closed
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
  if (action?.startsWith('review-')) {
    reviewAction(action, el, { app, toast, persist });
    if (action === 'review-close') pendingFocus = matchOrigin ?? keyFor({ action: 'play-ranked' });
    render();
    return;
  }
  if (action?.startsWith('comp-')) {
    if (competitionAction(action, el, { app, toast, persist, render, playLive, playShootout })) render();
    return;
  }

  switch (action) {
    case 'skip-to-main':
      e.preventDefault();
      focusMain();
      return;
    case 'nav':
      if (!screenUnlocked(s, el.dataset.screen as Screen)) return;
      app.screen = el.dataset.screen as Screen;
      pendingFocus = focusKeyOf(el, root);
      break;
    case 'level-open':
      app.screen = 'club';
      pendingFocus = { elId: 'level-title', data: {}, index: 0 };
      break;
    case 'levelup-go':
    case 'levelup-close': {
      const target = action === 'levelup-go' ? pendingUnlocks(s).find((u) => u.id === (id as UnlockId))?.go : undefined;
      markUnlocksSeen(s);
      persist();
      if (target) {
        app.screen = target.screen as Screen;
        pendingFocus = { elId: target.focusId ?? `tab-${target.screen}`, data: {}, index: 0 };
      } else pendingFocus = levelOrigin ?? matchOrigin ?? keyFor({ action: 'play-ranked' });
      break;
    }
    case 'replay-tutorial':
      startTraining();
      return;
    case 'play-ranked':
      startMatch(true, app.nextOpp);
      return;
    case 'play-practice': {
      const level = PRACTICE.find((p) => p.id === el.dataset.level);
      if (level && practiceUnlocked(s, level.id)) startMatch(false, null, level);
      return;
    }
    case 'play-local2p':
      if (isUnlocked(s, 'local2p')) startVersus(mountLocal2P);
      return;
    case 'play-link':
      if (isUnlocked(s, 'link')) startVersus(mountLink);
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
      // The table re-renders after a signing, so a double-click would land on the
      // next row's Sign button and buy a second player by accident.
      if (performance.now() - lastBuyAt < 500) return;
      lastBuyAt = performance.now();
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
  } else if (el.dataset.change === 'crest') {
    if (setCrest(app.save, el.value as CrestPattern)) persist();
    render();
  } else if (el.dataset.change === 'kit-primary' || el.dataset.change === 'kit-secondary') {
    const c = app.save.club;
    const [primary, secondary] = el.dataset.change === 'kit-primary' ? [el.value, c.secondary] : [c.primary, el.value];
    if (setKit(app.save, primary, secondary)) persist();
    else toast('Pick two different colours.', false);
    render();
  }
});

// Keyboard: arrow keys between tabs; Esc closes and Tab stays inside the result, level-up or season review dialog.
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
  const levelUp = !app.result && levelUpOpen(app.save);
  const review = !app.result && !levelUp && reviewOpen(app.save);
  if (takeover || (!app.result && !levelUp && !review)) return;
  const modal = root.querySelector<HTMLElement>('.modal');
  if (!modal) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (app.result) {
      app.result = null;
      pendingFocus = matchOrigin ?? keyFor({ action: 'play-ranked' });
    } else if (levelUp) {
      markUnlocksSeen(app.save);
      persist();
      pendingFocus = levelOrigin ?? matchOrigin ?? keyFor({ action: 'play-ranked' });
    } else {
      app.save.review!.seen = true;
      persist();
      pendingFocus = matchOrigin ?? keyFor({ action: 'play-ranked' });
    }
    render();
  } else trapTab(modal, e);
});

if (app.prefs.onboarded === false) startOnboarding();
else render();
if (!saved) toast('This browser blocked storage, so progress will be lost when you close the tab.', false);
