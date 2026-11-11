// Penalty shootouts: a drawn cup tie you played goes to a live shootout that feeds the bracket.
// A draw is forced the cheap way: 1 second halves and no input, so the match ends 0-0.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, readSave } = require('./lib/helpers.cjs');

const S = {
  section: '.shootout',
  start: '#so-start',
  quick: '#so-quick',
  dive: (d) => `#so-dive [data-dive="${d}"]`,
  leave: '#so-leave',
  cont: '#so-continue',
  end: '#so-end',
  endTitle: '#so-end-title',
  live: '#so-live',
  marks: '.so-mark',
  canvas: '#so-canvas',
};
const playCup = '[data-action="comp-play"][data-kind="cup"]';
const phaseOf = (page) => page.locator(S.section).getAttribute('data-phase');
const waitPhase = (page, phases) =>
  page.waitForFunction((ps) => ps.includes(document.querySelector('.shootout')?.dataset.phase), phases, { timeout: 30_000 });

/** The live region is set a tick after the event so repeats are read out: wait for it. */
const liveText = (page, re) =>
  page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('#so-live')?.textContent || ''), re.source, { timeout: 5000 });

/** Start a cup and play the quarter-final with no input until it ends level and the shootout opens. */
async function reachShootout(t, opts = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const page = await openApp(t, { prefs: { halfSeconds: 1 }, ...opts });
    await goTab(page, 'competitions');
    await page.locator('[data-action="comp-start-cup"]').click();
    await page.locator(playCup).click();
    await page.waitForSelector(`${S.section}, ${SEL.modal}`, { timeout: 30_000 });
    if (await page.locator(S.section).count()) return page;
    await page.close(); // somebody scored: try again with a fresh save
  }
  throw new Error('could not get a drawn cup match in 4 tries');
}

/** Play one kick the simplest way: quick button as taker, a fixed dive as keeper. Returns which role it was. */
async function playOneKick(page, key = null) {
  await waitPhase(page, ['aim', 'telegraph', 'done']);
  const ph = await phaseOf(page);
  if (ph === 'done') return 'done';
  if (ph === 'aim') {
    if (key) {
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(150);
      await page.keyboard.up('ArrowRight');
      await page.keyboard.down(' ');
      await page.waitForTimeout(500);
      await page.keyboard.up(' ');
    } else await page.locator(S.quick).click();
  } else if (key) {
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press(' ');
  } else await page.locator(S.dive(-1)).click();
  await waitPhase(page, ['result']);
  return ph === 'aim' ? 'taker' : 'keeper';
}

async function finishShootout(page, firstKeys) {
  const roles = new Set();
  for (let k = 0; k < 60; k++) {
    const role = await playOneKick(page, k === 0 ? firstKeys : null);
    if (role === 'done') break;
    roles.add(role);
    // Result banner is skippable shortly after it appears.
    await page.waitForTimeout(520);
    await page.keyboard.press('Space').catch(() => {});
    await waitPhase(page, ['aim', 'telegraph', 'done']);
  }
  return roles;
}

test('shootout: a drawn cup tie opens a live shootout, plays through with the mouse, and settles the bracket', async (t) => {
  const page = await reachShootout(t);
  expect(await page.locator(SEL.pitch).count(), 'match is over').toBe(0);
  expect(await page.locator(SEL.modal).count(), 'no result yet: the shootout comes first').toBe(0);
  expect(await page.locator(S.canvas).count(), 'goal canvas').toBe(1);
  expect(await page.locator(S.marks).count(), 'five kick marks per side before any kick').toBe(10);
  expect(await page.locator(S.live).getAttribute('aria-live'), 'announcements are live').toBe('polite');

  await page.locator(S.start).click();
  const roles = await finishShootout(page, null);
  expect(roles.has('taker') && roles.has('keeper'), 'you take and you keep').toBe(true);
  await liveText(page, /./);

  await page.locator(S.end).waitFor({ state: 'visible' });
  const title = await page.locator(S.endTitle).textContent();
  expect(title, 'verdict').toMatch(/You (win|lose) \d+–\d+ on penalties/);
  const [, verdict, a, b] = /You (win|lose) (\d+)–(\d+)/.exec(title);
  expect(verdict === 'win' ? Number(a) > Number(b) : Number(a) < Number(b), 'verdict agrees with the score').toBe(true);

  await page.locator(S.cont).click();
  await page.locator(SEL.modal).waitFor();
  const save = await readSave(page);
  const tie = save.cup.rounds[0].find((x) => x.a === save.club.id || x.b === save.club.id);
  expect(tie.ga, 'it was a draw').toBe(tie.gb);
  expect(Array.isArray(tie.pens), 'shootout score stored on the tie').toBe(true);
  const mine = tie.a === save.club.id ? tie.pens[0] : tie.pens[1];
  const theirs = tie.a === save.club.id ? tie.pens[1] : tie.pens[0];
  expect([mine, theirs].join('-'), 'bracket has the score you saw').toBe(`${a}-${b}`);
  expect(tie.winner === save.club.id, 'winner follows the shootout').toBe(mine > theirs);
  expect(save.cup.round, 'the round was completed').toBe(1);
  expect(await page.locator(SEL.modal).innerText(), 'result mentions penalties').toMatch(/penalties/);
  // A tie settled on penalties is a win or a defeat, never a draw.
  expect(await page.locator('#result-title').textContent(), 'headline follows the shootout').toBe(verdict === 'win' ? 'Victory' : 'Defeat');
  expect(await page.locator('.modal .rs-pens').textContent(), 'shootout score under the score').toBe(`${a}–${b} on penalties`);
});

test('shootout: playable by keyboard alone (arrows aim, Space strikes or dives)', async (t) => {
  const page = await reachShootout(t, { width: 390, height: 844 });
  await page.keyboard.press('Enter'); // Start is focused
  await waitPhase(page, ['aim', 'telegraph']);
  const first = await playOneKick(page, 'keys');
  expect(['taker', 'keeper'].includes(first), 'a kick was played from the keyboard').toBe(true);
  await liveText(page, /scores|saved|woodwork|wide|over the bar|Too slow/i);
  const widths = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(widths.s, 'no horizontal scroll at 390 px').toBeLessThanOrEqual(widths.w);
});

test('shootout: leaving counts as a loss and knocks you out', async (t) => {
  const page = await reachShootout(t);
  const before = await readSave(page);
  await page.locator(S.start).click();
  await waitPhase(page, ['aim', 'telegraph']);
  await page.locator(S.leave).click();
  expect(await page.locator(S.leave).innerText(), 'asks to confirm').toMatch(/Really forfeit/);
  expect(await page.locator(SEL.modal).count(), 'one click does not leave').toBe(0);
  await page.locator(S.leave).click();
  await page.locator(SEL.modal).waitFor();
  const save = await readSave(page);
  const tie = save.cup.rounds[0].find((x) => x.a === save.club.id || x.b === save.club.id);
  expect(tie.winner === save.club.id, 'forfeit loses the tie').toBe(false);
  expect(save.cup.round, 'cup moved on without you').toBe(1);
  // A forfeit pays no prize and costs a fine (forfeitCost in src/meta/game.ts), shown in the result.
  expect(save.budget, 'a forfeit pays no prize, and costs a fine').toBeLessThan(before.budget);
  expect(await page.locator(SEL.modal).innerText(), 'the fine is shown').toMatch(/Forfeit fine/);
  expect(await page.locator(SEL.modal).innerText(), 'result says you are out').toMatch(/Out in the quarter-final/);
});

/** Before boot: window.__hide(ms) acts like a background tab for ms: no animation frames, document.hidden, visibilitychange. */
function hideHook() {
  const raf = window.requestAnimationFrame.bind(window);
  const held = [];
  let frozen = false;
  window.requestAnimationFrame = (cb) => (frozen ? (held.push(cb), 0) : raf((ts) => (frozen ? held.push(cb) : cb(ts))));
  window.__hide = (ms) =>
    new Promise((res) => {
      frozen = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      setTimeout(() => {
        delete document.hidden;
        frozen = false;
        document.dispatchEvent(new Event('visibilitychange'));
        for (const f of held.splice(0)) raf(f);
        res();
      }, ms);
    });
}

test('shootout: a hidden tab stops the clock, so the keeper window and a charging kick wait for you', async (t) => {
  const page = await reachShootout(t, { init: hideHook });
  await page.locator(S.start).click();
  const seen = new Set();
  for (let k = 0; k < 12 && seen.size < 2; k++) {
    await waitPhase(page, ['aim', 'telegraph', 'done']);
    const ph = await phaseOf(page);
    if (ph === 'done') break;
    if (ph === 'telegraph' && !seen.has('keeper')) {
      seen.add('keeper');
      await page.evaluate(() => window.__hide(5000)); // longer than the 3.8 s window
      await page.waitForTimeout(200);
      expect(await phaseOf(page), 'back from a hidden tab: still your call as keeper').toBe('telegraph');
      expect(await page.locator(S.live).textContent(), 'not decided while away').notToContain('Too slow');
    } else if (ph === 'aim' && !seen.has('taker')) {
      seen.add('taker');
      await page.keyboard.down(' ');
      await waitPhase(page, ['charge']);
      await page.evaluate(() => window.__hide(2500)); // longer than a full charge
      await page.waitForTimeout(100);
      expect(await phaseOf(page), 'back from a hidden tab: the kick is not struck by itself').toBe('charge');
      await page.keyboard.up(' ');
    }
    await playOneKick(page).catch(() => {});
    await page.waitForTimeout(520);
    await page.keyboard.press('Space').catch(() => {});
  }
  expect([...seen].sort().join(','), 'checked both roles').toBe('keeper,taker');
}, { timeoutMs: 150_000 });

test('shootout: a touch phone gets touch wording', async (t) => {
  const page = await reachShootout(t, { width: 390, height: 844, hasTouch: true });
  const intro = async () => (await page.locator('#so-intro').innerText()).toLowerCase();
  expect(await intro(), 'no mouse on a phone').notToContain('mouse');
  expect(await intro(), 'touch wording').toContain('tap left, centre or right to dive');
  await page.locator(S.start).tap();
  for (let k = 0; k < 8; k++) {
    await waitPhase(page, ['aim', 'telegraph', 'done']);
    if ((await phaseOf(page)) === 'telegraph') break;
    await playOneKick(page);
    await page.waitForTimeout(520);
    await page.keyboard.press('Space').catch(() => {});
  }
  const help = await page.locator('.so-help').innerText();
  expect(help, 'dive help on touch').toContain('Tap Left, Centre or Right to dive');
  expect(help).notToContain('Click');
});

/** Large text as the browser setting does it: a bigger root size, em breakpoints scaled with it (a page-set root does not move them), wide letter-spacing. */
async function largeText(page, rootPx) {
  await page.evaluate((px) => {
    const k = px / 16;
    for (const el of document.querySelectorAll('style')) {
      el.textContent = el.textContent.replace(/@media([^{]*)\{/g, (m, c) => `@media${c.replace(/([\d.]+)em/g, (mm, n) => `${parseFloat(n) * k}em`)}{`);
    }
    const st = document.createElement('style');
    st.textContent = `html{font-size:${px}px !important} *{letter-spacing:.06em !important}`;
    document.head.appendChild(st);
  }, rootPx);
  await page.waitForTimeout(200);
}

// At 20 and 24 px roots (125% and 150% text) on a 390x844 phone the keeper's three dive buttons all stay on screen
// without scrolling, and the scoreboard names are not cut to "Wyn...".
for (const rootPx of [20, 24]) {
  test(`shootout: at a ${rootPx}px root on a phone every dive button is on screen and the names are readable`, async (t) => {
    const page = await reachShootout(t, { width: 390, height: 844, hasTouch: true, mutateSave: (s) => { s.club.name = 'Wynbridge Rovers'; } });
    await largeText(page, rootPx);
    await page.locator(S.start).tap();
    // Play as the taker until the keeper's turn comes up (the draw order decides who starts).
    for (let k = 0; k < 8; k++) {
      await waitPhase(page, ['aim', 'telegraph', 'done']);
      if ((await phaseOf(page)) === 'telegraph') break;
      await playOneKick(page);
      await page.waitForTimeout(520);
      await page.keyboard.press('Space').catch(() => {});
    }
    expect(await phaseOf(page), 'reached the keeper phase').toBe('telegraph');
    const m = await page.evaluate(() => {
      window.scrollTo(0, 0); // "without scrolling": measured from the top of the page
      const vh = window.innerHeight;
      const btns = [...document.querySelectorAll('#so-dive [data-dive]')].map((b) => { const r = b.getBoundingClientRect(); return { d: b.dataset.dive, top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) }; });
      const names = [...document.querySelectorAll('.so-name-t')].map((n) => ({ t: n.textContent, clipped: n.scrollWidth > n.clientWidth + 1 }));
      return { vh, btns, names, scrollY: window.scrollY, docH: document.documentElement.scrollHeight };
    });
    expect(m.btns.length, 'three dive buttons').toBe(3);
    for (const b of m.btns) expect(b.bottom, `dive button ${b.d} inside the viewport ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.vh);
    for (const b of m.btns) expect(b.top, `dive button ${b.d} not above the top ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(0);
    for (const n of m.names) expect(n.clipped, `scoreboard name shown whole ${JSON.stringify(m.names)}`).toBe(false);
  });
}

// Home hero at a 24 px root, 390x844: a long club name wraps between words, never inside one.
for (const rootPx of [20, 24]) {
  test(`shootout: (home) at a ${rootPx}px root a long club name in the hero wraps at word boundaries`, async (t) => {
    const page = await openApp(t, { width: 390, height: 844, hasTouch: true, mutateSave: (s) => { s.club.name = 'Örnstad Vale Lamplighters'; } });
    await largeText(page, rootPx);
    const broken = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.hero-name')) {
        const box = el.getBoundingClientRect();
        // Each word measured alone: a word wider than the column can only be broken mid-word.
        for (const w of el.textContent.split(/\s+/)) {
          const s = document.createElement('span');
          s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
          s.textContent = w;
          el.appendChild(s);
          const wide = s.getBoundingClientRect().width;
          s.remove();
          if (wide > box.width + 0.5) out.push({ word: w, wide: Math.round(wide), col: Math.round(box.width) });
        }
      }
      return out;
    });
    expect(broken, `words wider than the name column (would break mid-word) ${JSON.stringify(broken)}`).toEqual([]);
  });
}

// A single long word (no space to wrap at) in the hero name must also fit its column at large text, on the small phones too:
// the name shrinks (never below its default size) instead of breaking mid-word. Default size stays 18px.
for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
  for (const word of ['Wolverhampton', 'Kidderminster']) {
    test(`shootout: (home) at a 24px root a single long word "${word}" fits the hero name column at ${vp.width}x${vp.height}`, async (t) => {
      const page = await openApp(t, { ...vp, hasTouch: true, mutateSave: new Function('s', `s.club.name = ${JSON.stringify(word)};`) });
      const sizeAt = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.hero-name')).fontSize));
      expect(await sizeAt(), 'default text size keeps the 18px hero name').toBe(18);
      const first = await page.evaluate(() => document.querySelector('.hero-name').textContent);
      expect(first, 'the club name is the one set').toBe(word);
      await largeText(page, 24);
      // A real large-text setting is there at load; the simulation changes the root afterwards, so the app is told as a resize does.
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      const m = await page.evaluate((w) => {
        const el = document.querySelector('.hero-name');
        const s = document.createElement('span');
        s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
        s.textContent = w;
        el.appendChild(s);
        const wide = s.getBoundingClientRect().width;
        s.remove();
        return { wide: Math.round(wide), col: Math.round(el.parentElement.clientWidth), lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) };
      }, word);
      expect(m.wide, `the word fits the column without a mid-word break ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.col + 0.5);
      expect(m.lines, `the word stays on one line ${JSON.stringify(m)}`).toBe(1);
    });
  }
}

test('shootout: mouse wording flips to touch wording on the first touch pointerdown', async (t) => {
  // A wide viewport with a fine pointer: mouse wording at mount, then a touch pointerdown.
  const page = await reachShootout(t);
  expect((await page.locator('#so-intro').innerText()).toLowerCase(), 'mouse wording first').toContain('mouse');
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
  const text = (await page.locator('#so-intro').innerText()).toLowerCase();
  expect(text, 'touch wording after a finger').notToContain('mouse');
  expect(text).toContain('tap left, centre or right to dive');
});

test('shootout: on touch, action buttons are 44px, Forfeit is spaced apart and hidden once a kick is decided', async (t) => {
  const page = await reachShootout(t, { width: 390, height: 844, hasTouch: true });
  await page.locator(S.start).tap();
  await waitPhase(page, ['aim', 'telegraph']);
  const box = async (sel) => page.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; });
  const primary = (await phaseOf(page)) === 'aim' ? S.quick : S.dive(-1);
  const p = await box(primary);
  const l = await box(S.leave);
  expect(Math.round(p.h), 'primary action is at least 44px').toBeGreaterThanOrEqual(44);
  expect(Math.round(l.h), 'forfeit is at least 44px').toBeGreaterThanOrEqual(44);
  expect(l.top - p.bottom, 'clear space between forfeit and the primary action').toBeGreaterThanOrEqual(12);
  await playOneKick(page);
  expect(await page.locator(S.leave).evaluate((e) => getComputedStyle(e).visibility), 'no forfeit while a result shows').toBe('hidden');
});

test('shootout: short landscape banner clears the dive labels; the end card pauses, names the next step and has confetti on a win', async (t) => {
  const page = await reachShootout(t, { width: 750, height: 342, hasTouch: true });
  await page.locator(S.start).tap();
  await waitPhase(page, ['aim', 'telegraph']);
  await playOneKick(page);
  const r = await page.evaluate(() => {
    const b = document.querySelector('#so-banner').getBoundingClientRect();
    const c = document.querySelector('#so-canvas');
    const cr = c.getBoundingClientRect();
    const top = parseFloat(getComputedStyle(c.parentElement).getPropertyValue('--so-lbl-top'));
    return { bannerBottom: b.bottom - cr.top, bannerTop: b.top - cr.top, bannerH: b.height, lblTop: top };
  });
  expect(r.bannerBottom, 'banner ends above the LEFT/CENTRE/RIGHT labels').toBeLessThanOrEqual(r.lblTop + 1);
  expect(r.bannerTop, 'banner stays on the canvas').toBeGreaterThanOrEqual(0);
  expect(r.bannerH, 'banner is capped in short landscape').toBeLessThanOrEqual(60);
  // Record in the page, as each change lands, whether the end card is still hidden at the decision, and
  // how long after the decision it appears. Checking afterwards over several browser round trips raced the 300 ms
  // beat on a slow CI runner. The beat is timed from the decision itself (Forfeit is hidden in the same task that
  // starts the end-card timer), not from data-phase, which the next animation frame mirrors and a busy runner delays (CI saw
  // data-phase reach 'done' after the card was already up).
  const leaveHiddenBefore = await page.evaluate(() => {
    const sec = document.querySelector('.shootout');
    const end = document.querySelector('#so-end');
    const leave = document.querySelector('#so-leave');
    const w = (window.__soEnd = { hiddenAtDecision: null, decidedAt: 0, shownAt: 0 });
    new MutationObserver(() => {
      if (!w.decidedAt && leave.hidden) { w.decidedAt = performance.now(); w.hiddenAtDecision = end.hidden; }
      if (w.decidedAt && !w.shownAt && !end.hidden) w.shownAt = performance.now();
    }).observe(sec, { attributes: true, subtree: true, attributeFilter: ['data-phase', 'hidden'] });
    return leave.hidden;
  });
  expect(leaveHiddenBefore, 'Forfeit is offered until the shootout is decided').toBe(false);
  await page.waitForTimeout(520);
  await page.keyboard.press('Space').catch(() => {});
  for (let k = 0; k < 60; k++) {
    await waitPhase(page, ['aim', 'telegraph', 'done']);
    if ((await phaseOf(page)) === 'done') break;
    await playOneKick(page);
    await page.waitForTimeout(520);
    await page.keyboard.press('Space').catch(() => {});
    await waitPhase(page, ['aim', 'telegraph', 'done']);
  }
  // Phase is 'done' while the end card is still held back for a beat.
  await page.locator(S.end).waitFor({ state: 'visible' });
  const beat = await page.evaluate(() => window.__soEnd);
  expect(beat.hiddenAtDecision, `end card waits a beat after the last kick ${JSON.stringify(beat)}`).toBe(true);
  expect(beat.decidedAt, `the decision hid Forfeit ${JSON.stringify(beat)}`).toBeGreaterThan(0);
  expect(beat.shownAt - beat.decidedAt, `the beat lasts ${JSON.stringify(beat)}`).toBeGreaterThanOrEqual(250);
  const title = await page.locator(S.endTitle).textContent();
  const won = /You win/.test(title);
  const next = await page.locator('#so-end-next').innerText();
  expect(next, 'next step named').toMatch(won ? /^Through to the (semi-final|final)$/ : /^Knocked out$/);
  expect(await page.locator('#so-end .confetti').count(), 'confetti only on a win').toBe(won ? 1 : 0);
  expect(await page.locator(S.leave).evaluate((e) => getComputedStyle(e).visibility === 'hidden' || e.hidden), 'no forfeit after the end').toBe(true);
}, { timeoutMs: 150_000 });

test('shootout: reduced motion shows no confetti on the end card', async (t) => {
  const page = await reachShootout(t, {
    width: 750,
    height: 342,
    hasTouch: true,
    init: () => {
      const mm = window.matchMedia.bind(window);
      const noop = () => {};
      window.matchMedia = (q) =>
        /prefers-reduced-motion:\s*reduce/.test(q)
          ? { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false }
          : mm(q);
    },
  });
  await page.locator(S.start).tap();
  await finishShootout(page, null);
  await page.locator(S.end).waitFor({ state: 'visible' });
  expect(await page.locator('#so-end .confetti').count(), 'no confetti under reduced motion').toBe(0);
}, { timeoutMs: 150_000 });
