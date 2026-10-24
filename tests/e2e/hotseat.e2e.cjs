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
  const page = await openApp(t, { prefs: { halfSeconds: 6, controls: 'keys' }, e2eHook: true });
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
  // Wait for play to start (the HUD clock moves) rather than a fixed time: a software-rendered 3D
  // view can take a couple of seconds to get its first frames up.
  await page.waitForFunction(() => (document.getElementById('sb-clock')?.textContent ?? '00:00') !== '00:00', null, { timeout: 15_000 });
  await page.waitForTimeout(250);
  // Hold keys for a stretch of SIM time, not wall time: a software-rendered 3D view on a slow runner
  // gives the sim at most 0.2 s per frame, so 500 ms of wall time could be a single sampled frame
  // (CI once saw player 1 move 0.4 m in a 500 ms hold). The count starts when the team's man starts
  // moving, because under load the key event itself can land a few frames late. 60 ticks = 1 s.
  const hold = async (keys, ticks, team, dir) => {
    for (const k of keys) await page.keyboard.down(k);
    const start = await page.waitForFunction(([team, dir]) => {
      const s = window.__derbyMatch;
      const v = s.players[s.controlled[team]].vel;
      return v.x * dir.x + v.y * dir.y > 0.3 ? s.tick : null; // moving the way the key says (not still coasting from the last hold)
    }, [team, dir], { timeout: 20_000, polling: 'raf' });
    const until = (await start.jsonValue()) + ticks;
    await page.waitForFunction((t) => window.__derbyMatch.tick >= t, until, { timeout: 20_000, polling: 30 });
    for (const k of keys) await page.keyboard.up(k);
  };
  // Pin each human to the man they start on: the auto-switch hands control to whoever is nearest the
  // ball, and player 2's man running away from it gets switched off after about 40 ticks, which would
  // make the next step measure a different player. Switching has its own tests (controls.e2e.cjs).
  await page.evaluate(() => { window.__derbyMatch.switchTimer[0] = window.__derbyMatch.switchTimer[1] = 1e9; });
  const a1 = await pos(page, 'p1');
  const a2 = await pos(page, 'p2');
  await hold(['ArrowDown'], 42, 1, { x: 0, y: 1 });
  const b1 = await pos(page, 'p1');
  const b2 = await pos(page, 'p2');
  expect(b2.i, 'player 2 still on the same player').toBe(a2.i);
  expect(b2.y - a2.y, 'player 2 ran down on the arrow key').toBeGreaterThan(2);
  expect(Math.hypot(b1.x - a1.x, b1.y - a1.y), 'player 1 stayed put meanwhile').toBeLessThan(1);
  await hold(['w'], 42, 0, { x: 0, y: -1 });
  const c1 = await pos(page, 'p1');
  expect(c1.i, 'player 1 still on the ball carrier').toBe(b1.i);
  expect(b1.y - c1.y, 'player 1 ran up on W').toBeGreaterThan(2);
  // Both at once. Park player 2's man 12 m below player 1 and freeze everyone else, so the two
  // paths can't cross: running straight at each other, player 2 can win the ball
  // off player 1 and pin him (CI saw 0.5 m), which says nothing about whether both keyboards steer.
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const me = s.players[s.controlled[0]];
    const p2 = s.players[s.controlled[1]];
    for (const p of s.players) if (p !== me && p !== p2) p.stun = 1e7;
    Object.assign(p2, { pos: { x: me.pos.x + 2, y: me.pos.y + 12 }, vel: { x: 0, y: 0 } });
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // the pitch's data-p2 is written per frame
  const c2 = await pos(page, 'p2');
  await hold(['d', 'ArrowLeft'], 30, 0, { x: 1, y: 0 });
  const d1 = await pos(page, 'p1');
  const d2 = await pos(page, 'p2');
  expect(d1.x - c1.x, 'together: player 1 ran right on D').toBeGreaterThan(1);
  expect(d2.i, 'player 2 still on the same player').toBe(c2.i);
  expect(c2.x - d2.x, 'together: player 2 ran left on the arrow key').toBeGreaterThan(1);

  // Two 6 s halves (long enough that half-time never lands inside the holds): let it run to full-time.
  await page.locator(SEL.modal).waitFor({ timeout: 60_000 });
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
