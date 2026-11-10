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
  // Phase is 'done' as the end card is still held back for a beat.
  expect(await page.locator(S.end).isHidden(), 'end card waits a beat after the last kick').toBe(true);
  await page.locator(S.end).waitFor({ state: 'visible' });
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
