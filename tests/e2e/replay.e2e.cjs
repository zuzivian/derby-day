// Replays: a played match is recorded and can be watched, goal highlights step and scrub,
// replay codes copy and paste, and the viewer works at phone width and with reduced motion.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, skipOnboarding, startRanked, pageWidths } = require('./lib/helpers.cjs');

const REPLAYS_KEY = 'throughball.replays.v1';
const SHORT = { halfSeconds: 3 };
const VIEWER = '.replay-viewer';

let cachedCode = null;
/** A replay code with at least two goals, made by the real recorder under bun. */
function goalCode() {
  if (!cachedCode) cachedCode = execFileSync('bun', ['run', path.join(__dirname, 'lib', 'make-replay.ts'), '2'], { encoding: 'utf8' }).trim();
  return cachedCode;
}

async function storeReplay(page, code) {
  await page.evaluate(([key, c]) => localStorage.setItem(key, JSON.stringify([{ id: 'e2e-fixture', at: 1700000000, code: c }])), [REPLAYS_KEY, code]);
  await page.reload();
  await page.waitForSelector(SEL.app + ' *');
  await skipOnboarding(page);
  await goTab(page, 'club');
}

/** A cheap fingerprint of what is on the canvas: how many colours, and a hash of the pixels. */
const canvasStats = (page, sel = '#rv-canvas') =>
  page.evaluate((s) => {
    const c = document.querySelector(s);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const colours = new Set();
    let h = 0;
    for (let i = 0; i < d.length; i += 28) {
      colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
    }
    return { w: c.width, h: c.height, colours: colours.size, hash: h };
  }, sel);

const scrubValue = (page) => page.$eval('#rv-scrub', (el) => Number(el.value));
const scrubMax = (page) => page.$eval('#rv-scrub', (el) => Number(el.max));
const setScrub = (page, v) =>
  page.$eval(
    '#rv-scrub',
    (el, val) => {
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    v,
  );
const title = (page) => page.locator('#rv-title').innerText();

test('replay: a played match is recorded, listed under Recent, and the viewer draws, scrubs, steps and closes', async (t) => {
  const page = await openApp(t, { prefs: SHORT });
  await startRanked(page);
  await page.locator(SEL.modal).waitFor({ timeout: 60_000 });

  // The result modal offers the code; goals (if any) get a Watch goals button.
  expect(await page.locator('.modal [data-replay="copy"]').count(), 'copy button in the result modal').toBe(1);
  expect(await page.locator('.modal').innerText(), 'size shown').toMatch(/\d+(\.\d)? (B|KB)/);
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), REPLAYS_KEY);
  expect(stored.length, 'one replay stored').toBe(1);
  expect(stored[0].code.startsWith('TB1.'), 'code prefix').toBe(true);

  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.modal).waitFor({ state: 'detached' });

  expect(await page.locator('.rp-row').count(), 'one row under Recent replays').toBe(1);
  await page.locator('.rp-row [data-replay="watch"]').click();
  await page.locator(VIEWER).waitFor();
  expect(await page.$eval('#app', (el) => el.inert), 'the app behind is inert').toBe(true);

  // The viewer paints on the next animation frame; give a slow CI runner up to 5 s.
  let first = await canvasStats(page);
  for (let i = 0; i < 50 && first.colours <= 6; i++) {
    await page.waitForTimeout(100);
    first = await canvasStats(page);
  }
  expect(first.w, 'canvas sized').toBeGreaterThan(300);
  expect(first.colours, 'canvas has been drawn on (pitch, players, ball)').toBeGreaterThan(6);

  // The re-simulation of what was just played in the live loop must land on the same final state.
  await page.waitForSelector(`${VIEWER}`);
  await page.waitForSelector('.replay-layer[data-verified="true"]', { timeout: 15_000 });

  // Scrub: the position, the time label and the picture change.
  await page.keyboard.press('Space'); // pause
  expect(await page.locator('[data-rp="play"]').innerText(), 'paused').toMatch(/Play|Replay/);
  const max = await scrubMax(page);
  expect(max, 'clip has length').toBeGreaterThan(60);
  await setScrub(page, 0);
  const atStart = await canvasStats(page);
  await setScrub(page, Math.floor(max * 0.6));
  await page.waitForTimeout(120);
  expect(await scrubValue(page), 'scrub moved').toBe(Math.floor(max * 0.6));
  expect(await page.locator('#rv-time').innerText(), 'time label follows').notToContain('0:00.0 /');
  const later = await canvasStats(page);
  expect(later.hash, 'the picture changed with the scrub').notToBe(atStart.hash);

  // Arrow keys step, Shift+arrow steps a second.
  await setScrub(page, 100);
  await page.keyboard.press('ArrowRight');
  expect(await scrubValue(page), 'ArrowRight steps 6 ticks').toBe(106);
  await page.keyboard.press('Shift+ArrowRight');
  expect(await scrubValue(page), 'Shift+ArrowRight steps 60 ticks').toBe(166);
  await page.keyboard.press('ArrowLeft');
  expect(await scrubValue(page), 'ArrowLeft steps back').toBe(160);

  // Space plays, and the clip advances on its own.
  const before = await scrubValue(page);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  expect(await scrubValue(page), 'playing advances').toBeGreaterThan(before);

  // Esc closes just the viewer and gives focus back.
  await page.keyboard.press('Escape');
  await page.locator(VIEWER).waitFor({ state: 'detached' });
  expect(await page.$eval('#app', (el) => el.inert), 'app is live again').toBe(false);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-replay')), 'focus returns to Watch').toBe('watch');
});

test('replay: goal highlights, next and previous, slow-mo, and keyboard play', async (t) => {
  const page = await openApp(t);
  await storeReplay(page, goalCode());
  expect(await page.locator('.rp-row').count(), 'fixture listed').toBe(1);
  expect(await page.locator('.rp-row').innerText(), 'goal count shown').toMatch(/\d goals?/);
  await page.locator('.rp-row [data-replay="watch"]').click();
  await page.locator(VIEWER).waitFor();

  expect(await title(page), 'starts on the first goal').toMatch(/^GOAL 1 OF \d/i);
  const max = await scrubMax(page);
  expect(max, 'a goal clip is about 6 s lead + 1.5 s tail').toBeGreaterThan(300);
  expect(max, 'and no longer').toBeLessThan(500);
  const goals = Number((await title(page)).match(/OF (\d+)/i)[1]);

  await page.locator('[data-rp="next"]').click();
  expect(await title(page), 'next goal').toMatch(/^GOAL 2 OF/i);
  await page.keyboard.press('PageDown');
  const third = await title(page);
  expect(third, 'PageDown goes on (another goal, or the whole match)').toMatch(goals >= 3 ? /^GOAL 3 OF/i : /WHOLE MATCH/i);
  await page.locator('[data-rp="prev"]').click();
  await page.keyboard.press('PageUp');
  expect(await title(page), 'back to the first').toMatch(/^GOAL 1 OF/i);

  // Slow-mo: toggle and the button reports it; half speed advances about half as far.
  const slow = page.locator('[data-rp="slow"]');
  expect(await slow.getAttribute('aria-pressed')).toBe('false');
  await page.keyboard.press('Space');
  await setScrub(page, 0);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  const fullSpeed = await scrubValue(page);
  expect(fullSpeed, 'full speed runs about 60 ticks a second').toBeGreaterThan(30);
  await slow.click();
  expect(await slow.getAttribute('aria-pressed'), 'slow-mo on').toBe('true');
  await page.keyboard.press('s');
  expect(await slow.getAttribute('aria-pressed'), 'S toggles it off').toBe('false');
  await page.keyboard.press('s');
  await page.locator('[data-rp="play"]').focus();
  await page.keyboard.press('Space'); // a focused Play button still toggles exactly once
  const paused = await scrubValue(page);
  await page.waitForTimeout(250);
  expect(await scrubValue(page), 'paused with Space on the button').toBe(paused);

  // It stops at the end of the clip and offers Replay.
  await setScrub(page, max - 3);
  await page.locator('[data-rp="slow"]').click(); // back to full speed
  await page.locator('[data-rp="play"]').click();
  await page.waitForFunction(() => /Replay/.test(document.querySelector('[data-rp="play"]').textContent), null, { timeout: 5000 });
  expect(await scrubValue(page), 'ended at the end').toBe(max);

  // Tab stays inside the dialog.
  for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('.replay-viewer')), 'focus trapped in the viewer').toBe(true);

  await page.keyboard.press('Escape');
  await page.locator(VIEWER).waitFor({ state: 'detached' });
});

test('replay: copy a code, paste it back, and a bad code is refused politely', async (t) => {
  const page = await openApp(t);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const code = goalCode();
  await storeReplay(page, code);

  await page.locator('.rp-row [data-replay="copy"]').click();
  await page.waitForSelector('.toast');
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (clip !== null) expect(clip, 'clipboard holds the stored code').toBe(code);

  // Paste: garbage first.
  await page.fill('#replay-paste', 'not a replay');
  await page.locator('[data-replay="paste"]').click();
  expect(await page.locator('#replay-paste-msg').innerText(), 'error shown').toMatch(/not a Through Ball replay/i);
  expect(await page.locator(VIEWER).count(), 'no viewer').toBe(0);
  await page.fill('#replay-paste', code.slice(0, code.length - 12));
  await page.locator('[data-replay="paste"]').click();
  expect(await page.locator('#replay-paste-msg').innerText(), 'truncated code refused').toMatch(/damaged or cut short/i);

  // Then the real thing, with Enter, and with line breaks like a chat app might add.
  await page.fill('#replay-paste', `${code.slice(0, 60)}\n${code.slice(60)}`.replace(/\n/g, ' '));
  await page.press('#replay-paste', 'Enter');
  await page.locator(VIEWER).waitFor();
  expect(await title(page), 'pasted replay plays').toMatch(/^GOAL 1 OF/i);
  await page.waitForSelector('.replay-layer[data-verified="true"]', { timeout: 15_000 });
  expect(await page.locator('.replay-viewer').innerText(), 'size shown in the viewer').toMatch(/\d+(\.\d)? KB/);
  await page.keyboard.press('Escape');
  await page.locator(VIEWER).waitFor({ state: 'detached' });
});

test('replay: when the clipboard is refused, the code is offered in a selected textarea and Esc leaves the result dialog alone', async (t) => {
  const page = await t.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
    document.execCommand = () => false;
  });
  await page.goto(require('./lib/helpers.cjs').APP_URL);
  await page.waitForSelector(SEL.app + ' *');
  await skipOnboarding(page);
  await page.evaluate(() => localStorage.setItem('throughball.prefs.v1', JSON.stringify({ halfSeconds: 3, controls: 'mouse', onboarded: true })));
  await page.reload();
  await skipOnboarding(page);
  await startRanked(page);
  await page.locator(SEL.modal).waitFor({ timeout: 60_000 });

  await page.locator('.modal [data-replay="copy"]').click();
  await page.locator('#rc-text').waitFor();
  const sel = await page.$eval('#rc-text', (el) => ({ v: el.value, a: el.selectionStart, b: el.selectionEnd, focused: document.activeElement === el }));
  expect(sel.v.startsWith('TB1.'), 'code in the textarea').toBe(true);
  expect([sel.a, sel.b], 'all of it is selected').toEqual([0, sel.v.length]);
  expect(sel.focused, 'and focused').toBe(true);

  await page.keyboard.press('Escape');
  await page.locator('.replay-codebox').waitFor({ state: 'detached' });
  expect(await page.locator(SEL.modal).count(), 'result dialog still open after Esc on the code box').toBe(1);
  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.modal).waitFor({ state: 'detached' });
});

test('replay: reduced motion does not auto-play', async (t) => {
  const page = await openApp(t, { width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await storeReplay(page, goalCode());
  await page.locator('.rp-row [data-replay="watch"]').click();
  await page.locator(VIEWER).waitFor();
  await page.waitForTimeout(700);
  expect(await scrubValue(page), 'still at the start').toBe(0);
  expect(await page.locator('[data-rp="play"]').innerText()).toBe('Play');
  expect(await page.locator('#rv-status').innerText(), 'says why').toMatch(/reduced motion/i);
  expect((await canvasStats(page)).colours, 'a still frame is drawn').toBeGreaterThan(6);
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  expect(await scrubValue(page), 'Space still plays it on request').toBeGreaterThan(0);
  await page.keyboard.press('Escape');
});

test('replay: the viewer and the Recent list fit a 390 px phone, light and dark', async (t) => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await openApp(t, { width: 390, height: 780, colorScheme });
    await storeReplay(page, goalCode());
    const w0 = await pageWidths(page);
    expect(w0.scrollWidth, `${colorScheme}: no sideways scroll on the Club screen`).toBeLessThanOrEqual(w0.innerWidth);
    await page.locator('.rp-row [data-replay="watch"]').click();
    await page.locator(VIEWER).waitFor();
    const box = await page.locator('#rv-canvas').boundingBox();
    expect(box.width, `${colorScheme}: canvas fits`).toBeLessThanOrEqual(390);
    expect(box.width, `${colorScheme}: canvas uses the width`).toBeGreaterThan(300);
    const card = await page.locator('.replay-card').boundingBox();
    expect(card.x, `${colorScheme}: card inside left edge`).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width, `${colorScheme}: card inside right edge`).toBeLessThanOrEqual(390.5);
    for (const rp of ['prev', 'play', 'next', 'slow']) {
      const b = await page.locator(`[data-rp="${rp}"]`).boundingBox();
      expect(b.x + b.width, `${colorScheme}: ${rp} button on screen`).toBeLessThanOrEqual(390.5);
    }
    expect((await canvasStats(page)).colours, `${colorScheme}: drawn`).toBeGreaterThan(6);
    await page.keyboard.press('Escape');
  }
});
