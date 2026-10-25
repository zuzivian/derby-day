// Competitions screen: the cup bracket, the league table and fixtures, and
// "play next match", which launches the normal live match via playLive().
// The rules live in src/meta/competitions.ts; this file only renders and wires.

import { autoLineup, cpuTeam, ladderSquad, type LadderClub } from '../meta/club.ts';
import {
  canStart,
  clubById,
  clubStrength,
  closeCup,
  closeSeason,
  COMP_SIZE,
  CUP_PRIZES,
  CUP_GUESTS,
  CUP_ROUNDS,
  cupOpponent,
  cupWaitLeft,
  cupWaitText,
  ensureCompetitionFields,
  isOut,
  ordinal,
  prizeIn,
  recordCupMatch,
  recordSeasonMatch,
  SEASON_PRIZES,
  seasonOpponent,
  seasonTable,
  seasonVerdict,
  simulateRestOfCup,
  startCup,
  startSeason,
  yourFixture,
  yourTie,
  type CompOutcome,
  type Cup,
  type HumanPens,
  type Season,
  type Tie,
} from '../meta/competitions.ts';
import { formatMoney, signed, type Save } from '../meta/game.ts';
import { isUnlocked, unlockLevel, unlockOf } from '../meta/levels.ts';
import { maybeRollover } from '../meta/progression.ts';
import type { PendingMatch } from '../meta/pending.ts';
import { DIVISIONS, divisionName, playerDivision } from '../meta/world.ts';
import { penaltySide } from '../meta/shootout.ts';
import type { CrestPattern } from '../meta/names.ts';
import { possessionShare } from '../sim/match.ts';
import { hashString } from '../sim/rng.ts';
import type { MatchState, TeamSetup } from '../sim/types.ts';
import { crestSvg } from './crest.ts';
import type { ShootoutResult, ShootoutViewOptions } from './shootout.ts';
import { esc, type App } from './ui.ts';

export interface CompContext {
  app: App;
  toast: (text: string, ok?: boolean) => void;
  persist: () => void;
  render: () => void;
  playLive: (opponent: TeamSetup, crest: CrestPattern, label: string, onDone: (m: MatchState, forfeited: boolean, away: TeamSetup) => void, forfeitText?: string, pending?: PendingMatch) => boolean;
  /** Mount the live penalty shootout (blocking re-renders while it runs) and hand back its result. */
  playShootout: (opts: Omit<ShootoutViewOptions, 'onEnd'>, onDone: (r: ShootoutResult) => void) => void;
}

const ROUND_PLURAL = ['Quarter-finals', 'Semi-finals', 'Final'];

const CUP_ICON = `<svg class="trophy-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M7 3h10v3h3v2a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 14.9V18h3v3H8v-3h3v-3.1A5 5 0 0 1 8.3 12H8a4 4 0 0 1-4-4V6h3V3Zm0 5H6a2 2 0 0 0 1 1.7V8Zm10 0v1.7A2 2 0 0 0 18 8h-1Z" fill="currentColor"/></svg>`;
const SHIELD_ICON = `<svg class="trophy-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 5 1.5 3.1 3.4.5-2.5 2.4.6 3.4L12 14.8 9 16.4l.6-3.4-2.5-2.4 3.4-.5L12 7Z" fill="currentColor"/></svg>`;

// ---------------------------------------------------------------------------
// Rendering

export function competitionsScreen(app: App): string {
  const s = app.save;
  ensureCompetitionFields(s);
  // Each competition shows once its club-level unlock is reached (or it is already in use).
  const cupOn = isUnlocked(s, 'cup');
  const leagueOn = isUnlocked(s, 'league');
  // Idle competitions are small cards side by side; a running one takes the full width.
  const idle = [cupOn && !s.cup ? cupPanel(s) : '', leagueOn && !s.season ? seasonPanel(s) : ''].filter(Boolean);
  const locked = [cupOn ? null : unlockOf('cup'), leagueOn ? null : unlockOf('league')].filter((u) => !!u);
  return `
  <div class="comp-grid">
    ${s.cup ? cupPanel(s) : ''}
    ${s.season ? seasonPanel(s) : ''}
    ${idle.length ? `<div class="comp-top">${idle.join('')}</div>` : ''}
    ${locked.length ? `<p class="muted small comp-locked">${locked.map((u) => `${u!.name} opens at club level ${unlockLevel(s, u!.id)}.`).join(' ')}</p>` : ''}
    ${cabinet(s)}
  </div>`;
}

function kit(c: { primary: string; secondary: string }): string {
  return `<span class="kit" style="--p:${esc(c.primary)};--s:${esc(c.secondary)}" aria-hidden="true"></span>`;
}

function cabinet(s: Save): string {
  const t = s.trophies ?? [];
  return `
  <article class="panel comp-cabinet" aria-labelledby="cabinet-title">
    <h2 id="cabinet-title" class="eyebrow">Trophy cabinet</h2>
    ${t.length
      ? `<ul class="trophies">${t.map((x) => `<li class="trophy trophy-${x.kind}">${x.kind === 'cup' ? CUP_ICON : SHIELD_ICON}<span>${esc(x.title)}</span></li>`).join('')}</ul>`
      : `<p class="muted">Empty for now. Win the cup or the league to put something in it.</p>`}
    <p class="muted small">Cup and league matches pay prize money and an extra training session, and move your Elo (not your ladder record). Forfeiting counts as a 0–3 defeat.</p>
  </article>`;
}

/** The "next match" strip shared by both panels. */
function nextMatch(s: Save, opp: LadderClub, label: string, kind: 'cup' | 'season', home: boolean): string {
  const ours = clubStrength(s, s.club.id);
  const theirs = clubStrength(s, opp.id);
  const left = { c: s.club, n: s.club.name, x: ours };
  const right = { c: opp, n: opp.name, x: theirs };
  const [a, b] = home ? [left, right] : [right, left];
  return `
    <div class="comp-next">
      <div class="comp-next-label eyebrow">Next: ${esc(label)} · ${home ? 'home' : 'away'}</div>
      <div class="comp-versus">
        <div class="side">${crestSvg(a.c, 44)}<div class="comp-side-name">${esc(a.n)}</div><div class="side-elo">XI ${a.x}</div></div>
        <div class="vs" aria-hidden="true">vs</div>
        <div class="side">${crestSvg(b.c, 44)}<div class="comp-side-name">${esc(b.n)}</div><div class="side-elo">XI ${b.x}</div></div>
      </div>
      <button class="btn primary big" data-action="comp-play" data-kind="${kind}">Play ${esc(label.toLowerCase())}</button>
    </div>`;
}

// --- Cup ---------------------------------------------------------------------

function cupPanel(s: Save): string {
  const cup = s.cup;
  if (!cup) {
    const d = playerDivision(s);
    const wait = cupWaitLeft(s);
    const field = d > 1 ? `Clubs from ${divisionName(d)} near your Elo and ${CUP_GUESTS} from ${divisionName(d - 1)}` : `The clubs of ${divisionName(1)}`;
    return `
    <article class="panel comp-panel" aria-labelledby="cup-title">
      <div class="board-head"><h2 id="cup-title" class="comp-title">The Cup</h2><span class="eyebrow">Knockout · ${COMP_SIZE} clubs · ${divisionName(d)} prizes</span></div>
      <p>${field}, seeded by Elo. Quarter-final, semi-final, final. One match a round; a draw goes to penalties.</p>
      <dl class="facts comp-prizes">
        <div><dt>Quarter-final</dt><dd>${formatMoney(prizeIn(CUP_PRIZES[0], d))}</dd></div>
        <div><dt>Semi-final</dt><dd>+${formatMoney(prizeIn(CUP_PRIZES[1], d))}</dd></div>
        <div><dt>Final</dt><dd>+${formatMoney(prizeIn(CUP_PRIZES[2], d))}</dd></div>
        <div><dt>Winner</dt><dd>+${formatMoney(prizeIn(CUP_PRIZES[3], d))}</dd></div>
      </dl>
      ${wait
        ? `<p class="muted small" id="comp-cup-wait" role="status">${esc(cupWaitText(wait))}</p>`
        : `<div class="actions"><button class="btn primary big" data-action="comp-start-cup">Start the cup</button></div>`}
    </article>`;
  }
  const tie = yourTie(s, cup);
  const opp = cupOpponent(s, cup);
  const out = isOut(s, cup);
  let status: string;
  if (tie && opp) status = nextMatch(s, opp, `Cup ${CUP_ROUNDS[cup.round].toLowerCase()}`, 'cup', tie.a === s.club.id);
  else if (cup.done) {
    const won = cup.winner === s.club.id;
    status = `<div class="comp-status ${won ? 'good' : ''}" role="status"><b>${won ? 'Cup winners!' : `${esc(clubById(s, cup.winner!)?.name ?? '')} won the cup.`}</b> You earned ${formatMoney(cup.earned)}.</div>
      <div class="actions"><button class="btn primary" data-action="comp-close" data-kind="cup">Done: clear the bracket</button></div>`;
  } else {
    status = `<div class="comp-status" role="status">${out ? 'You are out of the cup.' : ''} The other ties are still to play.</div>
      <div class="actions"><button class="btn primary" data-action="comp-sim-cup">Simulate the rest of the cup</button></div>`;
  }
  return `
  <article class="panel comp-panel" aria-labelledby="cup-title">
    <div class="board-head"><h2 id="cup-title" class="comp-title">Cup ${cup.edition}</h2><span class="eyebrow">${cup.done ? 'Finished' : esc(CUP_ROUNDS[cup.round])}${cup.earned ? ` · earned <span class="money">${formatMoney(cup.earned)}</span>` : ''}</span></div>
    ${status}
    ${bracket(s, cup)}
  </article>`;
}

function bracket(s: Save, cup: Cup): string {
  const cols = CUP_ROUNDS.map((_, r) => {
    const ties = cup.rounds[r].length ? cup.rounds[r] : placeholderTies(r);
    return `<section class="round" aria-labelledby="round-${r}">
      <h3 id="round-${r}" class="round-title">${ROUND_PLURAL[r]}</h3>
      <ol class="ties">${ties.map((t, k) => tieCard(s, t, r, k)).join('')}</ol>
    </section>`;
  });
  return `<div class="bracket">${cols.join('')}</div>`;
}

const placeholderTies = (r: number): Tie[] => Array.from({ length: [4, 2, 1][r] }, () => ({ a: '', b: '' }));

function tieCard(s: Save, t: Tie, round: number, k: number): string {
  const played = t.winner !== undefined;
  const row = (id: string, goals: number | undefined, pens: number | undefined, from: string) => {
    if (!id) return `<div class="tie-row tbc"><span class="tie-name">${from}</span></div>`;
    const c = clubById(s, id);
    const you = id === s.club.id;
    const win = played && t.winner === id;
    return `<div class="tie-row${win ? ' win' : ''}${played && !win ? ' lose' : ''}${you ? ' you' : ''}">
      ${c ? kit(c) : ''}<span class="tie-name">${esc(c?.name ?? '?')}${you ? ' <span class="pill">you</span>' : ''}</span>
      <span class="tie-score">${goals ?? ''}${pens !== undefined ? `<small> (${pens})</small>` : ''}</span>
    </div>`;
  };
  const prev = ROUND_PLURAL[round - 1]?.replace(/s$/, '') ?? '';
  const fromA = round ? `Winner ${prev} ${k * 2 + 1}` : 'TBC';
  const fromB = round ? `Winner ${prev} ${k * 2 + 2}` : 'TBC';
  const label = t.a && t.b
    ? `${clubById(s, t.a)?.name} ${played ? `${t.ga}–${t.gb}${t.pens ? `, ${t.pens[0]}–${t.pens[1]} on penalties` : ''}` : 'versus'} ${clubById(s, t.b)?.name}`
    : 'To be decided';
  return `<li class="tie${t.a === s.club.id || t.b === s.club.id ? ' mine' : ''}" aria-label="${esc(label)}">
    ${row(t.a, t.ga, t.pens?.[0], fromA)}
    ${row(t.b, t.gb, t.pens?.[1], fromB)}
    ${t.pens ? `<div class="tie-note">on penalties</div>` : ''}
  </li>`;
}

// --- Season ------------------------------------------------------------------

function seasonPanel(s: Save): string {
  const season = s.season;
  if (!season) {
    const d = playerDivision(s);
    const moves = [d > 1 ? `the top two go up to ${divisionName(d - 1)}` : 'the champions are the best club in the land', d < DIVISIONS ? `the bottom two go down to ${divisionName(d + 1)}` : ''].filter(Boolean).join('; ');
    return `
    <article class="panel comp-panel" aria-labelledby="season-title">
      <div class="board-head"><h2 id="season-title" class="comp-title">The League</h2><span class="eyebrow">${divisionName(d)} · ${COMP_SIZE} clubs · ${COMP_SIZE - 1} matchdays</span></div>
      <p>Play the rest of ${divisionName(d)} once. Three points for a win, one for a draw; goal difference, then goals scored, split ties. ${moves[0].toUpperCase()}${moves.slice(1)}. Prize money for every place, paid for the matchdays you play.</p>
      <dl class="facts comp-prizes">
        <div><dt>Champions</dt><dd>${formatMoney(prizeIn(SEASON_PRIZES[0], d))}</dd></div>
        <div><dt>2nd</dt><dd>${formatMoney(prizeIn(SEASON_PRIZES[1], d))}</dd></div>
        <div><dt>3rd</dt><dd>${formatMoney(prizeIn(SEASON_PRIZES[2], d))}</dd></div>
        <div><dt>8th</dt><dd>${formatMoney(prizeIn(SEASON_PRIZES[7], d))}</dd></div>
      </dl>
      <div class="actions"><button class="btn primary big" id="comp-start-season" data-action="comp-start-season">Start a season</button></div>
    </article>`;
  }
  const f = yourFixture(s, season);
  const opp = seasonOpponent(s, season);
  const days = season.matchdays.length;
  let status: string;
  if (f && opp) status = nextMatch(s, opp, `Matchday ${season.matchday + 1}`, 'season', f.home === s.club.id);
  else {
    const pos = season.finish ?? 0;
    status = `<div class="comp-status ${pos <= 2 ? 'good' : pos >= 7 ? 'bad' : ''}" role="status"><b>Finished ${ordinal(pos)}.</b> ${esc(seasonVerdict(pos, season.division ?? DIVISIONS, season.moved ?? null, season.forfeits ?? 0))} You earned ${formatMoney(season.earned)}.</div>
      <div class="actions"><button class="btn primary" data-action="comp-close" data-kind="season">Done: clear the table</button></div>`;
  }
  return `
  <article class="panel comp-panel" aria-labelledby="season-title">
    <div class="board-head"><h2 id="season-title" class="comp-title">League ${season.edition}</h2><span class="eyebrow">${divisionName(season.division ?? DIVISIONS)} · ${season.done ? 'Finished' : `Matchday ${season.matchday + 1} of ${days}`}</span></div>
    ${status}
    <div class="league-body">
      <div>${leagueTable(s, season)}</div>
      <div><h3 class="round-title">Fixtures</h3>${fixtureList(s, season)}</div>
    </div>
  </article>`;
}

function leagueTable(s: Save, season: Season): string {
  const rows = seasonTable(s, season);
  const started = rows.some((r) => r.played > 0);
  const d = season.division ?? DIVISIONS;
  const up = d > 1;
  const down = d < DIVISIONS;
  return `<div class="table-scroll"><table class="tbl league-table">
    <caption class="visually-hidden">League ${season.edition} table</caption>
    <thead><tr>
      <th scope="col" class="num"><abbr title="Position">Pos</abbr></th><th scope="col">Club</th>
      <th scope="col" class="num"><abbr title="Played">P</abbr></th><th scope="col" class="num"><abbr title="Won">W</abbr></th>
      <th scope="col" class="num"><abbr title="Drawn">D</abbr></th><th scope="col" class="num"><abbr title="Lost">L</abbr></th>
      <th scope="col" class="num opt"><abbr title="Goals for">GF</abbr></th><th scope="col" class="num opt"><abbr title="Goals against">GA</abbr></th>
      <th scope="col" class="num"><abbr title="Goal difference">GD</abbr></th><th scope="col" class="num"><abbr title="Points">Pts</abbr></th>
    </tr></thead>
    <tbody>${rows
      .map((r, i) => `<tr class="${r.you ? 'you' : ''}${!started ? '' : up && i < 2 ? ' zone-up' : down && i >= rows.length - 2 ? ' zone-down' : ''}">
        <td class="num">${i + 1}</td>
        <th scope="row" class="name">${kit(r)}${esc(r.name)}${r.you ? ' <span class="pill" aria-hidden="true">you</span><span class="visually-hidden"> (your club)</span>' : ''}</th>
        <td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.drawn}</td><td class="num">${r.lost}</td>
        <td class="num opt">${r.gf}</td><td class="num opt">${r.ga}</td><td class="num">${r.gd ? signed(r.gd) : '0'}</td><td class="num ovr">${r.points}</td>
      </tr>`)
      .join('')}</tbody>
  </table></div>
  ${up || down ? `<p class="muted small league-key">${up ? `<span class="key key-up" aria-hidden="true"></span>Promotion to ${divisionName(d - 1)} ` : ''}${down ? `<span class="key key-down" aria-hidden="true"></span>Relegation to ${divisionName(d + 1)}` : ''}</p>` : ''}`;
}

/** Three-letter codes for the fixture grid, made unique when two clubs share a short name. */
function fixtureCodes(s: Save, ids: string[]): Map<string, string> {
  const codes = new Map<string, string>();
  const used = new Set<string>();
  const shorts = ids.map((id) => clubById(s, id)?.short ?? '???');
  ids.forEach((id, k) => {
    const name = clubById(s, id)?.name ?? '';
    const clash = shorts.filter((x) => x === shorts[k]).length > 1;
    let code = clash ? name.replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase() : shorts[k];
    for (let n = 2; used.has(code); n++) code = `${code.slice(0, 2)}${n}`;
    used.add(code);
    codes.set(id, code);
  });
  return codes;
}

function fixtureList(s: Save, season: Season): string {
  const codes = fixtureCodes(s, season.entrants);
  const nameOf = (id: string) => codes.get(id) ?? '?';
  return `<div class="matchdays">${season.matchdays
    .map((day, d) => {
      const current = !season.done && d === season.matchday;
      return `<section class="matchday${current ? ' current' : ''}" aria-labelledby="md-${d}">
        <h3 id="md-${d}" class="round-title">Matchday ${d + 1}${current ? '<span class="visually-hidden"> (next)</span>' : ''}</h3>
        <ul class="fixtures">${day
          .map((f) => {
            const mine = f.home === s.club.id || f.away === s.club.id;
            const score = f.hg !== undefined ? `${f.hg}–${f.ag}` : 'v';
            const full = `${clubById(s, f.home)?.name} ${f.hg !== undefined ? `${f.hg}–${f.ag}` : 'versus'} ${clubById(s, f.away)?.name}`;
            return `<li class="fx${mine ? ' mine' : ''}" aria-label="${esc(full)}"><span class="fx-team">${esc(nameOf(f.home))}</span><span class="fx-score">${score}</span><span class="fx-team away">${esc(nameOf(f.away))}</span></li>`;
          })
          .join('')}</ul>
      </section>`;
    })
    .join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Actions

/** Handle a `comp-*` click. Returns true when the caller should re-render. */
export function competitionAction(action: string, el: HTMLElement, ctx: CompContext): boolean {
  const s = ctx.app.save;
  ensureCompetitionFields(s);
  switch (action) {
    case 'comp-start-cup': {
      if (!isUnlocked(s, 'cup')) return false;
      const ok = canStart(s, 'cup');
      if (!ok.ok) return ctx.toast(ok.message, false), true;
      const cup = startCup(s);
      ctx.persist();
      ctx.toast(`Cup ${cup.edition}: ${cupOpponent(s, cup)?.name ?? 'TBC'} in the quarter-final.`);
      return true;
    }
    case 'comp-start-season': {
      if (!isUnlocked(s, 'league')) return false;
      const ok = canStart(s);
      if (!ok.ok) return ctx.toast(ok.message, false), true;
      const season = startSeason(s);
      ctx.persist();
      ctx.toast(`League ${season.edition}: ${seasonOpponent(s, season)?.name ?? 'TBC'} on matchday 1.`);
      return true;
    }
    case 'comp-play':
      return !playCompetitionMatch(el.dataset.kind === 'season' ? 'season' : 'cup', ctx);
    case 'comp-sim-cup':
      simulateRestOfCup(s);
      ctx.persist();
      return true;
    case 'comp-close':
      if (el.dataset.kind === 'season') closeSeason(s);
      else closeCup(s);
      ctx.persist();
      return true;
    default:
      return false;
  }
}

/** Launch your next cup tie or league fixture live. Returns true if a match started. */
function playCompetitionMatch(kind: 'cup' | 'season', ctx: CompContext): boolean {
  const s = ctx.app.save;
  const opp = kind === 'cup' ? (s.cup ? cupOpponent(s, s.cup) : null) : s.season ? seasonOpponent(s, s.season) : null;
  if (!opp) {
    ctx.toast('No match to play right now.', false);
    return false;
  }
  const label = kind === 'cup' ? `Cup ${CUP_ROUNDS[s.cup!.round].toLowerCase()}` : `League matchday ${s.season!.matchday + 1}`;
  const squad = ladderSquad(opp);
  const away = cpuTeam(opp, squad);
  const oppCrest = opp.crest;
  return ctx.playLive(away, opp.crest, label, (m, forfeited, shown) => {
    let [gf, ga] = m.score;
    if (forfeited) [gf, ga] = [0, Math.max(3, ga)];
    // A drawn cup tie you played goes to a live shootout; the result feeds the bracket.
    if (kind === 'cup' && !forfeited && gf === ga) {
      ctx.playShootout(
        {
          seed: hashString(`${s.cup!.seed}:live-pens:${s.cup!.round}`) >>> 1,
          you: penaltySide(s.club.name, s.squad, s.lineup),
          opp: penaltySide(opp.name, squad, autoLineup(squad)),
          youClub: s.club,
          oppClub: opp,
          label,
        },
        (r) => {
          // Walking out of a shootout is a forfeit: recorded 0–3, nothing paid.
          if (r.forfeited) finishMatch(m, true, shown, 0, Math.max(3, ga), undefined);
          else finishMatch(m, false, shown, gf, ga, { you: r.you, opp: r.opp });
        },
      );
      return;
    }
    finishMatch(m, forfeited, shown, gf, ga);
  }, 'Forfeit (counts as 0–3)', { kind: kind === 'cup' ? 'cup' : 'league', opponent: opp.name, label });

  function finishMatch(m: MatchState, forfeited: boolean, shown: TeamSetup, gf: number, ga: number, pens?: HumanPens) {
    // A forfeit is recorded as 0–3, so the goals actually scored before it don't stand.
    const scorersFor = forfeited ? [] : m.goals.filter((e) => e.team === 0).map((e) => `${e.scorer} ${e.minute}'`);
    const scorersAgainst = forfeited ? [] : m.goals.filter((e) => e.team === 1).map((e) => `${e.scorer} ${e.minute}'`);
    const eloBefore = s.club.elo;
    // Quick-simulating the rest of the round happens here (~250 ms).
    const outcome: CompOutcome = kind === 'cup' ? recordCupMatch(s, gf, ga, scorersFor, undefined, forfeited, pens) : recordSeasonMatch(s, gf, ga, scorersFor, undefined, forfeited);
    maybeRollover(s); // after the whole round is recorded, so the CPU ties used this year's squads
    ctx.app.result = {
      ranked: false,
      forfeited,
      gf,
      ga,
      opp: { name: shown.name, short: shown.short, primary: shown.primary, secondary: shown.secondary, crest: oppCrest },
      summary: outcome.summary,
      eloBefore,
      eloAfter: s.club.elo,
      stats: m.stats,
      possession: possessionShare(m),
      scorersFor,
      scorersAgainst,
      label,
      note: outcome.note,
      pens,
    };
    ctx.persist();
    ctx.app.screen = 'competitions';
    ctx.render();
  }
}
