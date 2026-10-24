// The controls reference card, for setup and the training ground.

import type { ControlStyle } from './store.ts';

const ROWS: { action: string; mouse: string; keys: string }[] = [
  { action: 'Run', mouse: 'Move the pointer. Your player runs to it: slow when it is close, a sprint when it is far.', keys: 'WASD or arrow keys, hold Shift to sprint' },
  { action: 'Pass', mouse: 'Left click: the ball rolls to the pointer', keys: 'Space' },
  { action: 'Lofted pass', mouse: 'Hold the left button, release: lands at the pointer, a longer hold goes higher and further', keys: 'Hold C, release' },
  { action: 'Shoot', mouse: 'Right click, or hold the right button for power and release', keys: 'Hold F, release' },
  { action: 'Switch player', mouse: 'Left click a teammate (or toward one) without the ball', keys: 'E' },
  { action: 'Tackle', mouse: 'Right click without the ball: a slide if the pointer is far', keys: 'Space without the ball' },
  { action: 'Pause', mouse: 'Esc or P', keys: 'Esc or P' },
];

const kbd = (t: string) => t.replace(/\b(WASD|Space|Shift|F|C|E|P|Esc)\b/g, '<kbd>$1</kbd>');

export function controlsCard(mode: ControlStyle, headingLevel: 2 | 3 = 3): string {
  const h = `h${headingLevel}`;
  const label = mode === 'mouse' ? 'Mouse controls' : 'Keyboard controls';
  return `<div class="controls-card">
    <${h} class="controls-title">${label}</${h}>
    <table class="tbl compact controls-table">
      <thead><tr><th scope="col">Action</th><th scope="col">${mode === 'mouse' ? 'Mouse' : 'Keys'}</th></tr></thead>
      <tbody>${ROWS.map((r) => `<tr><th scope="row">${r.action}</th><td>${kbd(mode === 'mouse' ? r.mouse : r.keys)}</td></tr>`).join('')}</tbody>
    </table>
  </div>`;
}
