// After-render touches for the management shell. The shell is re-created with
// innerHTML on every render, so anything that lives in the DOM rather than in
// app state is carried across here: the tab bar's scroll position (and keeping
// the open tab in view), the result dialog's XP animation (it waits until the
// card is actually on screen), and bringing a panel into view on stacked
// phone and tablet layouts when the thing a tap changed is below the fold.

let tabsScroll = 0;
let reveal: string | null = null;
let xpWatch: IntersectionObserver | null = null;

/** Ask for `selector` to be scrolled into view after the next render, on stacked layouts only. */
export function queueReveal(selector: string): void {
  reveal = selector;
}

export function beforeRender(root: HTMLElement): void {
  const bar = root.querySelector<HTMLElement>('.tabs');
  if (bar) tabsScroll = bar.scrollLeft;
}

export function afterRender(root: HTMLElement): void {
  keepTabInView(root);
  armXpCard(root);
  const sel = reveal;
  reveal = null;
  if (sel && matchMedia('(max-width: 860px)').matches) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.querySelector<HTMLElement>(sel)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }
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

/** The XP card's bar fill and level-up flourish start once most of the card is visible (levels.css). */
function armXpCard(root: HTMLElement): void {
  xpWatch?.disconnect();
  xpWatch = null;
  const card = root.querySelector<HTMLElement>('.modal .xp-card');
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
