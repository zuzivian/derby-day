// The controls reference: touch, mouse and keyboard, one short table each. A native <details> so it
// sits inside the pause menus and Settings without a dialog of its own. Keep it in step with input.ts.

type Row = [action: string, how: string];

const TOUCH: Row[] = [
  ['Run', 'Drag on the pitch: you run toward your finger.'],
  ['Pass', 'Tap Pass, hold to loft.'],
  ['Shoot', 'Tap Shoot, or hold for power and release.'],
  ['Switch', 'Tap a player.'],
  ['Tackle', 'Tap Shoot without the ball.'],
  ['Keeper', 'Tap Pass rolls it out, hold Pass throws, Shoot punts.'],
];
const MOUSE: Row[] = [
  ['Run', 'Move the pointer: you run to it, a sprint when it is far.'],
  ['Pass', 'Left click, to the pointer.'],
  ['Loft', 'Hold left until the bar fills, release.'],
  ['Shoot', 'Right click, or hold right for power.'],
  ['Switch', 'Left click a teammate without the ball.'],
  ['Tackle', 'Right click without the ball: a slide if far.'],
  ['Keeper', 'Left click rolls it out, hold left throws, right click punts.'],
  ['Other', 'V view, wheel or + / − zoom, 1–5 mentality, Esc or P pause.'],
];
const KEYS: Row[] = [
  ['Run', 'WASD or arrows, hold Shift to sprint.'],
  ['Pass', 'Space.'],
  ['Loft', 'Hold C, release.'],
  ['Shoot', 'Hold F, release.'],
  ['Switch', 'E or Q.'],
  ['Tackle', 'Space without the ball.'],
  ['Keeper', 'Space rolls it out, hold C throws, hold F punts.'],
  ['Other', 'V view, + / − zoom, T score and time, 1–5 mentality, Esc or P pause.'],
];

const kbd = (t: string) => t.replace(/\b(WASD|Space|Shift|[FCEQVT0]|P|Esc|1-5)\b/g, '<kbd>$1</kbd>');

const coarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** "Controls and help" disclosure, the likeliest device first. `id` keeps two on one page apart. */
export function controlsHelp(id: string): string {
  const t: [string, Row[]] = ['Touch', TOUCH];
  const sets: [string, Row[]][] = coarse() ? [t, ['Mouse', MOUSE], ['Keyboard', KEYS]] : [['Mouse', MOUSE], ['Keyboard', KEYS], t];
  return `<details class="help-controls" id="${id}"><summary>Controls and help</summary>${sets
    .map(([name, rows]) => `<div class="controls-card"><h3 class="controls-title">${name}</h3><table class="tbl compact controls-table">${rows
      .map(([a, h]) => `<tr><th scope="row">${a}</th><td>${name === 'Touch' ? h : kbd(h)}</td></tr>`)
      .join('')}</table></div>`)
    .join('')}</details>`;
}
