// Home: the first screen. One clear job, kick off the next ranked match
// against the CPU, plus a small set of play-mode cards. Information is shown
// as pictures (crests, a win-chance gauge, W/D/L chips, a sparkline) and every
// picture has a text equivalent. Locked modes are visible teasers with a
// padlock and the level that opens them; they are not controls.
//
// As the club levels up the screen gains one thing at a time: Practice (level
// 4), vs Player (5), the Hard practice button and the Cup card (7) and the
// League card (8). At level 1 it is the hero and its Kick off, nothing else.
// Everything secondary (news, replays, club level details, tutorial, reset)
// lives on the Club tab (clubScreen in ui.ts). Styles: the "Home" section of
// styles.css.

import { CUP_ROUNDS, cupOpponent, seasonOpponent } from '../meta/competitions.ts';
import { expectedScore, kFactor } from '../meta/elo.ts';
import type { Save } from '../meta/game.ts';
import { isUnlocked, unlockLevel, type UnlockId } from '../meta/levels.ts';
import { rankedOpen, showGauge, warmupIdentity } from '../meta/warmup.ts';
import { relayConfig } from '../net/config.ts';
import { HALF_SECONDS } from '../sim/constants.ts';
import { crestSvg } from './crest.ts';
import { esc, PRACTICE, practiceUnlocked, type App } from './ui.ts';

/** The one standard match length, for labels: "2 × 3 min". */
export const MATCH_LENGTH = `2 × ${Math.round(HALF_SECONDS / 60)} min`;
const MATCH_LENGTH_SPOKEN = `two halves of ${Math.round(HALF_SECONDS / 60)} minutes`;

// ---------------------------------------------------------------------------
// Icons (decorative: aria-hidden, the text next to them carries the meaning)

const svg = (body: string, size = 28, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${body}</svg>`;

const ICON = {
  ball: (size = 26) =>
    svg(
      '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.2 15.6 9.8 14.2 14H9.8L8.4 9.8Z" fill="currentColor"/><path d="M12 7.2V2.6M15.6 9.8l4.3-1.6M14.2 14l2.7 3.8M9.8 14l-2.7 3.8M8.4 9.8 4.1 8.2" stroke="currentColor" stroke-width="1.6" fill="none"/>',
      size,
    ),
  cpu: svg('<rect x="5" y="6" width="14" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9.5" cy="12" r="1.6" fill="currentColor"/><circle cx="14.5" cy="12" r="1.6" fill="currentColor"/><path d="M12 2.5V6M3 11v3M21 11v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 22),
  players: svg(
    '<circle cx="8" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.5" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 20c0-3.6 2.4-6 5.5-6s5.5 2.4 5.5 6M11.5 15.2c1.2-.8 3-1.2 5-1.2 3.1 0 5 2.4 5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    34,
  ),
  cone: svg('<path d="M9.6 4h4.8l4.4 14H5.2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8.3 9.5h7.4M7 14h10" stroke="currentColor" stroke-width="2"/><path d="M3 20.5h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 34),
  cup: svg('<path d="M7 3h10v3h3v2a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 14.9V18h3v3H8v-3h3v-3.1A5 5 0 0 1 8.3 12H8a4 4 0 0 1-4-4V6h3V3Zm0 5H6a2 2 0 0 0 1 1.7V8Zm10 0v1.7A2 2 0 0 0 18 8h-1Z" fill="currentColor"/>', 34),
  league: svg('<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 5 1.5 3.1 3.4.5-2.5 2.4.6 3.4L12 14.8 9 16.4l.6-3.4-2.5-2.4 3.4-.5L12 7Z" fill="currentColor"/>', 34),
  lock: (size = 16) => svg('<rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2"/>', size, 'icon lock'),
  keys: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 10h1.5M10 10h1.5M14 10h1.5M18 10h.1M7.5 14h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 20),
  globe: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" fill="none" stroke="currentColor" stroke-width="2"/>', 20),
  tabs: svg('<rect x="2.5" y="5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="10.5" y="10" width="11" height="9" rx="1.5" fill="var(--surface)" stroke="currentColor" stroke-width="2"/>', 20),
  arrow: svg('<path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>', 18),
};

/** Difficulty as one to three bars, like a signal meter. */
const bars = (n: number) =>
  `<svg class="icon bars" viewBox="0 0 18 14" width="18" height="14" aria-hidden="true" focusable="false">${[0, 1, 2]
    .map((i) => `<rect x="${i * 6 + 1}" y="${10 - i * 4}" width="4" height="${4 + i * 4}" rx="1" class="${i < n ? 'on' : 'off'}"/>`)
    .join('')}</svg>`;

// ---------------------------------------------------------------------------
// Visual pieces

type Res = 'W' | 'D' | 'L';
const RES_WORD: Record<Res, string> = { W: 'win', D: 'draw', L: 'defeat' };

/** Last five results as coloured chips, oldest first; empty slots are dashed. */
function formChips(s: Save): string {
  const last = s.history.slice(-5).map((m): Res => (m.goalsFor > m.goalsAgainst ? 'W' : m.goalsFor === m.goalsAgainst ? 'D' : 'L'));
  const label = last.length ? `Recent form, oldest first: ${last.map((r) => RES_WORD[r]).join(', ')}` : 'No matches played yet';
  const slots = [...last, ...Array<Res | null>(5 - last.length).fill(null)];
  if (!last.length) return `<div class="form-strip is-empty" role="img" aria-label="${label}"><span class="form-empty" aria-hidden="true">First match awaits</span></div>`;
  return `<div class="form-strip" role="img" aria-label="${label}">${slots
    .map((r) => (r ? `<span class="form-chip res-${r}" aria-hidden="true">${r}</span>` : `<span class="form-chip empty" aria-hidden="true"></span>`))
    .join('')}</div>`;
}

/** A small Elo sparkline, only once there is some history to draw. */
function miniSpark(values: number[]): string {
  if (values.length < 2) return '';
  const pts = values.slice(-12);
  const w = 72;
  const h = 22;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = Math.max(1, hi - lo);
  const x = (i: number) => 2 + (i / (pts.length - 1)) * (w - 4);
  const y = (v: number) => h - 3 - ((v - lo) / span) * (h - 6);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const first = pts[0];
  const last = pts[pts.length - 1];
  const trend = last > first ? `up ${last - first}` : last < first ? `down ${first - last}` : 'level';
  return `<svg class="mini-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Elo over the last ${pts.length - 1} ranked matches: ${trend}, now ${last}">
    <polyline points="${line}"/><circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.6"/></svg>`;
}

/** Half-ring gauge for the win chance (Elo expected score), 0 to 100. */
function gauge(pct: number): string {
  // A 180° arc; pathLength 100 makes the dash length the percentage.
  return `<div class="gauge" role="img" aria-label="Win chance ${pct}%">
    <svg viewBox="0 0 120 68" aria-hidden="true" focusable="false">
      <path class="gauge-track" d="M10 62 A50 50 0 0 1 110 62" pathLength="100"/>
      <path class="gauge-fill" d="M10 62 A50 50 0 0 1 110 62" pathLength="100" stroke-dasharray="${pct} 100"/>
    </svg>
    <div class="gauge-text" aria-hidden="true"><span class="gauge-num">${pct}<small>%</small></span><span class="gauge-label">win chance</span></div>
  </div>`;
}

const lockBadge = (level: number) => `<span class="lock-badge" aria-hidden="true">${ICON.lock(13)}<b>${level}</b></span>`;

// ---------------------------------------------------------------------------
// The hero: vs CPU, ranked, the next opponent

function hero(app: App): string {
  const s = app.save;
  const c = s.club;
  // Until ranked opens (level 3) Kick off is a warm-up friendly against a gentle generated club: no Elo, no gauge.
  const ranked = rankedOpen(s);
  const opp = ranked ? app.nextOpp : warmupIdentity(s);
  const gaugeOn = ranked && showGauge(s);
  const p = ranked ? expectedScore(c.elo, app.nextOpp.elo) : 0.5;
  const pct = Math.round(p * 100);
  const k = kFactor(c.played);
  const gain = Math.round(k * (1 - p));
  const cost = Math.round(k * p);
  const tag = ranked ? 'Ranked' : 'Warm-up friendly';
  const kind = ranked ? 'Ranked match' : 'Warm-up friendly, no Elo';
  return `
  <section class="hero" data-mode="cpu" aria-labelledby="hero-title">
    <div class="hero-head">
      <h2 id="hero-title" class="hero-title">${ICON.cpu}<span>vs CPU</span><span class="hero-tag">${tag}</span></h2>
      <span class="hero-len"><span aria-hidden="true">${MATCH_LENGTH}</span><span class="sr-only">Match length: ${MATCH_LENGTH_SPOKEN}</span></span>
    </div>
    <div class="hero-match">
      <div class="hero-side">
        ${crestSvg(c, 84)}
        <div class="hero-name">${esc(c.name)}</div>
        <div class="hero-elo"><span>Elo <b>${c.elo}</b></span>${miniSpark(s.eloHistory)}</div>
        ${formChips(s)}
      </div>
      <div class="hero-mid">
        ${gaugeOn ? `${gauge(pct)}
        <div class="stakes" role="img" aria-label="Win: plus ${gain} Elo. Defeat: minus ${cost} Elo.">
          <span class="stake up" aria-hidden="true">▲ ${gain}</span><span class="stake down" aria-hidden="true">▼ ${cost}</span>
        </div>` : `<div class="hero-vs" aria-hidden="true">vs</div>`}
      </div>
      <div class="hero-side">
        ${crestSvg(opp, 84)}
        <div class="hero-name">${esc(opp.name)}</div>
        <div class="hero-elo">${ranked ? `<span>Elo <b>${app.nextOpp.elo}</b></span>` : '<span>Friendly</span>'}</div>
      </div>
    </div>
    <p id="hero-desc" class="sr-only">${kind} against ${esc(opp.name)}, ${MATCH_LENGTH_SPOKEN}.${gaugeOn ? ` Win chance ${pct}%.` : ''}</p>
    <button class="kickoff" id="kick-off" data-action="${ranked ? 'play-ranked' : 'play-warmup'}" aria-describedby="hero-desc">${ICON.ball(30)}<span>Kick off</span></button>
  </section>`;
}

// ---------------------------------------------------------------------------
// Mode cards

function versusCard(s: Save): string {
  const local = isUnlocked(s, 'local2p');
  const link = isUnlocked(s, 'link');
  if (!local && !link) return isUnlocked(s, 'practice') ? lockedCard(s, 'player', 'vs Player', ICON.players, 'local2p') : '';
  return `
  <article class="mode-card" data-mode="player" aria-labelledby="mode-player">
    <div class="mode-top"><span class="mode-icon">${ICON.players}</span><div><h3 id="mode-player" class="mode-title">vs Player</h3><p class="mode-sub">Friendly · no Elo</p></div></div>
    <div class="mode-actions">
      ${local ? `<button class="mode-btn" id="play-local2p" data-action="play-local2p" aria-label="vs Player on one screen: Local 2P">${ICON.keys}<span>One screen</span></button>` : ''}
      ${link ? `<button class="mode-btn" id="play-link" data-action="play-link" aria-label="vs Player in two browser tabs: Link two tabs">${ICON.tabs}<span>Two tabs</span></button>` : ''}
      ${link && relayConfig() ? `<button class="mode-btn" id="play-online" data-action="play-online" style="flex-basis: 100%" aria-label="vs Player online: invite a friend">${ICON.globe}<span>Online</span></button>` : ''}
    </div>
  </article>`;
}

const PRACTICE_UNLOCK: Record<string, UnlockId> = { easy: 'practice', normal: 'practice-normal', hard: 'practice-hard' };

function practiceCard(s: Save): string {
  if (!isUnlocked(s, 'practice')) return '';
  return `
  <article class="mode-card" data-mode="practice" aria-labelledby="mode-practice">
    <div class="mode-top"><span class="mode-icon">${ICON.cone}</span><div><h3 id="mode-practice" class="mode-title">Practice</h3><p class="mode-sub">vs CPU · no Elo</p></div></div>
    <div class="mode-actions diff" role="group" aria-label="CPU difficulty: each button starts a practice match">
      ${PRACTICE.map((x, i) =>
        practiceUnlocked(s, x.id)
          ? `<button class="mode-btn diff-btn" id="practice-${x.id}" data-action="play-practice" data-level="${x.id}" aria-label="Practice against ${x.label} CPU">${bars(i + 1)}<span>${x.label}</span></button>`
          : `<span class="mode-btn diff-btn is-locked">${ICON.lock(14)}<span aria-hidden="true">${x.label}</span><b class="lvl" aria-hidden="true">${unlockLevel(s, PRACTICE_UNLOCK[x.id])}</b><span class="sr-only">${x.label}: unlocks at club level ${unlockLevel(s, PRACTICE_UNLOCK[x.id])}</span></span>`,
      ).join('')}
    </div>
  </article>`;
}

/** A visible teaser for a mode that is still locked: padlock and level badge, no control inside. */
function lockedCard(s: Save, mode: string, title: string, icon: string, id: UnlockId): string {
  const level = unlockLevel(s, id);
  return `
  <article class="mode-card locked" data-mode="${mode}" data-locked-level="${level}" aria-labelledby="mode-${mode}">
    <div class="mode-top"><span class="mode-icon">${icon}${lockBadge(level)}</span><div><h3 id="mode-${mode}" class="mode-title">${title}</h3><p class="mode-sub"><span aria-hidden="true">Level ${level}</span><span class="sr-only">Locked. Unlocks at club level ${level}.</span></p></div></div>
  </article>`;
}

function cupCard(s: Save): string {
  if (!isUnlocked(s, 'cup')) return !isUnlocked(s, 'practice') ? '' : lockedCard(s, 'cup', 'Cup', ICON.cup, 'cup');
  const cup = s.cup;
  const opp = cup && !cup.done ? cupOpponent(s, cup) : null;
  const action = opp
    ? `<button class="mode-btn primary" data-action="comp-play" data-kind="cup">${ICON.arrow}<span>Play ${esc(CUP_ROUNDS[cup!.round].toLowerCase())}</span></button>`
    : `<button class="mode-btn" data-action="go" data-screen="competitions" aria-label="${cup ? 'Open the cup' : 'Enter the cup'}">${ICON.arrow}<span>${cup ? 'Open' : 'Enter'}</span></button>`;
  return `
  <article class="mode-card" data-mode="cup" aria-labelledby="mode-cup">
    <div class="mode-top"><span class="mode-icon">${ICON.cup}</span><div><h3 id="mode-cup" class="mode-title">Cup</h3><p class="mode-sub">${opp ? `vs ${esc(opp.short)}` : 'Knockout · 8 clubs'}</p></div></div>
    <div class="mode-actions">${action}</div>
  </article>`;
}

function leagueCard(s: Save): string {
  if (!isUnlocked(s, 'league')) return !isUnlocked(s, 'practice') ? '' : lockedCard(s, 'league', 'League', ICON.league, 'league');
  const season = s.season;
  const opp = season && !season.done ? seasonOpponent(s, season) : null;
  const action = opp
    ? `<button class="mode-btn primary" data-action="comp-play" data-kind="season">${ICON.arrow}<span>Play matchday ${season!.matchday + 1}</span></button>`
    : `<button class="mode-btn" data-action="go" data-screen="competitions" aria-label="${season ? 'Open the league' : 'Start a league season'}">${ICON.arrow}<span>${season ? 'Open' : 'Start'}</span></button>`;
  return `
  <article class="mode-card" data-mode="league" aria-labelledby="mode-league">
    <div class="mode-top"><span class="mode-icon">${ICON.league}</span><div><h3 id="mode-league" class="mode-title">League</h3><p class="mode-sub">${opp ? `vs ${esc(opp.short)}` : '7 matchdays'}</p></div></div>
    <div class="mode-actions">${action}</div>
  </article>`;
}

export function homeScreen(app: App): string {
  const s = app.save;
  // At level 1 there is only the hero and its Kick off; the other ways to play appear as they unlock.
  const cards = `${versusCard(s)}${practiceCard(s)}${cupCard(s)}${leagueCard(s)}`;
  return `
  <div class="home">
    ${hero(app)}
    ${cards ? `<section class="modes" aria-labelledby="modes-title">
      <h2 id="modes-title" class="sr-only">Other ways to play</h2>
      <div class="mode-grid">${cards}</div>
    </section>` : ''}
  </div>`;
}
