// The tactics board on the Squad screen: a formation picker that shows each
// shape on a mini pitch, and the five-step mentality from Park the bus to
// High press. Both are native radio groups (arrow keys move between options,
// one Tab stop each), so they need no script of their own: a change bubbles
// to main.ts as data-change="formation" or "mentality".
// What the mentalities do on the pitch is TACTICS in src/sim/ai.ts.

import { FORMATION_IDS, formationOf, MENTALITY_IDS, MENTALITY_LABEL, mentalityOf, type FormationId, type Mentality } from '../sim/constants.ts';

/** One line each for the formation cards: what the shape is good at. */
export const FORMATION_NOTE: Record<FormationId, string> = {
  '4-4-2': 'Two banks of four and a strike pair. Solid and simple.',
  '4-3-3': 'Wingers high and wide, a holding midfielder behind two.',
  '4-2-3-1': 'Two sitters screen the back four; a No. 10 behind the striker.',
  '4-1-4-1': 'A holding man and a flat four: compact, hard to play through.',
  '4-4-1-1': 'A 4-4-2 with a second striker dropping between the lines.',
  '3-5-2': 'Three centre-backs, wing-backs for width, two up top.',
  '3-4-3': 'Wing-backs and two wingers: everyone attacks.',
  '5-3-2': 'A back five when defending; wing-backs push on with the ball.',
  '5-4-1': 'Five and four behind the ball: the deepest shape there is.',
};

/** Plain-language descriptions of each mentality step, for the selector. */
export const MENTALITY_NOTE: Record<Mentality, string> = {
  park: 'A deep, narrow low block: nobody goes in until the ball is about 35 m out, bodies step in front of shots, only the strikers go forward. Best when you are the underdog.',
  defensive: 'A low, compact block that engages about 40 m from goal and blocks shots; full-backs stay home, safe passes. Fewer goals both ways.',
  balanced: 'A mid block. Press the ball, full-backs overlap on the ball side, short passing mixed with runs in behind.',
  attacking: 'A higher line, more players in the box, riskier forward passes. Hunts the ball for a moment after losing it. For when you are the stronger side.',
  press: 'A high line, and from midfield up two more players hunt the ball with the man closing it down. Wins it back high, but more fouls, more running, space behind.',
};

/** Shape icon: the formation's slots as dots on a small pitch, attacking to the right. */
export function formationSvg(id: FormationId): string {
  const W = 64;
  const H = 42;
  const dots = formationOf(id)
    .map((f) => {
      // Slot x runs 0.02 (keeper) to about 0.6 (strikers): spread it over the pitch.
      const x = 4 + (f.x / 0.62) * (W - 10);
      const y = 3 + f.y * (H - 6);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${f.role === 'GK' ? 2.2 : 2.6}" class="tac-dot tac-${f.role}"/>`;
    })
    .join('');
  return `<svg class="tac-shape" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">
    <rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="3" class="tac-pitch"/>
    <line x1="${W / 2}" y1="1" x2="${W / 2}" y2="${H - 1}" class="tac-mark"/>
    <circle cx="${W / 2}" cy="${H / 2}" r="5" class="tac-mark"/>
    <rect x="0.75" y="${H / 2 - 9}" width="8" height="18" class="tac-mark"/>
    <rect x="${W - 8.75}" y="${H / 2 - 9}" width="8" height="18" class="tac-mark"/>
    ${dots}
  </svg>`;
}

/** The tactics panel for the Squad screen. */
export function tacticsPanel(formation: FormationId | undefined, mentality: Mentality | undefined): string {
  const f = formation ?? '4-4-2';
  const m = mentalityOf(mentality);
  const cards = FORMATION_IDS.map(
    (id) => `<label class="tac-card${id === f ? ' on' : ''}" title="${FORMATION_NOTE[id]}">
      <input type="radio" id="tac-formation-${id}" name="formation" value="${id}" data-change="formation"${id === f ? ' checked' : ''} aria-describedby="tac-f-${id}">
      ${formationSvg(id)}
      <span class="tac-name">${id}</span>
      <span class="sr-only" id="tac-f-${id}">${FORMATION_NOTE[id]}</span>
    </label>`,
  ).join('');
  const steps = MENTALITY_IDS.map(
    (id, i) => `<label class="tac-step${id === m ? ' on' : ''}" data-step="${i}">
      <input type="radio" id="tac-mentality-${id}" name="mentality" value="${id}" data-change="mentality"${id === m ? ' checked' : ''} aria-describedby="tac-m-${id}">
      <span class="tac-pips" aria-hidden="true">${MENTALITY_IDS.map((_, j) => `<i${j <= i ? ' class="lit"' : ''}></i>`).join('')}</span>
      <span class="tac-step-name">${MENTALITY_LABEL[id]}</span>
      <span class="tac-step-note" id="tac-m-${id}">${MENTALITY_NOTE[id]}</span>
    </label>`,
  ).join('');
  return `
    <article class="panel tactics" aria-labelledby="tactics-title">
      <div class="board-head"><h2 class="eyebrow" id="tactics-title">Tactics</h2><div class="tac-now">${f} · <b>${MENTALITY_LABEL[m]}</b></div></div>
      <fieldset class="tac-group">
        <legend class="tac-legend">Formation</legend>
        <div class="tac-cards">${cards}</div>
        <p class="muted small tac-hint">${FORMATION_NOTE[f]} Changing it re-picks your best XI for the new slots.</p>
      </fieldset>
      <fieldset class="tac-group">
        <legend class="tac-legend">Mentality <span class="muted">· how your CPU teammates defend, press and attack</span></legend>
        <div class="tac-steps">${steps}</div>
      </fieldset>
    </article>`;
}

/**
 * Quick tactics for the pause menu: the five mentality steps as one radio group. The match
 * view sends the change to the sim as HumanInput.tactic on the next tick, so replays and the
 * other tab in a linked match see it too.
 */
export function quickTacticsMarkup(current: Mentality | undefined): string {
  const m = mentalityOf(current);
  return `<fieldset class="pause-tactics" id="quick-tactics">
    <legend>Mentality</legend>
    <div class="qt-steps">${MENTALITY_IDS.map(
      (id) => `<label class="qt-step"><input type="radio" name="quick-mentality" value="${id}"${id === m ? ' checked' : ''}><span>${MENTALITY_LABEL[id]}</span></label>`,
    ).join('')}</div>
  </fieldset>`;
}
