// Season review: the modal shown after the end-of-season rollover, the
// academy-offers panel on the Squad screen and the clicks that go with them.
// The rules live in src/meta/progression.ts; this file only renders and wires.
// Styles are in review.css (appended to the page by scripts/build.ts).

import { MAX_SQUAD, type Save } from '../meta/game.ts';
import { overall, type Player } from '../meta/player.ts';
import { potentialText, scoutedPotential, SCOUT_MATCHES, signProspect, starText, type IntakeEntry, type PlayerChange, type SeasonReview } from '../meta/progression.ts';
import type { App } from './ui.ts';

const esc = (t: string | number): string =>
  String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const sign = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

function stars(n: number): string {
  return `<span class="stars" role="img" aria-label="Scouting estimate: ${n} out of 5 stars"><span aria-hidden="true">${starText(n)}</span></span>`;
}

const rolePill = (role: string) => `<span class="pos pos-${esc(role)}">${esc(role)}</span>`;

function changeRow(c: PlayerChange): string {
  const d = c.after - c.before;
  return `<li class="rv-row">
    <span class="rv-main"><b>${esc(c.name)}</b>${rolePill(c.role)}<span class="muted">age ${c.age}</span></span>
    <span class="rv-nums"><span class="muted">${c.before}</span> → <b>${c.after}</b> <span class="${d > 0 ? 'up' : 'down'}">(${sign(d)})</span></span>
  </li>`;
}

/** Who a full squad would release first: bench players before starters, weakest first. */
function releaseOptions(s: Save): string {
  return [...s.squad]
    .sort((a, b) => Number(s.lineup.includes(a.id)) - Number(s.lineup.includes(b.id)) || overall(a) - overall(b))
    .map((p) => `<option value="${esc(p.id)}">${esc(`${p.first[0]}. ${p.last} · ${p.role} ${overall(p)} · age ${p.age}`)}</option>`)
    .join('');
}

/** One offered prospect with the controls to sign them (releasing someone if the squad is full). */
function offerRow(s: Save, p: Player): string {
  const full = s.squad.length >= MAX_SQUAD;
  const v = scoutedPotential(p);
  return `<li class="rv-row rv-offer" data-offer="${esc(p.id)}">
    <span class="rv-main"><b>${esc(p.first[0])}. ${esc(p.last)}</b>${rolePill(p.role)}<span class="muted">age ${p.age} · OVR ${overall(p)}</span>${stars(v.stars)}<span class="muted">POT ${potentialText(p)}</span></span>
    <span class="rv-sign">
      ${full ? `<label class="visually-hidden" for="release-${esc(p.id)}">Release to make room for ${esc(p.last)}</label><select id="release-${esc(p.id)}" class="rv-release">${releaseOptions(s)}</select>` : ''}
      <button class="btn small primary" data-action="review-sign" data-id="${esc(p.id)}">${full ? 'Release and sign' : 'Sign'}</button>
    </span>
  </li>`;
}

function intakeRow(s: Save, e: IntakeEntry): string {
  const offer = (s.offers ?? []).find((p) => p.id === e.id);
  if (offer) return offerRow(s, offer);
  const inSquad = s.squad.find((p) => p.id === e.id);
  const live = inSquad ? scoutedPotential(inSquad) : null;
  const status = e.joined ? 'Joined the squad' : inSquad ? 'Signed' : 'Moved on';
  return `<li class="rv-row">
    <span class="rv-main"><b>${esc(e.name)}</b>${rolePill(e.role)}<span class="muted">age ${e.age} · OVR ${e.overall}</span>${stars(live?.stars ?? e.stars)}<span class="muted">POT ${live ? potentialText(inSquad!) : esc(e.range)}</span></span>
    <span class="rv-status${e.joined || inSquad ? ' up' : ' muted'}">${status}</span>
  </li>`;
}

function section(title: string, body: string): string {
  return `<section class="rv-section"><h3 class="eyebrow">${title}</h3>${body}</section>`;
}

export function reviewModal(app: App): string {
  const s = app.save;
  const rv = s.review;
  if (!rv || rv.seen) return '';
  return `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
    <div class="modal-card review-card">
      <div class="eyebrow">End of season</div>
      <h2 id="review-title" class="review-title">Season ${rv.year} review</h2>
      ${recordSection(rv)}
      ${section('Who changed', changesBody(rv))}
      ${rv.retired.length ? section('Retirements', `<ul class="rv-list">${rv.retired.map((e) => `<li class="rv-row"><span class="rv-main"><b>${esc(e.name)}</b>${rolePill(e.role)}<span class="muted">age ${e.age}</span></span><span class="rv-nums muted">OVR ${e.overall}</span></li>`).join('')}</ul>`) : ''}
      ${section('Academy intake', intakeBody(s, rv))}
      ${ladderBody(rv)}
      <button class="btn primary big" data-action="review-close">Start season ${rv.year + 1}</button>
    </div>
  </div>`;
}

function recordSection(rv: SeasonReview): string {
  const r = rv.record;
  const elo = r.eloEnd - r.eloStart;
  return `<div class="rv-record" aria-label="Season record">
    ${r.played
      ? `<span><b>${r.won}W ${r.drawn}D ${r.lost}L</b> in ${r.played} match${r.played === 1 ? '' : 'es'}</span><span>Goals <b>${r.gf}–${r.ga}</b></span><span>Elo <b>${r.eloStart} → ${r.eloEnd}</b> <span class="${elo >= 0 ? 'up' : 'down'}">(${sign(elo)})</span></span>`
      : `<span class="muted">No ranked or competition matches this season.</span>`}
    ${r.trophies.length ? `<span class="rv-trophy">Trophies: <b>${r.trophies.map(esc).join(', ')}</b></span>` : ''}
  </div>`;
}

function changesBody(rv: SeasonReview): string {
  return `<p class="muted small">${rv.improved} improved, ${rv.declined} declined, ${rv.steady} unchanged. Overall rating, before → after.</p>
    ${rv.changes.length ? `<ul class="rv-list">${rv.changes.map(changeRow).join('')}</ul>` : '<p class="muted">Nobody changed.</p>'}`;
}

function intakeBody(s: Save, rv: SeasonReview): string {
  const waiting = (s.offers ?? []).length;
  const full = s.squad.length >= MAX_SQUAD;
  return `<p class="muted small">Scouts give stars and a potential range for now; the range tightens as each prospect plays. ${waiting && full ? `The squad is full (${MAX_SQUAD}): choose someone to release to sign a prospect. Offers expire at the next season review.` : ''}${rv.expiredOffers ? ` ${rv.expiredOffers} prospect${rv.expiredOffers === 1 ? '' : 's'} from last year moved on.` : ''}</p>
    <ul class="rv-list">${rv.intake.map((e) => intakeRow(s, e)).join('')}</ul>`;
}

function ladderBody(rv: SeasonReview): string {
  const rows = [...rv.risers.map((m) => ({ m, up: true })), ...rv.fallers.map((m) => ({ m, up: false }))];
  if (!rows.length) return '';
  return section(
    'Around the ladder',
    `<ul class="rv-list">${rows.map(({ m, up }) => `<li class="rv-row"><span class="rv-main">${esc(m.name)}</span><span class="rv-nums"><span class="muted">${m.before}</span> → <b>${m.after}</b> <span class="${up ? 'up' : 'down'}">(${sign(m.after - m.before)})</span></span></li>`).join('')}</ul>`,
  );
}

/** Panel at the top of the Squad screen while academy offers are waiting. */
export function academyPanel(app: App): string {
  const s = app.save;
  const offers = s.offers ?? [];
  if (!offers.length) return '';
  const full = s.squad.length >= MAX_SQUAD;
  return `
  <article class="panel rv-panel" aria-labelledby="academy-title">
    <h2 id="academy-title" class="eyebrow">Academy offers · ${offers.length} waiting</h2>
    <p class="muted small">${full ? `Your squad is full (${MAX_SQUAD}). Pick someone to release (free) to sign a prospect.` : 'There is room in the squad.'} Offers expire at the next season review. Potential is a scouting estimate until they have played ${SCOUT_MATCHES} matches.</p>
    <ul class="rv-list">${offers.map((p) => offerRow(s, p)).join('')}</ul>
  </article>`;
}

/** "Season N review" button for the Club screen, once there is a review to reopen. */
export function reviewButton(app: App): string {
  const rv = app.save.review;
  return rv ? `<button class="btn small" data-action="review-open">Season ${rv.year} review</button>` : '';
}

export interface ReviewContext {
  app: App;
  toast: (text: string, ok?: boolean) => void;
  persist: () => void;
}

/** Handle a `review-*` click. The caller re-renders afterwards. */
export function reviewAction(action: string, el: HTMLElement, ctx: ReviewContext): void {
  const s = ctx.app.save;
  switch (action) {
    case 'review-close':
      if (s.review) s.review.seen = true;
      ctx.persist();
      break;
    case 'review-open':
      if (s.review) s.review.seen = false;
      break;
    case 'review-sign': {
      const select = el.closest('[data-offer]')?.querySelector<HTMLSelectElement>('select');
      const r = signProspect(s, el.dataset.id ?? '', select?.value);
      ctx.toast(r.message, r.ok);
      if (r.ok) ctx.persist();
      break;
    }
  }
}
