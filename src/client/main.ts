import { autoLineup, generateSquad, toTeamSetup, type ClubIdentity, type LadderClub } from '../meta/club.ts';
import { ensureSkill, learnSkill, opponentSetup } from '../meta/skill.ts';
import { warmupTeam } from '../meta/warmup.ts';
import { afterRender, beforeRender, queueReveal } from './screenFx.ts';
import { completeFirstMatch } from './firstrun.ts';
import { applyResult, buyPlayer, clubTeam, ensureElevenASide, lineupReady, newGame, offeredOpponent, refreshMarketIfStale, rerollIdentity, sellPlayer, setFormation, setLineupSlot, setMentality, train, type Save } from '../meta/game.ts';
import type { FormationId, Mentality } from '../sim/constants.ts';
import type { AttrKey } from '../meta/player.ts';
import { possessionShare } from '../sim/match.ts';
import { scoreAwarded } from '../sim/rules.ts';
import { int, makeRng } from '../sim/rng.ts';
import type { MatchState, TeamSetup } from '../sim/types.ts';
import type { Role } from '../sim/constants.ts';
import type { CrestPattern } from '../meta/names.ts';
import { competitionAction, competitionsScreen } from './competitions.ts';
import { announce, captureFocus, focusKeyOf, hideToast, initLiveRegions, restoreFocus, showToast, tabFromKey, trapTab, type FocusKey } from './a11y.ts';
import { award, claimMilestone, ensureLevelFields, isUnlocked, markUnlocksSeen, unlockLevel, pendingUnlocks, replaySlots, xpSummary, type PracticeLevel, type UnlockId } from '../meta/levels.ts';
import { setClubName, setCrest, setKit, validateClubName } from '../meta/identity.ts';
import { levelUpAnnouncement, levelUpOpen } from './levels.ts';
import { setReplaySlots } from './replayStore.ts';
import { avoidClash } from './kits.ts';
import { mountMatch } from './matchView.ts';
import { mountShootout, type ShootoutResult, type ShootoutViewOptions } from './shootout.ts';
import { ensureProgressionFields, maybeRollover } from '../meta/progression.ts';
import { ensureWorldFields } from '../meta/world.ts';
import { ensureHistoryFields } from '../meta/history.ts';
import { beginMatch, markCrashed, settleAbandoned, type PendingMatch } from '../meta/pending.ts';
import { isBenign } from './errors.ts';
import { reviewAction, reviewOpen } from './review.ts';
import { initReplayUi } from './replayView.ts';
import { mountAfterMatch, mountWelcome } from './onboarding.ts';
import { acknowledge, markHtml, openTabs, pendingMark, placeMark } from './coach.ts';
import { clearSave, loadPrefs, loadSaveChecked, setSaveGuest, writePrefs, writeSaveResult } from './store.ts';
import { openSettings } from './settings.ts';
import { telemetry } from './telemetry.ts';
import { clubLevel } from '../meta/levels.ts';
import { mountTutorial } from './tutorial.ts';
import { mountLink, mountLocal2P, mountOnline, type VersusOptions } from './versus.ts';
import { inviteCode, relayConfig } from '../net/config.ts';
import { homeScreen } from './home.ts';
import { clubScreen, ladderScreen, PRACTICE, practiceUnlocked, screenUnlocked, shell, squadScreen, trainingScreen, transfersScreen, type App, type Screen } from './ui.ts';

const root = document.getElementById('app')!;

function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) | 0;
}

/** The match the last visit left unfinished, settled as a forfeit at boot: told once the page is up. */
let abandoned: string | null = null;

function boot(save: Save): App {
  ensureProgressionFields(save);
  ensureElevenASide(save); // six-a-side saves get a squad of 18 and an eleven-man lineup
  ensureSkill(save); // saves from before the hidden skill estimate get one from their ranked record
  ensureLevelFields(save); // older saves get retro XP and keep what they already use
  ensureWorldFields(save); // older saves join the four-division world
  ensureHistoryFields(save); // lifetime records, and the match history capped
  abandoned = settleAbandoned(save)?.message ?? null; // a reload or a closed tab mid-match counts as a forfeit
  refreshMarketIfStale(save, Date.now());
  return {
    save,
    screen: 'home',
    nextOpp: offeredOpponent(save), // fixed on the save, so reloading can't re-roll it
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
const loaded = loadSaveChecked();
const existing = loaded.save;
// A save from a newer build is never touched: this tab runs read-only until the page is reloaded onto the new build.
if (loaded.newer) setSaveGuest(true);
let app = boot(existing ?? newGame(freshSeed()));
// First run (no save) gets setup; an older save that predates setup skips it.
if (!existing && !loaded.newer) app.prefs.onboarded = false;
else if (app.prefs.onboarded === undefined) app.prefs.onboarded = true;
// A first match already recorded means setup is over, whatever the flag says (a reload on the celebration screen).
if (existing && app.prefs.onboarded === false && app.save.history.length > 0) app.prefs.onboarded = true;
writePrefs(app.prefs);
let saved = writeSaveResult(app.save) !== 'blocked';
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

// A crash mid-match (errors.ts draws its panel) marks the match, so the reload that follows voids it instead of
// counting it as a forfeit (pending.ts, at most once in VOID_EVERY matches).
const crashedMidMatch = (reason: unknown) => {
  try {
    if (!app?.save.pending || isBenign({ message: String((reason as Error)?.message ?? reason) })) return;
    markCrashed(app.save);
    writeSaveResult(app.save);
  } catch {
    /* never let this throw */
  }
};
window.addEventListener('error', (e) => {
  if (!e.error && !e.message) return; // a failed <img>/<script> load, not an exception (as in errors.ts)
  crashedMidMatch(e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => crashedMidMatch(e.reason));

function persist() {
  // A rollover or a promotion clears the ranked offer; the next one is picked here so it is saved with the change.
  app.nextOpp = offeredOpponent(app.save);
  const r = writeSaveResult(app.save);
  saved = r !== 'blocked' && r !== 'quota';
  if (r === 'blocked') toast('This browser blocked storage, so progress will be lost when you close the tab.', false);
  else if (r === 'quota') toast('This browser is out of storage space, so your latest progress is NOT saved. Free some space, or back up your club in Club > Back up.', false);
  telemetry.level(clubLevel(app.save));
}

function render() {
  if (takeover) return;
  const screens: Record<Screen, (a: App) => string> = {
    home: homeScreen,
    club: clubScreen,
    squad: squadScreen,
    transfers: transfersScreen,
    training: trainingScreen,
    ladder: ladderScreen,
    competitions: competitionsScreen,
  };
  // A tab can only be open once it is unlocked (club level).
  if (!screenUnlocked(app.save, app.screen)) app.screen = 'home';
  setReplaySlots(replaySlots(app.save));
  const hadResult = !!root.querySelector('#result-title');
  const hadReview = !!root.querySelector('#review-title');
  const hadLevelUp = !!root.querySelector('#levelup-title');
  const key = pendingFocus ?? captureFocus(root);
  pendingFocus = null;
  beforeRender(root);
  root.innerHTML = shell(app, screens[app.screen](app));
  const levelUp = !app.result && levelUpOpen(app.save);
  syncMark(!app.result && !levelUp && !reviewOpen(app.save));
  // The scrolling part of the result takes focus (it is labelled by the title), so the arrow and Page keys scroll it at once.
  if (app.result && !hadResult) root.querySelector<HTMLElement>('.modal .rs-scroll')?.focus();
  else if (levelUp && !hadLevelUp) {
    levelOrigin = key;
    root.querySelector<HTMLElement>('#levelup-title')?.focus();
    announce(levelUpAnnouncement(app.save));
  } else if (!app.result && !levelUp && reviewOpen(app.save) && !hadReview) root.querySelector<HTMLElement>('#review-title')?.focus();
  else restoreFocus(root, key, '#main');
  afterRender(root);
}

/**
 * Tab marks (coach.ts): a tab a level-up just revealed gets a spotlight and a card, once. Only while no dialog is open;
 * opening the tab (or Esc, or "Got it") counts as seeing it. Players who predate the first-run flow have no `marks`
 * and never see one. The card is inserted right after the tab bar so it follows the tabs in focus order, is scrolled
 * into view only when it first appears (never on scroll), and is announced once per mark, not once per render.
 */
let spokenMark: string | null = null;
function syncMark(clear: boolean) {
  const marks = app.prefs.marks;
  if (!marks || !clear) return;
  if (acknowledge(marks, app.screen)) writePrefs(app.prefs);
  const mark = pendingMark(app.save, marks, app.screen);
  if (!mark) {
    spokenMark = null;
    return;
  }
  root.querySelector('.tabs')?.insertAdjacentHTML('afterend', markHtml(mark));
  const first = spokenMark !== mark.screen;
  placeMark(root, first);
  if (first) {
    spokenMark = mark.screen;
    announce(`${mark.title}. ${mark.text}`);
  }
}
window.addEventListener('resize', () => placeMark(root, false));
window.addEventListener('scroll', () => placeMark(root, false), { passive: true });

/** Focus the main region. After setup the page stays at the top, so the header and Kick off are in view. */
function focusMain(keepScroll = false) {
  root.querySelector<HTMLElement>('#main')?.focus({ preventScroll: keepScroll });
  if (keepScroll) window.scrollTo({ top: 0 });
}

/**
 * First run: one welcome, one Kick off. Nothing is asked before the first match, and the first match stays pending
 * (prefs.onboarded false) until it is played to the end: leaving it, or reloading, brings the welcome and the same
 * easy opponent back, so nobody loses the payoff by closing the tab.
 */
function startOnboarding() {
  takeover = true;
  hideToast();
  const opp = warmupTeam(app.save, true);
  const stop = mountWelcome(root, {
    save: app.save,
    opp: opp.id,
    onKickOff: () => {
      stop();
      startFirstMatch(opp);
    },
    onSkip: () => {
      // "I've played before": no first-run flow, so no tips or tab marks either.
      stop();
      takeover = false;
      app.prefs.onboarded = true;
      writePrefs(app.prefs);
      app.screen = 'home';
      if (openInvite()) return; // came from an invite link: straight to the online lobby
      render();
      if (!root.querySelector('.modal')) focusMain(true);
    },
  });
}

/** The first match, against an easy club, with coach tips. It counts as a friendly: XP, no Elo. */
function startFirstMatch(opp: { id: ClubIdentity; away: TeamSetup }) {
  const s = app.save;
  // From here on the coach is on: tips are remembered one by one, and each tab a level reveals is pointed out once.
  app.prefs.coachSeen ??= [];
  app.prefs.marks ??= openTabs(s);
  writePrefs(app.prefs);
  const finish = (m: MatchState, forfeited: boolean, away: TeamSetup) => {
    const [gf, ga] = m.score;
    if (forfeited) {
      // Left the first match early: nothing recorded; the welcome comes back with the same opponent.
      startOnboarding();
      return;
    }
    // Everything the first match changes is final, and written, before the celebration renders (see firstrun.ts).
    const { summary, opened } = completeFirstMatch(s, app.prefs, { gf, ga, scorers: m.goals.filter((e) => e.team === 0).map((e) => `${e.scorer} ${e.minute}'`), opponent: { name: away.name, short: away.short } });
    persist();
    writePrefs(app.prefs);
    takeover = true;
    const stop = mountAfterMatch(root, {
      save: s,
      opp: opp.id,
      gf,
      ga,
      xp: summary.xp,
      opened,
      persist,
      onDone: () => {
        stop();
        takeover = false;
        app.screen = 'home';
        if (openInvite()) return; // a friend's invite was waiting on this first match
        render();
        if (!root.querySelector('.modal')) focusMain(true);
      },
    });
    window.scrollTo({ top: 0 });
  };
  if (!playLive(opp.away, opp.id.crest, 'Friendly', finish, 'Leave match')) {
    startOnboarding();
  }
}

/** Kick off before ranked opens (level 3): a warm-up friendly against a gentle generated club. Earns XP, no Elo. */
function startWarmup() {
  const w = warmupTeam(app.save);
  playLive(w.away, w.id.crest, 'Warm-up', (m, forfeited, away) => endMatch(m, forfeited, false, null, away, w.id.crest, 'easy', 'Warm-up friendly'));
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
  if (!lineupReady(s)) {
    toast('Pick a full XI first.', false);
    return;
  }
  takeover = true;
  hideToast();
  window.scrollTo({ top: 0 });
  const stop = mountTutorial(root, {
    home: clubTeam(s, 0.6),
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
  /** A ranked, cup or league match: marked on the save before kick-off, so leaving mid-match can't undo it (pending.ts). */
  pending?: PendingMatch,
): boolean {
  const s = app.save;
  if (!lineupReady(s)) {
    toast('Pick a full XI first.', false);
    return false;
  }
  if (pending) {
    beginMatch(s, pending);
    persist();
  }
  const home = clubTeam(s, 0.6);
  const away = avoidClash(home, opponent);
  const seed = int(s.rng, 1, 2 ** 31 - 1);
  matchOrigin = captureFocus(root) ?? keyFor({ action: 'play-ranked' });
  takeover = true;
  hideToast();
  telemetry.track({ name: 'match_start', kind: label, controls: app.prefs.controls });
  const unmount = mountMatch(root, {
    seed,
    home,
    away,
    halfSeconds: app.prefs.halfSeconds, // the standard HALF_SECONDS, or a test-only override (store.ts)
    humanTeam: 0,
    crests: [s.club.crest, crest],
    label,
    forfeitText,
    controls: app.prefs.controls,
    // The input mode the player settled on becomes their preference (the first-run flow no longer asks).
    onControls: (mode) => {
      if (app.prefs.controls !== mode) {
        app.prefs.controls = mode;
        writePrefs(app.prefs);
      }
    },
    // Coach tips only for a club that went through the first-run flow (prefs.coachSeen); each is shown once, ever.
    coach: app.prefs.coachSeen
      ? { seen: app.prefs.coachSeen, onSeen: (id) => { if (!app.prefs.coachSeen!.includes(id)) { app.prefs.coachSeen!.push(id); writePrefs(app.prefs); } } }
      : undefined,
    onEnd: (m, forfeited) => {
      unmount();
      takeover = false;
      // Every match against the CPU teaches the hidden skill estimate (a forfeit is a 0–3 defeat).
      learnSkill(s, home, away, forfeited ? 0 : m.score[0], forfeited ? Math.max(3, m.score[1]) : m.score[1]);
      telemetry.track({ name: 'match_end', kind: label, score: [m.score[0], m.score[1]], forfeit: forfeited });
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
    // The ladder club's own squad and shape; how sharply its CPU plays comes from your skill estimate (skill.ts).
    away = opponentSetup(app.save, opp, clubTeam(app.save, 0.6));
  } else {
    const lvl = practiceLevel!;
    const squad = generateSquad(makeRng(lvl.quality * 7919), lvl.quality);
    const id = { id: lvl.id, name: lvl.name, short: lvl.short, primary: lvl.primary, secondary: lvl.secondary, crest: 'hoops' as const };
    crest = 'hoops';
    away = toTeamSetup(id, squad, autoLineup(squad), lvl.aiSkill);
  }
  const practice = (practiceLevel?.id ?? 'normal') as PracticeLevel;
  const pending: PendingMatch | undefined = ranked && opp ? { kind: 'ranked', opponentId: opp.id, opponent: opp.name, label: 'Ranked' } : undefined;
  playLive(away, crest, ranked ? 'Ranked' : 'Friendly', (m, forfeited, shown) => endMatch(m, forfeited, ranked, opp, shown, crest, practice), undefined, pending);
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
      app.screen = 'home';
      if (!result) pendingFocus = matchOrigin;
      render();
    },
  });
}

function endMatch(m: MatchState, forfeited: boolean, ranked: boolean, opp: LadderClub | null, away: TeamSetup, crest: LadderClub['crest'], practice: PracticeLevel = 'normal', warmup?: string) {
  const s = app.save;
  let [gf, ga] = m.score;
  if (forfeited && ranked) [gf, ga] = [0, Math.max(3, ga)];
  // A forfeit is recorded as 0–3, so the goals actually scored before it don't stand; so is a
  // match abandoned with a side down to six and awarded 3-0 (Law 3), the score in m.score.
  const scorersFor = forfeited || scoreAwarded(m) ? [] : m.goals.filter((e) => e.team === 0).map((e) => `${e.scorer} ${e.minute}'`);
  const scorersAgainst = forfeited || scoreAwarded(m) ? [] : m.goals.filter((e) => e.team === 1).map((e) => `${e.scorer} ${e.minute}'`);
  const eloBefore = s.club.elo;
  const skipRecord = forfeited && !ranked;
  const summary = skipRecord ? null : applyResult(s, ranked ? opp : null, { name: away.name, short: away.short }, gf, ga, ranked, scorersFor, warmup, forfeited, practice);
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
  if (ranked) app.nextOpp = offeredOpponent(s);
  persist();
  app.screen = 'home';
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
    case 'open-backup':
      openSettings({ getSave: () => app.save, onImported: () => location.reload() }, el);
      return;
    case 'skip-to-main':
      e.preventDefault();
      focusMain();
      return;
    case 'nav':
      if (!screenUnlocked(s, el.dataset.screen as Screen)) return;
      app.screen = el.dataset.screen as Screen;
      pendingFocus = focusKeyOf(el, root);
      break;
    case 'go': {
      // A home mode card that opens another screen (Cup, League); focus goes to that tab.
      const to = el.dataset.screen as Screen;
      if (!screenUnlocked(s, to)) return;
      app.screen = to;
      pendingFocus = { elId: `tab-${to}`, data: {}, index: 0 };
      break;
    }
    case 'level-open':
      if (!screenUnlocked(s, 'club')) return; // the club tab opens at level 3
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
    case 'mark-ok':
      if (app.prefs.marks && el.dataset.screen && !app.prefs.marks.includes(el.dataset.screen)) {
        app.prefs.marks.push(el.dataset.screen);
        writePrefs(app.prefs);
      }
      pendingFocus = { elId: `tab-${el.dataset.screen}`, data: {}, index: 0 };
      break;
    case 'replay-tutorial':
      startTraining();
      return;
    case 'play-ranked':
      if (isUnlocked(s, 'ranked')) startMatch(true, app.nextOpp);
      return;
    case 'play-warmup':
      startWarmup();
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
    case 'play-online':
      if (isUnlocked(s, 'link') && relayConfig()) startVersus(mountOnline);
      return;
    case 'auto-lineup':
      s.lineup = autoLineup(s.squad, s.formation);
      toast('Best XI picked.');
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
      queueReveal('.panel.trainee');
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
      if (app.prefs.marks) app.prefs.marks = ['home']; // the new club is level 1 again
      writePrefs(app.prefs);
      persist();
      pendingFocus = keyFor({ action: 'play-ranked' });
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
  } else if (el.dataset.change === 'formation') {
    setFormation(app.save, el.value as FormationId);
    persist();
    render();
  } else if (el.dataset.change === 'mentality') {
    setMentality(app.save, el.value as Mentality);
    persist();
    render();
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
root.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement;
  if (form.dataset.form !== 'rename' || takeover) return;
  e.preventDefault();
  const input = form.querySelector<HTMLInputElement>('#club-rename')!;
  const check = validateClubName(input.value);
  if (!check.ok) {
    toast(check.error, false);
    input.focus();
    return;
  }
  setClubName(app.save, check.name);
  persist();
  toast(`Club renamed to ${app.save.club.name}.`);
  pendingFocus = { elId: 'club-rename', data: {}, index: 0 };
  render();
});

document.addEventListener('keydown', (e) => {
  // Esc dismisses a tab mark (it counts as seen), when no dialog is open.
  const markEl = root.querySelector<HTMLElement>('.tab-mark');
  if (!takeover && e.key === 'Escape' && markEl && !root.querySelector('.modal') && app.prefs.marks) {
    const screen = markEl.dataset.mark!;
    if (!app.prefs.marks.includes(screen)) app.prefs.marks.push(screen);
    writePrefs(app.prefs);
    pendingFocus = { elId: `tab-${screen}`, data: {}, index: 0 };
    render();
    return;
  }
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

/**
 * An invite link (?join=CODE). It opens the online lobby with the code once vs Player is open
 * (the same unlock as the Online button). A brand-new club plays its first match first, with the
 * welcome as usual: the invite waits (in sessionStorage, so a reload keeps it) and opens when that
 * match is done. If the club still can't play online, a toast says when it can.
 */
const JOIN_KEY = 'derbyday.pendingJoin';
let pendingJoin = relayConfig() ? inviteCode() : null;
try {
  if (pendingJoin) sessionStorage.setItem(JOIN_KEY, pendingJoin);
  else if (relayConfig()) pendingJoin = sessionStorage.getItem(JOIN_KEY);
} catch {
  /* storage blocked: the invite lives as long as this page */
}
if (location.search.includes('join=')) history.replaceState(null, '', location.href.replace(/([?&])join=[^&#]*&?/, '$1').replace(/[?&](#|$)/, '$1'));
function dropInvite() {
  pendingJoin = null;
  try {
    sessionStorage.removeItem(JOIN_KEY);
  } catch {
    /* nothing stored */
  }
}
/** Open the waiting invite if the club can play online. Returns true when the lobby took over the page. */
function openInvite(): boolean {
  const code = pendingJoin;
  if (!code || app.prefs.onboarded === false) return false;
  dropInvite();
  if (!isUnlocked(app.save, 'link')) {
    toast(`A friend invited you to an online friendly, but vs Player opens at club level ${unlockLevel(app.save, 'link')}. Ask them for a new link once you're there.`, false);
    return false;
  }
  startVersus((r, o) => mountOnline(r, { ...o, joinCode: code }));
  return true;
}

if (app.prefs.onboarded === false) {
  startOnboarding();
  if (pendingJoin) toast('A friend invited you to an online friendly. Play your first match, then you will join them.');
} else if (!openInvite()) render();
if (loaded.restored) toast('Your save was damaged, so Derby Day restored your previous one. You may have lost your last match or two.', false);
else if (loaded.newer) toast('Your club was saved by a newer version of Derby Day. Reload the page to get it. Nothing is saved in this tab, so your club is safe.', false);
else if (loaded.lost) toast('Your saved club could not be read, so a new one was started. The unreadable save is kept in this browser, and a backup file can bring the old club back (Club > Back up or restore).', false);
else if (!saved) toast('This browser blocked storage, so progress will be lost when you close the tab.', false);
else if (abandoned) toast(abandoned, false);
