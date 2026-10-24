// Local 2P (hot-seat): pick a ladder opponent, kick off, both players move on their own keys,
// and the result records nothing.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, readSave } = require('./lib/helpers.cjs');

const pos = async (page, which) => {
  const v = await page.locator(SEL.pitch).getAttribute(`data-${which}`);
  if (!v) throw new Error(`no data-${which} on the pitch`);
  const [i, x, y] = v.split(',').map(Number);
  return { i, x, y };
};

test('Local 2P: pick an opponent, both players steer their own team, nothing is recorded', async (t) => {
  const page = await openApp(t, { prefs: { halfSeconds: 4, controls: 'keys' } });
  const before = await readSave(page);
  await goTab(page, SEL.homeScreen);
  await page.locator(SEL.playLocal2p).click();
  await page.waitForSelector(SEL.l2pStart);
  const options = await page.locator(`${SEL.l2pOpp} option`).count();
  expect(options, 'every ladder club is offered').toBe(before.ladder.length);
  const pick = await page.locator(`${SEL.l2pOpp} option`).nth(2).getAttribute('value');
  await page.selectOption(SEL.l2pOpp, pick);
  const pickedName = before.ladder.find((c) => c.id === pick).name;
  await page.locator(SEL.l2pStart).click();
  await page.waitForSelector(SEL.pitch);
  expect(await page.locator('.scoreboard').innerText(), 'the picked club is the away side').toContain(pickedName);

  // Kick-off pause; player 1 holds the ball at the centre spot. Player 2 runs down on the arrows,
  // then player 1 runs up on W, each while the other is idle; then both at once, sideways.
  await page.waitForTimeout(1100);
  const hold = async (keys, ms) => {
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(ms);
    for (const k of keys) await page.keyboard.up(k);
  };
  const a1 = await pos(page, 'p1');
  const a2 = await pos(page, 'p2');
  await hold(['ArrowDown'], 700);
  const b1 = await pos(page, 'p1');
  const b2 = await pos(page, 'p2');
  expect(b2.i, 'player 2 still on the same player').toBe(a2.i);
  expect(b2.y - a2.y, 'player 2 ran down on the arrow key').toBeGreaterThan(2);
  expect(Math.hypot(b1.x - a1.x, b1.y - a1.y), 'player 1 stayed put meanwhile').toBeLessThan(1);
  await hold(['w'], 700);
  const c1 = await pos(page, 'p1');
  expect(c1.i, 'player 1 still on the ball carrier').toBe(b1.i);
  expect(b1.y - c1.y, 'player 1 ran up on W').toBeGreaterThan(2);
  const c2 = await pos(page, 'p2');
  await hold(['d', 'ArrowLeft'], 500);
  const d1 = await pos(page, 'p1');
  const d2 = await pos(page, 'p2');
  expect(d1.x - c1.x, 'together: player 1 ran right on D').toBeGreaterThan(1);
  if (d2.i === c2.i) expect(c2.x - d2.x, 'together: player 2 ran left on the arrow key').toBeGreaterThan(1);

  // Two 4 s halves: let it run to full-time.
  await page.locator(SEL.modal).waitFor({ timeout: 40_000 });
  const modal = await page.locator(SEL.modal).innerText();
  expect(modal, 'result dialog says Local 2P').toMatch(/Local 2P/i);
  expect(modal, 'and that nothing is recorded').toMatch(/no Elo/i);
  const after = await readSave(page);
  expect(after.club.elo, 'Elo unchanged').toBe(before.club.elo);
  expect(after.history.length, 'no match recorded').toBe(before.history.length);
  expect(after.trainingPoints, 'no training sessions').toBe(before.trainingPoints);
  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.modal).waitFor({ state: 'detached' });
  expect(await page.locator(SEL.playLocal2p).count(), 'back on the club screen').toBe(1);
});
