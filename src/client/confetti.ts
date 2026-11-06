// Markup for the one-shot CSS confetti burst on a win (result card, first-match celebration).
// Pieces are plain <i> elements with their flight set by custom properties; styles.css animates them
// only under prefers-reduced-motion: no-preference, and they are invisible otherwise.

const COLOURS = ['#ffd60a', '#ff5a45', '#4cd07d', '#4aa8ff', '#fff4c2', '#ff9f1c'];
const COUNT = 16;

/** Deterministic, so a re-render does not reshuffle the burst. */
export function confettiHtml(): string {
  let out = '<span class="confetti" aria-hidden="true">';
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * Math.PI * 2 + (i % 2) * 0.2;
    const r = 70 + ((i * 37) % 60);
    const dx = Math.round(Math.cos(a) * r * 1.5);
    const dy = Math.round(Math.sin(a) * r * 0.8 - 40);
    const rot = 180 + ((i * 53) % 360);
    out += `<i style="--dx:${dx};--dy:${dy};--rot:${rot}deg;--c:${COLOURS[i % COLOURS.length]};--d:${(i % 4) * 0.04}s"></i>`;
  }
  return `${out}</span>`;
}
