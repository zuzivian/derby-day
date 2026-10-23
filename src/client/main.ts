import { autoLineup, generateSquad, ladderSquad, toTeamSetup, type LadderClub } from '../meta/club.ts';
import { applyResult, buyPlayer, newGame, pickOpponent, rerollIdentity, sellPlayer, setLineupSlot, train, type Save } from '../meta/game.ts';
import type { AttrKey } from '../meta/player.ts';
import { possessionShare } from '../sim/match.ts';
import { int, makeRng } from '../sim/rng.ts';
import type { MatchState, TeamSetup } from '../sim/types.ts';
import type { Role } from '../sim/constants.ts';
import type { CrestPattern } from '../meta/names.ts';
import { competitionAction, competitionsScreen } from './competitions.ts';
import { mountMatch } from './matchView.ts';
import { mountShootout, type ShootoutResult, type ShootoutViewOptions } from './shootout.ts';
import { clearSave, loadPrefs, loadSave, writePrefs, writeSave } from './store.ts';
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
    toast: null,
    trainee: null,
    marketRole: 'ALL',
    confirmSell: null,
    confirmReset: false,
    prefs: loadPrefs(),
    result: null,
  };
}

let app = boot(loadSave() ?? newGame(freshSeed()));
let saved = writeSave(app.save);
let toastTimer = 0;
let inMatch = false;

function toast(text: string, ok = true) {
  app.toast = { text, ok };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    app.toast = null;
    render();
  }, 3200);
}

function persist() {
  saved = writeSave(app.save);
  if (!saved) toast('This browser blocked storage, so progress will be lost when you close the tab.', false);
}

function render() {
  if (inMatch) return;
  const screens: Record<Screen, (a: App) => string> = {
    club: clubScreen,
    squad: squadScreen,
    transfers: transfersScreen,
    training: trainingScreen,
    ladder: ladderScreen,
    competitions: competitionsScreen,
  };
  root.innerHTML = shell(app, screens[app.screen](app));
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
  inMatch = true;
  app.toast = null;
  const unmount = mountMatch(root, {
    seed,
    home,
    away,
    halfSeconds: app.prefs.halfSeconds,
    humanTeam: 0,
    crests: [s.club.crest, crest],
    label,
    forfeitText,
    onEnd: (m, forfeited) => {
      unmount();
      inMatch = false;
      onDone(m, forfeited, away);
    },
  });
  return true;
}

/** Mount the live penalty shootout for a drawn cup tie and hand back its result. */
function playShootout(opts: Omit<ShootoutViewOptions, 'onEnd'>, onDone: (r: ShootoutResult) => void) {
  inMatch = true;
  app.toast = null;
  const unmount = mountShootout(root, {
    ...opts,
    onEnd: (r) => {
      unmount();
      inMatch = false;
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
  playLive(away, crest, ranked ? 'Ranked' : 'Friendly', (m, forfeited, shown) => endMatch(m, forfeited, ranked, opp, shown, crest));
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
  if (!el) return;
  const s = app.save;
  const id = el.dataset.id ?? '';
  const action = el.dataset.action;
  if (action !== 'sell-confirm' && action !== 'sell') app.confirmSell = null;
  if (action !== 'reset-confirm' && action !== 'reset') app.confirmReset = false;
  if (action?.startsWith('comp-')) {
    if (competitionAction(action, el, { app, toast, persist, render, playLive, playShootout })) render();
    return;
  }

  switch (action) {
    case 'nav':
      app.screen = el.dataset.screen as Screen;
      break;
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
      persist();
      toast(`${app.save.club.name} founded.`);
      break;
    case 'reset-cancel':
      break;
    case 'close-result':
      app.result = null;
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

render();
if (!saved) toast('This browser blocked storage, so progress will be lost when you close the tab.', false);
