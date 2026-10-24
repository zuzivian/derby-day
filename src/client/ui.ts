// HTML templates for the management screens. Pure functions of app state.

import { FORMATION_IDS, formationOf, type Role } from '../sim/constants.ts';
import { teamStrength, type LadderClub } from '../meta/club.ts';
import { kFactor } from '../meta/elo.ts';
import { askingPrice, formatMoney, ladderTable, MIN_SQUAD, salePrice, type ResultSummary, type Save } from '../meta/game.ts';
import { isUnlocked, squadCap, type UnlockId } from '../meta/levels.ts';
import { ATTR_KEYS, ATTR_LABEL, ATTR_NAME, fullName, marketValue, nation, overall, ratingAs, type AttrKey, type Player } from '../meta/player.ts';
import type { CrestPattern } from '../meta/names.ts';
import type { TeamStats } from '../sim/types.ts';
import { potentialText, SEASON_WEEKS, weekOfYear } from '../meta/progression.ts';
import { crestSvg } from './crest.ts';
import { identityControls, levelChip, levelPanel, levelUpModal, levelUpOpen, xpRewardsHtml } from './levels.ts';
import { recentReplaysHtml, resultReplayHtml } from './replayView.ts';
import { academyPanel, reviewButton, reviewModal, reviewOpen } from './review.ts';
import type { Prefs } from './store.ts';

/** 'home' is the first view (kick off, play modes); 'club' holds the secondary content (news, replays, club level, tutorial, reset). */
export type Screen = 'home' | 'squad' | 'transfers' | 'training' | 'ladder' | 'competitions' | 'club';

export interface ResultView {
  ranked: boolean;
  forfeited: boolean;
  /** An online friendly that ended because the opponent never came back: no winner, no "full-time". */
  abandoned?: boolean;
  gf: number;
  ga: number;
  opp: { name: string; short: string; primary: string; secondary: string; crest: CrestPattern };
  summary: ResultSummary | null;
  eloBefore: number;
  eloAfter: number;
  stats: [TeamStats, TeamStats];
  possession: [number, number];
  scorersFor: string[];
  scorersAgainst: string[];
  /** Overrides the Ranked/Friendly eyebrow, e.g. "Cup semi-final". */
  label?: string;
  /** One line under the score, e.g. "Through to the final. +ƒ160k." */
  note?: string;
  /** Replaces "Nothing recorded for an abandoned friendly." when there is no summary. */
  unrecorded?: string;
}

export interface App {
  save: Save;
  screen: Screen;
  nextOpp: LadderClub;
  trainee: string | null;
  marketRole: Role | 'ALL';
  confirmSell: string | null;
  confirmReset: boolean;
  prefs: Prefs;
  result: ResultView | null;
}

export const esc = (t: string | number): string =>
  String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Which unlock opens each tab (Competitions opens with either the Cup or the League). */
const TAB_UNLOCK: Record<Screen, UnlockId[]> = {
  home: ['club'],
  club: ['club'],
  squad: ['squad'],
  transfers: ['transfers'],
  training: ['training'],
  ladder: ['ladder'],
  competitions: ['cup', 'league'],
};

export const screenUnlocked = (save: Save, screen: Screen): boolean => TAB_UNLOCK[screen].some((id) => isUnlocked(save, id));

const TABS: { id: Screen; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'squad', label: 'Squad' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'training', label: 'Training' },
  { id: 'ladder', label: 'Ladder' },
  { id: 'competitions', label: 'Competitions' },
  { id: 'club', label: 'Club' },
];

export const PRACTICE = [
  { id: 'easy', label: 'Easy', name: 'Reserve XI', short: 'RES', quality: 46, aiSkill: 0.2, primary: '#9ca3af', secondary: '#111827' },
  { id: 'normal', label: 'Normal', name: 'Academy Select', short: 'ACA', quality: 58, aiSkill: 0.5, primary: '#f8fafc', secondary: '#0f172a' },
  { id: 'hard', label: 'Hard', name: 'Veterans Select', short: 'VET', quality: 72, aiSkill: 0.85, primary: '#1f2937', secondary: '#facc15' },
] as const;

/** Easy and Normal from level 1; Hard needs its own unlock. */
export const practiceUnlocked = (save: Save, id: string): boolean => (id === 'hard' ? isUnlocked(save, 'practice-hard') : true);

function rankOf(save: Save): number {
  return ladderTable(save).findIndex((r) => r.you) + 1;
}

// ---------------------------------------------------------------------------
// The status strip: the one row of club status above the tabs. It grows with
// the club: sessions at Training (level 2), money at Transfers (3), the ladder
// position at the Ladder (4), the season week with the calendar (10).

const stripIcon = (body: string) => `<svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${body}</svg>`;
const COIN = stripIcon('<circle cx="12" cy="12" r="9.5" fill="currentColor" opacity=".18"/><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14.5 7.5c-2.6-.6-3.6.6-3.9 2.5L9.7 16.5M8.5 11.5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
const LADDER = stripIcon('<path d="M7 3v18M17 3v18M7 7h10M7 12h10M7 17h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
const CAL = stripIcon('<rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');

/** Training sessions as pips (up to 8 drawn), with the count beside them. */
function sessionPips(n: number): string {
  const drawn = Math.min(n, 8);
  return `<div class="stat sessions" title="Training sessions">
    <span class="pips" aria-hidden="true">${Array.from({ length: Math.max(drawn, 1) }, (_, i) => `<i class="${i < drawn ? 'on' : ''}"></i>`).join('')}</span>
    <span class="stat-num" aria-hidden="true">${n}</span><span class="sr-only">${n} training session${n === 1 ? '' : 's'}</span>
  </div>`;
}

function statusStrip(s: Save): string {
  const c = s.club;
  const items = [
    levelChip(s),
    isUnlocked(s, 'training') ? sessionPips(s.trainingPoints) : '',
    isUnlocked(s, 'transfers') ? `<div class="stat money" title="Club florins">${COIN}<span class="stat-num" aria-hidden="true">${formatMoney(s.budget)}</span><span class="sr-only">Money: ${formatMoney(s.budget)}</span></div>` : '',
    isUnlocked(s, 'ladder') ? `<div class="stat rank" title="Ladder position">${LADDER}<span class="stat-num" aria-hidden="true">#${rankOf(s)}</span><span class="sr-only">Ladder position ${rankOf(s)} of ${s.ladder.length + 1}</span></div>` : '',
    isUnlocked(s, 'calendar') ? `<div class="stat week" title="Season and week">${CAL}<span class="stat-num" aria-hidden="true">S${s.year ?? 1} · W${weekOfYear(s)}</span><span class="sr-only">Season ${s.year ?? 1}, week ${weekOfYear(s)} of ${SEASON_WEEKS}</span></div>` : '',
  ].filter(Boolean);
  const chip = `<div class="club-chip">${crestSvg(c, 30)}<div class="club-chip-text"><div class="club-name">${esc(c.name)}</div><div class="club-elo">Elo <b>${c.elo}</b></div></div></div>`;
  return `${chip}<div class="status-strip" role="group" aria-label="Club status">${items.join('')}</div>`;
}

export function shell(app: App, body: string): string {
  const s = app.save;
  // While the result or season review dialog is open everything behind it is inert, so focus can't leave it.
  const inert = app.result || levelUpOpen(app.save) || reviewOpen(app.save) ? ' inert' : '';
  return `
  <a class="skip-link" href="#main" data-action="skip-to-main"${inert}>Skip to main content</a>
  <header class="topbar"${inert}>
    <h1 class="wordmark">Derby Day</h1>
    ${statusStrip(s)}
  </header>
  <div class="tabs" role="tablist" aria-label="Sections"${inert}>
    ${TABS.filter((t) => screenUnlocked(s, t.id)).map((t) => {
      const on = app.screen === t.id;
      return `<button class="tab${on ? ' on' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-action="nav" data-screen="${t.id}"${on ? ' aria-current="page"' : ''}>${t.label}</button>`;
    }).join('')}
  </div>
  <main id="main" class="screen" tabindex="-1"${inert}><div id="panel" role="tabpanel" aria-labelledby="tab-${app.screen}">${body}</div></main>
  ${app.result ? resultModal(app) : levelUpOpen(s) ? levelUpModal(s) : reviewModal(app)}`;
}

// ---------------------------------------------------------------------------

function sparkline(values: number[]): string {
  const w = 280;
  const h = 72;
  const pts = values.length > 1 ? values : [values[0], values[0]];
  const lo = Math.min(...pts) - 10;
  const hi = Math.max(...pts) + 10;
  const x = (i: number) => 6 + (i / (pts.length - 1)) * (w - 12);
  const y = (v: number) => h - 8 - ((v - lo) / (hi - lo)) * (h - 18);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `6,${h - 8} ${line} ${x(pts.length - 1).toFixed(1)},${h - 8}`;
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Elo over ${values.length - 1} ranked matches, now ${last}">
    <line x1="6" x2="${w - 6}" y1="${y(1000)}" y2="${y(1000)}" class="spark-base"/>
    <polygon points="${area}" class="spark-area"/>
    <polyline points="${line}" class="spark-line"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(last)}" r="4" class="spark-dot"/>
  </svg>`;
}

function formChips(save: Save): string {
  const recent = save.history.slice(-6).reverse();
  if (!recent.length) return `<p class="muted">No matches yet. Your first ranked result moves your Elo by up to ${kFactor(0)} points.</p>`;
  return `<ul class="results">${recent
    .map((m) => {
      const r = m.goalsFor > m.goalsAgainst ? 'W' : m.goalsFor === m.goalsAgainst ? 'D' : 'L';
      const d = m.eloAfter - m.eloBefore;
      return `<li><span class="res res-${r}">${r}</span><span class="res-score">${m.goalsFor}–${m.goalsAgainst}</span><span class="res-opp">${esc(m.opponent)}</span><span class="res-elo">${m.ranked ? `${d >= 0 ? '+' : ''}${d}` : esc(m.competition ?? 'friendly')}</span></li>`;
    })
    .join('')}</ul>`;
}

/**
 * The Club tab: everything that used to crowd the first view. Elo history and
 * results, replays, the club level panel, club news, the tutorial and reset.
 */
export function clubScreen(app: App): string {
  const s = app.save;
  return `
  <div class="club-grid">
    <article class="panel form">
      <h2 class="eyebrow">Elo</h2>
      <div class="elo-row"><span class="elo-big">${s.club.elo}</span><span class="record">${s.club.won}W ${s.club.drawn}D ${s.club.lost}L · ${s.club.gf}–${s.club.ga}</span></div>
      ${sparkline(s.eloHistory)}
      <h3 class="eyebrow">Recent</h3>
      ${formChips(s)}
      ${isUnlocked(s, 'replays') ? recentReplaysHtml() : ''}
    </article>

    <article class="panel news">
      <h2 class="eyebrow" id="news-title" tabindex="-1">Club news${isUnlocked(s, 'calendar') ? ` · Season ${s.year ?? 1}, week ${weekOfYear(s)} of ${SEASON_WEEKS}` : ''}</h2>
      <ul class="news-list">${s.news.slice(-8).reverse().map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <div class="news-actions">
        ${s.club.played === 0 ? `<button class="btn small" data-action="reroll">New name and colours</button>` : ''}
        ${reviewButton(app)}
        <button class="btn small" data-action="replay-tutorial">Replay tutorial</button>
        ${app.confirmReset
          ? `<button class="btn small danger" data-action="reset-confirm">Delete this club and start over</button><button class="btn small" data-action="reset-cancel">Keep it</button>`
          : `<button class="btn small ghost" data-action="reset">Start a new club</button>`}
      </div>
      ${identityControls(s)}
      <p class="muted small">Saved in this browser only.</p>
    </article>

    ${levelPanel(s)}
  </div>`;
}

// ---------------------------------------------------------------------------

function attrCell(v: number): string {
  const tier = v >= 80 ? 'a' : v >= 68 ? 'b' : v >= 55 ? 'c' : 'd';
  return `<td class="num attr t-${tier}">${v}</td>`;
}

function playerRow(p: Player, extra: string, starter = false, showNumber = true): string {
  return `<tr${starter ? ' class="starter"' : ''}>
    <td class="num${showNumber ? '' : ' muted'}">${showNumber ? p.number : '–'}</td>
    <td class="name">${esc(fullName(p))}${starter ? ' <span class="pill">XI</span>' : ''}</td>
    <td>${esc(nation(p))}</td>
    <td class="num">${p.age}</td>
    <td><span class="pos pos-${p.role}">${p.role}</span></td>
    <td class="num ovr">${overall(p)}</td>
    <td class="num muted">${potentialText(p)}</td>
    ${ATTR_KEYS.map((k) => attrCell(p.attrs[k])).join('')}
    ${extra}
  </tr>`;
}

const attrHead = ATTR_KEYS.map((k) => `<th class="num" title="${ATTR_NAME[k]}">${ATTR_LABEL[k]}</th>`).join('');

export function squadScreen(app: App): string {
  const s = app.save;
  const byId = new Map(s.squad.map((p) => [p.id, p]));
  const formation = formationOf(s.formation);
  const slots = formation.map((f, slot) => {
    const cur = byId.get(s.lineup[slot]);
    const options = [...s.squad]
      .sort((a, b) => ratingAs(b, f.role) - ratingAs(a, f.role))
      .map((p) => `<option value="${p.id}"${p.id === cur?.id ? ' selected' : ''}>${esc(`${p.last} · ${ratingAs(p, f.role)}${p.role !== f.role ? ` (${p.role})` : ''}`)}</option>`)
      .join('');
    // Base shape x runs 0.02 (keeper) to about 0.6 (strikers): spread it over the board.
    return `<div class="slot" style="--x:${(2 + (f.x / 0.62) * 88).toFixed(1)}%;--y:${f.y * 100}%">
      <span class="magnet">${cur?.number ?? '?'}</span>
      <label class="slot-label"><span class="slot-role">${f.label}</span>
        <select id="slot-${slot}" data-change="slot" data-slot="${slot}">${options}</select>
      </label>
    </div>`;
  }).join('');
  return `
  <div class="squad-grid">
    ${academyPanel(app)}
    <article class="panel board">
      <div class="board-head"><h2 class="eyebrow">Lineup · <label class="formation-pick"><span class="sr-only">Formation</span><select id="formation" data-change="formation">${FORMATION_IDS.map((id) => `<option value="${id}"${id === (s.formation ?? '4-4-2') ? ' selected' : ''}>${id}</option>`).join('')}</select></label> · attacking <span aria-hidden="true">→</span><span class="sr-only">to the right</span></h2><div class="strength">XI strength <b>${teamStrength(s.squad, s.lineup, s.formation)}</b></div></div>
      <div class="mini-pitch">${slots}</div>
      <div class="actions"><button class="btn" data-action="auto-lineup">Pick my best XI</button><span class="muted small">Ratings shown are for that slot. Out-of-position players lose a lot.</span></div>
    </article>
    <article class="panel">
      <h2 class="eyebrow">Squad · ${s.squad.length}/${squadCap(s)}</h2>
      <div class="table-scroll"><table class="tbl">
        <thead><tr><th class="num">#</th><th>Name</th><th>Nation</th><th class="num">Age</th><th>Pos</th><th class="num">OVR</th><th class="num">POT</th>${attrHead}<th class="num">Value</th></tr></thead>
        <tbody>${[...s.squad].sort((a, b) => formation.findIndex((f) => f.role === a.role) - formation.findIndex((f) => f.role === b.role) || overall(b) - overall(a)).map((p) => playerRow(p, `<td class="num">${formatMoney(marketValue(p))}</td>`, s.lineup.includes(p.id))).join('')}</tbody>
      </table></div>
    </article>
  </div>`;
}

// ---------------------------------------------------------------------------

export function transfersScreen(app: App): string {
  const s = app.save;
  const roles: (Role | 'ALL')[] = ['ALL', 'GK', 'DEF', 'MID', 'FWD'];
  const market = s.market.filter((p) => app.marketRole === 'ALL' || p.role === app.marketRole);
  const cap = squadCap(s);
  const full = s.squad.length >= cap;
  return `
  <div class="stack">
    <article class="panel">
      <div class="board-head">
        <h2 class="eyebrow">Transfer market · refreshes after every ranked match</h2>
        <div class="chips" role="group" aria-label="Filter by position">${roles.map((r) => `<button class="chip${app.marketRole === r ? ' on' : ''}" data-action="market-role" data-role="${r}" aria-pressed="${app.marketRole === r}">${r === 'ALL' ? 'All' : r}</button>`).join('')}</div>
      </div>
      <div class="table-scroll"><table class="tbl">
        <thead><tr><th class="num">#</th><th>Name</th><th>Nation</th><th class="num">Age</th><th>Pos</th><th class="num">OVR</th><th class="num">POT</th>${attrHead}<th class="num">Price</th><th></th></tr></thead>
        <tbody>${market.length ? market.map((p) => {
          const price = askingPrice(p);
          const can = price <= s.budget && !full;
          return playerRow(p, `<td class="num">${formatMoney(price)}</td><td><button class="btn small${can ? ' primary' : ''}" data-action="buy" data-id="${p.id}" aria-label="Sign ${esc(fullName(p))}"${can ? '' : ' aria-disabled="true"'}>Sign</button></td>`, false, false);
        }).join('') : `<tr><td colspan="16" class="muted">Nobody at that position right now.</td></tr>`}</tbody>
      </table></div>
      <p class="muted small">Budget ${formatMoney(s.budget)}${full ? ` · squad full (${cap}), sell before you sign` : ''}. Player-to-player trading arrives with accounts; see the roadmap.</p>
    </article>
    <article class="panel">
      <h2 class="eyebrow">Sell · CPU clubs pay 80% of value · minimum squad ${MIN_SQUAD}</h2>
      <div class="table-scroll"><table class="tbl compact">
        <thead><tr><th class="num">#</th><th>Name</th><th>Pos</th><th class="num">Age</th><th class="num">OVR</th><th class="num">Offer</th><th></th></tr></thead>
        <tbody>${s.squad.map((p) => `<tr${s.lineup.includes(p.id) ? ' class="starter"' : ''}><td class="num">${p.number}</td><td class="name">${esc(fullName(p))}</td><td><span class="pos pos-${p.role}">${p.role}</span></td><td class="num">${p.age}</td><td class="num ovr">${overall(p)}</td><td class="num">${formatMoney(salePrice(p))}</td><td>${
          app.confirmSell === p.id
            ? `<button class="btn small danger" data-action="sell-confirm" data-id="${p.id}" aria-label="Confirm sale of ${esc(fullName(p))} for ${formatMoney(salePrice(p))}">Confirm sale</button>`
            : `<button class="btn small" data-action="sell" data-id="${p.id}" aria-label="Sell ${esc(fullName(p))}">Sell</button>`
        }</td></tr>`).join('')}</tbody>
      </table></div>
    </article>
  </div>`;
}

// ---------------------------------------------------------------------------

export function trainingScreen(app: App): string {
  const s = app.save;
  const p = s.squad.find((x) => x.id === app.trainee) ?? s.squad[0];
  const relevant = (k: AttrKey) => k !== 'goalkeeping' || p.role === 'GK';
  return `
  <div class="training-grid">
    <article class="panel roster">
      <h2 class="eyebrow">${s.trainingPoints} session${s.trainingPoints === 1 ? '' : 's'} left · ranked win +3, other results +2, friendlies +1</h2>
      <ul class="roster-list">${s.squad.map((x) => `<li><button class="roster-btn${x.id === p.id ? ' on' : ''}" data-action="trainee" data-id="${x.id}" aria-pressed="${x.id === p.id}">
        <span class="pos pos-${x.role}">${x.role}</span><span class="roster-name">${esc(fullName(x))}</span><span class="roster-age">${x.age}</span><span class="roster-ovr">${overall(x)}<small>/${potentialText(x)}</small></span>
      </button></li>`).join('')}</ul>
    </article>
    <article class="panel trainee">
      <div class="trainee-head">
        <span class="magnet big">${p.number}</span>
        <div><h2>${esc(fullName(p))}</h2><div class="muted">${p.role} · ${p.age} · ${esc(nation(p))}</div></div>
        <div class="ovr-block"><span class="ovr-big">${overall(p)}</span><span class="muted">potential ${potentialText(p)}</span></div>
      </div>
      <ul class="attr-list">${ATTR_KEYS.filter(relevant).map((k) => `<li>
        <span class="attr-name">${ATTR_NAME[k]}</span>
        <span class="bar" aria-hidden="true"><span style="width:${p.attrs[k]}%"></span></span>
        <span class="attr-val">${p.attrs[k]}</span>
        <button class="btn small" data-action="train" data-id="${p.id}" data-attr="${k}" aria-label="Train ${ATTR_NAME[k].toLowerCase()}"${s.trainingPoints > 0 ? '' : ' aria-disabled="true"'}>Train</button>
      </li>`).join('')}</ul>
      <p class="muted small">Under-21s grow fastest. A player at their potential rarely improves, so spend sessions on the young ones.</p>
    </article>
  </div>`;
}

// ---------------------------------------------------------------------------

export function ladderScreen(app: App): string {
  const rows = ladderTable(app.save);
  return `
  <article class="panel">
    <h2 class="eyebrow">Ladder · ranked by Elo · CPU clubs also play each other between your matches</h2>
    <div class="table-scroll"><table class="tbl ladder">
      <thead><tr><th class="num">Pos</th><th>Club</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">Elo</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr${r.you ? ' class="you"' : ''}><td class="num">${i + 1}</td><td class="name"><span class="kit" style="--p:${r.primary};--s:${r.secondary}"></span>${esc(r.name)}${r.you ? ' <span class="pill">you</span>' : ''}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.drawn}</td><td class="num">${r.lost}</td><td class="num ovr">${r.elo}</td></tr>`).join('')}</tbody>
    </table></div>
  </article>`;
}

// ---------------------------------------------------------------------------

function resultModal(app: App): string {
  const r = app.result!;
  const c = app.save.club;
  const outcome = r.abandoned ? 'Abandoned' : r.gf > r.ga ? 'Win' : r.gf === r.ga ? 'Draw' : 'Defeat';
  const d = r.eloAfter - r.eloBefore;
  const stat = (label: string, a: number | string, b: number | string) => `<div class="stat"><span class="num">${a}</span><span class="stat-label">${label}</span><span class="num">${b}</span></div>`;
  return `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="result-title">
    <div class="modal-card">
      <div class="eyebrow">${esc(r.label ?? (r.ranked ? 'Ranked' : 'Friendly'))}${r.abandoned ? '' : ' · full-time'}${r.forfeited ? ' · forfeited' : ''}</div>
      <h2 id="result-title" class="result-title" tabindex="-1">${outcome}</h2>
      <div class="result-score">
        <div class="side">${crestSvg(c, 44)}<span>${esc(c.short)}</span></div>
        <div class="big-score">${r.gf}<span>–</span>${r.ga}</div>
        <div class="side">${crestSvg(r.opp, 44)}<span>${esc(r.opp.short)}</span></div>
      </div>
      ${r.note ? `<p class="result-note">${esc(r.note)}</p>` : ''}
      ${r.scorersFor.length || r.scorersAgainst.length ? `<div class="scorers"><div>${r.scorersFor.map(esc).join('<br>')}</div><div>${r.scorersAgainst.map(esc).join('<br>')}</div></div>` : ''}
      ${r.forfeited ? '' : `<div class="stats">
        ${stat('Possession', `${r.possession[0]}%`, `${r.possession[1]}%`)}
        ${stat('Shots', r.stats[0].shots, r.stats[1].shots)}
        ${stat('On target', r.stats[0].onTarget, r.stats[1].onTarget)}
        ${stat('Passes', r.stats[0].passes, r.stats[1].passes)}
        ${stat('Tackles won', r.stats[0].tackles, r.stats[1].tackles)}
      </div>`}
      ${r.summary ? `<ul class="rewards">
        ${r.ranked ? `<li><b class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d} Elo</b> → ${r.eloAfter}</li>` : ''}
        ${r.summary.money > 0 ? `<li>+${formatMoney(r.summary.money)} prize money</li>` : ''}
        <li>+${r.summary.trainingPoints} training session${r.summary.trainingPoints === 1 ? '' : 's'}</li>
        ${r.summary.developments.map((x) => `<li>${esc(x)}</li>`).join('')}
        ${xpRewardsHtml(r.summary.xp, r.forfeited)}
      </ul>` : `<p class="muted">${esc(r.unrecorded ?? 'Nothing recorded for an abandoned friendly.')}</p>`}
      ${isUnlocked(app.save, 'replays') ? resultReplayHtml() : ''}
      <button class="btn primary big" data-action="close-result">Back to the club</button>
    </div>
  </div>`;
}
