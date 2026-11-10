// After-render touches for the management shell. The shell is re-created with
// innerHTML on every render, so anything that lives in the DOM rather than in
// app state is carried across here: the tab bar's scroll position (and keeping
// the open tab in view), the result dialog's XP animation (it waits until the
// card is actually on screen), and bringing a panel into view on stacked
// phone and tablet layouts when the thing a tap changed is below the fold.

let tabsScroll = 0;
let stripScroll = 0;
let reveal: string | null = null;
let xpWatch: IntersectionObserver | null = null;

/** Ask for `selector` to be scrolled into view after the next render, on stacked layouts only. */
export function queueReveal(selector: string): void {
  reveal = selector;
}

export function beforeRender(root: HTMLElement): void {
  const bar = root.querySelector<HTMLElement>('.tabs');
  if (bar) tabsScroll = bar.scrollLeft;
  const strip = root.querySelector<HTMLElement>('.status-strip');
  if (strip) stripScroll = strip.scrollLeft;
}

export function afterRender(root: HTMLElement): void {
  keepTabInView(root);
  const strip = root.querySelector<HTMLElement>('.status-strip');
  if (strip) {
    strip.scrollLeft = stripScroll;
    stripFade(strip);
    stripFocusable(strip);
    strip.addEventListener('scroll', () => stripFade(strip), { passive: true });
  }
  armXpCard(root);
  countUpChips(root);
  const sel = reveal;
  reveal = null;
  if (sel && matchMedia('(max-width: 860px)').matches) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.querySelector<HTMLElement>(sel)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }
}

/** A tab stop only where the strip scrolls (a narrow landscape phone, 200% zoom), so the keyboard can reach the chips
 *  cut off at its edge; where every chip shows it would be an empty extra stop. Re-checked on resize and rotation. */
function stripFocusable(el: HTMLElement): void {
  if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0;
  else el.removeAttribute('tabindex');
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const el = document.querySelector<HTMLElement>('.status-strip');
    if (el) stripFocusable(el);
  });
}

/** Fade only the edge that has more chips beyond it (the CSS reads --fl and --fr; where the strip doesn't scroll they stay unused). */
function stripFade(el: HTMLElement): void {
  const max = el.scrollWidth - el.clientWidth;
  el.style.setProperty('--fl', el.scrollLeft > 2 ? '24px' : '0px');
  el.style.setProperty('--fr', max - el.scrollLeft > 2 ? '28px' : '0px');
}

function keepTabInView(root: HTMLElement): void {
  const bar = root.querySelector<HTMLElement>('.tabs');
  const on = bar?.querySelector<HTMLElement>('.tab.on');
  if (!bar || !on) return;
  bar.scrollLeft = tabsScroll;
  const b = bar.getBoundingClientRect();
  const t = on.getBoundingClientRect();
  const pad = 28; // clear of the scroll shadow
  if (t.left < b.left + pad) bar.scrollLeft -= b.left + pad - t.left;
  else if (t.right > b.right - pad) bar.scrollLeft += t.right - (b.right - pad);
}

/** The XP card's bar fill and level-up flourish start once most of the card is visible (levels.css): in the result dialog and in the first-match celebration. */
export function armXpCard(root: HTMLElement): void {
  xpWatch?.disconnect();
  xpWatch = null;
  const card = root.querySelector<HTMLElement>('.modal .xp-card, .ob-celebrate .xp-card');
  if (!card) return;
  if (typeof IntersectionObserver === 'undefined') {
    card.classList.add('is-visible');
    return;
  }
  const io = (xpWatch = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        card.classList.add('is-visible');
        io.disconnect();
      }
    },
    { threshold: 0.6 },
  ));
  io.observe(card);
}

/** The result card's Elo and prize-money values count up from zero over ~600 ms, starting as each chip pops in (its
 *  rs-pop animation-delay, styles.css), so the count is seen. While it runs the moving digits are aria-hidden beside the
 *  final value for screen readers; at the end the chip is the plain final text again. Skipped under reduced motion. */
export function countUpChips(root: HTMLElement): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of root.querySelectorAll<HTMLElement>('.modal .rs-chip-main[data-count]:not([data-counted])')) {
    el.dataset.counted = '1';
    const final = el.textContent ?? '';
    const m = /\d+(\.\d+)?/.exec(final);
    if (!m) continue;
    const to = parseFloat(m[0]);
    const dp = m[1] ? m[1].length - 1 : 0;
    if (!(to > 0)) continue;
    const pre = final.slice(0, m.index);
    const post = final.slice(m.index + m[0].length);
    const chip = el.closest<HTMLElement>('.rs-chip');
    const delay = chip ? parseFloat(getComputedStyle(chip).animationDelay) * 1000 || 0 : 0;
    const shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    const said = document.createElement('span');
    said.className = 'sr-only';
    said.textContent = final;
    shown.textContent = `${pre}${(0).toFixed(dp)}${post}`;
    el.replaceChildren(shown, said);
    const t0 = performance.now() + delay;
    const frame = (now: number) => {
      if (!el.isConnected) return;
      const k = Math.max(0, Math.min(1, (now - t0) / 600));
      if (k >= 1) {
        el.textContent = final;
        return;
      }
      shown.textContent = `${pre}${(to * (1 - (1 - k) ** 3)).toFixed(dp)}${post}`;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}
