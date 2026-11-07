// Club history panel (Club tab, from the Club history perk at level 24): one
// row per finished season and the club's records. The data is kept by
// src/meta/history.ts, so it outlives the capped match history.

import { signed, type Save } from '../meta/game.ts';
import { isUnlocked } from '../meta/levels.ts';
import { clubBadges, type SeasonSummary } from '../meta/history.ts';
import { divisionName } from '../meta/world.ts';
import { CUP_ICON, EMPTY_ICON, UNSET, emptyState, esc } from './ui.ts';
import { SHIELD_ICON } from './competitions.ts';

export function historyPanel(s: Save): string {
  if (!isUnlocked(s, 'history')) return '';
  const rec = s.records;
  const seasons = [...(s.seasons ?? [])].reverse();
  // A value that is not set yet shows as a muted dash.
  const val = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' || v === 0 ? UNSET : esc(String(v)));
  const marks: [string, string, string][] = rec
    ? [
        ['Played', val(rec.played), rec.played ? `${rec.won}W ${rec.drawn}D ${rec.lost}L · ${rec.gf}–${rec.ga}` : ''],
        ['Best division', val(rec.bestDivision ? divisionName(rec.bestDivision) : null), ''],
        ['Biggest win', val(rec.biggestWin?.text), rec.biggestWin ? `Season ${rec.biggestWin.year}` : ''],
        ['Longest unbeaten', val(rec.longestUnbeaten ? `${rec.longestUnbeaten.value} matches` : null), rec.longestUnbeaten ? `Season ${rec.longestUnbeaten.year}` : ''],
        ['Highest Elo', val(rec.highestElo?.value), rec.highestElo ? `Season ${rec.highestElo.year}` : ''],
        ['Right now', val(rec.winRun > 1 ? `${rec.winRun} wins in a row` : rec.unbeatenRun > 1 ? `${rec.unbeatenRun} unbeaten` : null), ''],
      ]
    : [];
  const season = (x: SeasonSummary) => row(`<b>Season ${x.year}</b> ${esc(divisionName(x.division))} · ${x.won}W ${x.drawn}D ${x.lost}L (${signed(x.gf - x.ga)}) · Elo ${x.eloEnd}${x.notes.length ? `<span class="muted small">${esc(x.notes.join('; '))}</span>` : ''}`);
  const row = (main: string, nums = '') => `<li class="rv-row"><span class="rv-main">${main}</span>${nums ? `<span class="rv-nums muted">${nums}</span>` : ''}</li>`;
  return `
  <article class="panel history-panel" aria-labelledby="history-title">
    <h2 id="history-title" class="eyebrow" tabindex="-1">Club history</h2>
    <ul class="badges" aria-label="Club milestones">${clubBadges(s).map((b) => `<li class="badge${b.got ? ' got' : ''}">${b.got ? '<span aria-hidden="true">★</span> ' : '<span aria-hidden="true">☆</span> '}${esc(b.label)}<span class="sr-only">${b.got ? ', earned' : `, locked: ${esc(b.how)}`}</span></li>`).join('')}</ul>
    <h3 class="eyebrow">Trophy cabinet</h3>
    ${(s.trophies ?? []).length
      ? `<ul class="cabinet" aria-label="Trophies">${(s.trophies ?? []).map((x) => `<li class="${x.kind}">${x.kind === 'cup' ? CUP_ICON : SHIELD_ICON}<span>${esc(x.title)}</span></li>`).join('')}</ul>`
      : `<ul class="cabinet" aria-label="Trophies"><li class="empty">${CUP_ICON}<span>Win the cup or the league to fill it</span></li></ul>`}
    <ul class="rv-list history-marks">${marks.map(([k, v, sub]) => row(`<b>${esc(k)}</b> ${v}`, esc(sub))).join('')}</ul>
    <h3 class="eyebrow">Season by season</h3>
    ${seasons.length ? `<ul class="rv-list">${seasons.slice(0, 5).map(season).join('')}</ul>` : emptyState('The first season is still being played.', EMPTY_ICON.calendar)}
    ${seasons.length > 5 ? `<details><summary>${seasons.length - 5} earlier season${seasons.length === 6 ? '' : 's'}</summary><ul class="rv-list">${seasons.slice(5).map(season).join('')}</ul></details>` : ''}
  </article>`;
}
