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
  const title = await page.locator(S.endTitle).innerText();
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
  expect(save.cup.round, 'cup moved on only if you won').toBe(mine > theirs ? 1 : 0);
  expect(await page.locator(SEL.modal).innerText(), 'result mentions penalties').toMatch(/penalties/);
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
  await page.locator(S.start).click();
  await waitPhase(page, ['aim', 'telegraph']);
  await page.locator(S.leave).click();
  expect(await page.locator(S.leave).innerText(), 'asks to confirm').toMatch(/Really leave/);
  expect(await page.locator(SEL.modal).count(), 'one click does not leave').toBe(0);
  await page.locator(S.leave).click();
  await page.locator(SEL.modal).waitFor();
  const save = await readSave(page);
  const tie = save.cup.rounds[0].find((x) => x.a === save.club.id || x.b === save.club.id);
  expect(tie.winner === save.club.id, 'forfeit loses the tie').toBe(false);
  expect(save.cup.round, 'cup moved on without you').toBe(1);
  expect(await page.locator(SEL.modal).innerText(), 'result says you are out').toMatch(/Out in the quarter-final/);
});
