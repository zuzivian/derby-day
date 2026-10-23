// HTML templates for the management screens. Pure functions of app state.

import { FORMATION, type Role } from '../sim/constants.ts';
import { teamStrength, type LadderClub, ladderSquad, autoLineup } from '../meta/club.ts';
import { expectedScore, kFactor } from '../meta/elo.ts';
import { askingPrice, formatMoney, ladderTable, MAX_SQUAD, MIN_SQUAD, salePrice, type ResultSummary, type Save } from '../meta/game.ts';
import { ATTR_KEYS, ATTR_LABEL, ATTR_NAME, fullName, marketValue, nation, overall, ratingAs, type AttrKey, type Player } from '../meta/player.ts';
import type { CrestPattern } from '../meta/names.ts';
import type { TeamStats } from '../sim/types.ts';
import { potentialText, SEASON_WEEKS, weekOfYear } from '../meta/progression.ts';
import { crestSvg } from './crest.ts';
import { recentReplaysHtml, resultReplayHtml } from './replayView.ts';
import { academyPanel, reviewButton, reviewModal, reviewOpen } from './review.ts';
import type { Prefs } from './store.ts';

export type Screen = 'club' | 'squad' | 'transfers' | 'training' | 'ladder' | 'competitions';

export interface ResultView {
  ranked: boolean;
  forfeited: boolean;
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

const TABS: { id: Screen; label: string }[] = [
  { id: 'club', label: 'Club' },
  { id: 'squad', label: 'Squad' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'training', label: 'Training' },
  { id: 'ladder', label: 'Ladder' },
  { id: 'competitions', label: 'Competitions' },
];

export const PRACTICE = [
  { id: 'easy', label: 'Easy', name: 'Reserve XI', short: 'RES', quality: 46, aiSkill: 0.2, primary: '#9ca3af', secondary: '#111827' },
  { id: 'normal', label: 'Normal', name: 'Academy Select', short: 'ACA', quality: 58, aiSkill: 0.5, primary: '#f8fafc', secondary: '#0f172a' },
  { id: 'hard', label: 'Hard', name: 'Veterans Select', short: 'VET', quality: 72, aiSkill: 0.85, primary: '#1f2937', secondary: '#facc15' },
] as const;

function rankOf(save: Save): number {
  return ladderTable(save).findIndex((r) => r.you) + 1;
}

export function shell(app: App, body: string): string {
  const s = app.save;
  const c = s.club;
  // While the result or season review dialog is open everything behind it is inert, so focus can't leave it.
  const inert = app.result || reviewOpen(app.save) ? ' inert' : '';
  return `
  <a class="skip-link" href="#main" data-action="skip-to-main"${inert}>Skip to main content</a>
  <header class="topbar"${inert}>
    <div class="brand"><h1 class="wordmark">Overlap</h1><span class="tagline">Run the club. Play the match.</span></div>
    <div class="club-chip">
      ${crestSvg(c, 34)}
      <div class="club-chip-text">
        <div class="club-name">${esc(c.name)}</div>
        <div class="club-meta"><span>Elo <b>${c.elo}</b></span><span>#${rankOf(s)} of ${s.ladder.length + 1}</span><span title="Club florins">${formatMoney(s.budget)}</span><span>${s.trainingPoints} sessions</span></div>
      </div>
    </div>
  </header>
  <div class="tabs" role="tablist" aria-label="Sections"${inert}>
    ${TABS.map((t) => {
      const on = app.screen === t.id;
      return `<button class="tab${on ? ' on' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-action="nav" data-screen="${t.id}"${on ? ' aria-current="page"' : ''}>${t.label}</button>`;
    }).join('')}
  </div>
  <main id="main" class="screen" tabindex="-1"${inert}><div id="panel" role="tabpanel" aria-labelledby="tab-${app.screen}">${body}</div></main>
  ${app.result ? resultModal(app) : reviewModal(app)}`;
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

export function clubScreen(app: App): string {
  const s = app.save;
  const opp = app.nextOpp;
  const oppSquad = ladderSquad(opp);
  const ours = teamStrength(s.squad, s.lineup);
  const theirs = teamStrength(oppSquad, autoLineup(oppSquad));
  const p = expectedScore(s.club.elo, opp.elo);
  const k = kFactor(s.club.played);
  const winGain = Math.round(k * (1 - p));
  const lossCost = Math.round(k * p);
  return `
  <div class="club-grid">
    <article class="panel fixture">
      <h2 class="eyebrow">Next ranked match</h2>
      <div class="versus">
        <div class="side">${crestSvg(s.club, 64)}<div class="side-name">${esc(s.club.name)}</div><div class="side-elo">Elo ${s.club.elo}</div></div>
        <div class="vs">vs</div>
        <div class="side">${crestSvg(opp, 64)}<div class="side-name">${esc(opp.name)}</div><div class="side-elo">Elo ${opp.elo}</div></div>
      </div>
      <div class="odds">
        <div class="odds-bar" aria-hidden="true"><span style="width:${Math.round(p * 100)}%"></span></div>
        <div class="odds-labels"><span>Expected score ${Math.round(p * 100)}%</span><span>Win +${winGain} · Lose −${lossCost}</span></div>
      </div>
      <dl class="facts">
        <div><dt>Your XI</dt><dd>${ours}</dd></div>
        <div><dt>Their XI</dt><dd>${theirs}</dd></div>
        <div><dt>Format</dt><dd>6-a-side, boards</dd></div>
      </dl>
      <div class="actions">
        <button class="btn primary big" data-action="play-ranked">Kick off ranked</button>
        <label class="length">Match length
          <select id="half-length" data-change="half">
            ${[60, 120, 240].map((v) => `<option value="${v}"${app.prefs.halfSeconds === v ? ' selected' : ''}>${v === 60 ? '2 × 1 min' : v === 120 ? '2 × 2 min' : '2 × 4 min'}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="practice">
        <span class="practice-label">Practice vs CPU, no Elo:</span>
        ${PRACTICE.map((x) => `<button class="btn small" data-action="play-practice" data-level="${x.id}">${x.label}</button>`).join('')}
      </div>
      <p class="scribble" aria-hidden="true">your man chases the mouse → click where the ball goes</p>
    </article>

    <article class="panel form">
      <h2 class="eyebrow">Elo</h2>
      <div class="elo-row"><span class="elo-big">${s.club.elo}</span><span class="record">${s.club.won}W ${s.club.drawn}D ${s.club.lost}L · ${s.club.gf}–${s.club.ga}</span></div>
      ${sparkline(s.eloHistory)}
      <h3 class="eyebrow">Recent</h3>
      ${formChips(s)}
      ${recentReplaysHtml()}
    </article>

    <article class="panel news">
      <h2 class="eyebrow">Club news · Season ${s.year ?? 1}, week ${weekOfYear(s)} of ${SEASON_WEEKS}</h2>
      <ul class="news-list">${s.news.slice(-8).reverse().map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <div class="news-actions">
        ${s.club.played === 0 ? `<button class="btn small" data-action="reroll">New name and colours</button>` : ''}
        ${reviewButton(app)}
        <button class="btn small" data-action="replay-tutorial">Replay tutorial</button>
        ${app.confirmReset
          ? `<button class="btn small danger" data-action="reset-confirm">Delete this club and start over</button><button class="btn small" data-action="reset-cancel">Keep it</button>`
          : `<button class="btn small ghost" data-action="reset">Start a new club</button>`}
      </div>
      <p class="muted small">Saved in this browser only.</p>
    </article>
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
  const slots = FORMATION.map((f, slot) => {
    const cur = byId.get(s.lineup[slot]);
    const options = [...s.squad]
      .sort((a, b) => ratingAs(b, f.role) - ratingAs(a, f.role))
      .map((p) => `<option value="${p.id}"${p.id === cur?.id ? ' selected' : ''}>${esc(`${p.last} · ${ratingAs(p, f.role)}${p.role !== f.role ? ` (${p.role})` : ''}`)}</option>`)
      .join('');
    return `<div class="slot" style="--x:${f.x * 100}%;--y:${f.y * 100}%">
      <span class="magnet">${cur?.number ?? '?'}</span>
      <label class="slot-label"><span class="slot-role">${f.role}</span>
        <select id="slot-${slot}" data-change="slot" data-slot="${slot}">${options}</select>
      </label>
    </div>`;
  }).join('');
  return `
  <div class="squad-grid">
    ${academyPanel(app)}
    <article class="panel board">
      <div class="board-head"><h2 class="eyebrow">Lineup · 1-2-2-1 · attacking <span aria-hidden="true">→</span><span class="sr-only">to the right</span></h2><div class="strength">XI strength <b>${teamStrength(s.squad, s.lineup)}</b></div></div>
      <div class="mini-pitch">${slots}</div>
      <div class="actions"><button class="btn" data-action="auto-lineup">Pick my best six</button><span class="muted small">Ratings shown are for that slot. Out-of-position players lose a lot.</span></div>
    </article>
    <article class="panel">
      <h2 class="eyebrow">Squad · ${s.squad.length}/${MAX_SQUAD}</h2>
      <div class="table-scroll"><table class="tbl">
        <thead><tr><th class="num">#</th><th>Name</th><th>Nation</th><th class="num">Age</th><th>Pos</th><th class="num">OVR</th><th class="num">POT</th>${attrHead}<th class="num">Value</th></tr></thead>
        <tbody>${[...s.squad].sort((a, b) => FORMATION.findIndex((f) => f.role === a.role) - FORMATION.findIndex((f) => f.role === b.role) || overall(b) - overall(a)).map((p) => playerRow(p, `<td class="num">${formatMoney(marketValue(p))}</td>`, s.lineup.includes(p.id))).join('')}</tbody>
      </table></div>
    </article>
  </div>`;
}

// ---------------------------------------------------------------------------

export function transfersScreen(app: App): string {
  const s = app.save;
  const roles: (Role | 'ALL')[] = ['ALL', 'GK', 'DEF', 'MID', 'FWD'];
  const market = s.market.filter((p) => app.marketRole === 'ALL' || p.role === app.marketRole);
  const full = s.squad.length >= MAX_SQUAD;
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
      <p class="muted small">Budget ${formatMoney(s.budget)}${full ? ` · squad full (${MAX_SQUAD}), sell before you sign` : ''}. Player-to-player trading arrives with accounts; see the roadmap.</p>
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
  const outcome = r.gf > r.ga ? 'Win' : r.gf === r.ga ? 'Draw' : 'Defeat';
  const d = r.eloAfter - r.eloBefore;
  const stat = (label: string, a: number | string, b: number | string) => `<div class="stat"><span class="num">${a}</span><span class="stat-label">${label}</span><span class="num">${b}</span></div>`;
  return `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="result-title">
    <div class="modal-card">
      <div class="eyebrow">${esc(r.label ?? (r.ranked ? 'Ranked' : 'Friendly'))} · full-time${r.forfeited ? ' · forfeited' : ''}</div>
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
      </ul>` : '<p class="muted">Nothing recorded for an abandoned friendly.</p>'}
      ${resultReplayHtml()}
      <button class="btn primary big" data-action="close-result">Back to the club</button>
    </div>
  </div>`;
}
