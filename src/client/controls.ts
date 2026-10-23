// The controls reference card, for setup and the training ground.

import type { ControlStyle } from './store.ts';

const ROWS: { action: string; mouse: string; keys: string }[] = [
  { action: 'Run', mouse: 'Move the pointer. Your player runs to it.', keys: 'WASD or arrow keys' },
  { action: 'Pass', mouse: 'Left click toward a teammate', keys: 'Space' },
  { action: 'Tackle', mouse: 'Left click near the ball carrier', keys: 'Space near the ball carrier' },
  { action: 'Shoot', mouse: 'Hold the right button, then release', keys: 'Hold F, then release' },
  { action: 'Switch player', mouse: 'Right click without the ball', keys: 'E' },
  { action: 'Pause', mouse: 'Esc or P', keys: 'Esc or P' },
];

const kbd = (t: string) => t.replace(/\b(WASD|Space|F|E|P|Esc)\b/g, '<kbd>$1</kbd>');

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
