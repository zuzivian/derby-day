// Club history panel (Club tab, from the Club history perk at level 24): one
// row per finished season and the club's records. The data is kept by
// src/meta/history.ts, so it outlives the capped match history.

import { signed, type Save } from '../meta/game.ts';
import { isUnlocked } from '../meta/levels.ts';
import { divisionName } from '../meta/world.ts';
import { esc } from './ui.ts';

export function historyPanel(s: Save): string {
  if (!isUnlocked(s, 'history')) return '';
  const rec = s.records;
  const seasons = [...(s.seasons ?? [])].reverse();
  const marks = rec
    ? [
        ['Played', `${rec.played}`, `${rec.won}W ${rec.drawn}D ${rec.lost}L · ${rec.gf}–${rec.ga}`],
        ['Best division', rec.bestDivision ? divisionName(rec.bestDivision) : '—', ''],
        ['Trophies', `${(s.trophies ?? []).length}`, ''],
        ['Biggest win', rec.biggestWin?.text ?? '—', rec.biggestWin ? `Season ${rec.biggestWin.year}` : ''],
        ['Longest unbeaten', rec.longestUnbeaten ? `${rec.longestUnbeaten.value} matches` : '—', rec.longestUnbeaten ? `Season ${rec.longestUnbeaten.year}` : ''],
        ['Highest Elo', rec.highestElo ? `${rec.highestElo.value}` : '—', rec.highestElo ? `Season ${rec.highestElo.year}` : ''],
      ]
    : [];
  const row = (main: string, nums = '') => `<li class="rv-row"><span class="rv-main">${main}</span>${nums ? `<span class="rv-nums muted">${nums}</span>` : ''}</li>`;
  return `
  <article class="panel" aria-labelledby="history-title">
    <h2 id="history-title" class="eyebrow" tabindex="-1">Club history</h2>
    <ul class="rv-list">${marks.map(([k, v, sub]) => row(`<b>${esc(k)}</b> ${esc(v)}`, esc(sub))).join('')}</ul>
    <h3 class="eyebrow">Season by season</h3>
    ${seasons.length
      ? `<ul class="rv-list">${seasons.map((x) => row(`<b>Season ${x.year}</b> ${esc(divisionName(x.division))} · ${x.won}W ${x.drawn}D ${x.lost}L (${signed(x.gf - x.ga)}) · Elo ${x.eloEnd}${x.notes.length ? `<span class="muted small">${esc(x.notes.join('; '))}</span>` : ''}`)).join('')}</ul>`
      : '<p class="muted">The first season is still being played.</p>'}
  </article>`;
}
