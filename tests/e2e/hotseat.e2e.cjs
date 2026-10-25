// Local 2P (hot-seat): pick a ladder opponent, kick off, both players move on their own keys,
// and the result records nothing.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, readSave } = require('./lib/helpers.cjs');

// Where each human's man is, read from the sim. The pitch's data-p1/data-p2 hooks are only written
// when a frame is drawn, so under load they can lag the sim by a dozen ticks.
const pos = async (page, which) => {
  const p = await page.evaluate((team) => {
    const s = window.__derbyMatch;
    const m = s.players[s.controlled[team]];
    return { i: m.i, x: m.pos.x, y: m.pos.y };
  }, which === 'p1' ? 0 : 1);
  expect(await page.locator(SEL.pitch).getAttribute(`data-${which}`), `the pitch exposes data-${which}`).toBeTruthy();
  return p;
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

  // Player 1 kicks off and his teammate holds the ball near the centre spot. Player 2 runs down on the arrows,
  // then player 1 runs up on W, each while the other is idle; then both at once, sideways.
  // Wait for play to start (the HUD clock moves) rather than a fixed time: a software-rendered 3D
  // view can take a couple of seconds to get its first frames up.
  // The kick-off is a kick (Law 8): player 1 plays it with Space, then his teammate has the ball.
  await page.waitForFunction(() => window.__derbyMatch?.phase === 'restart' && window.__derbyMatch.restart?.kind === 'kickoff', null, { timeout: 15_000 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__derbyMatch.phase === 'play' && window.__derbyMatch.ball.owner >= 0 && Math.hypot(window.__derbyMatch.ball.vel.x, window.__derbyMatch.ball.vel.y) < 0.5, null, { timeout: 15_000, polling: 'raf' });
  await page.waitForTimeout(250);
  // Hold keys until each listed man has covered `dist` metres the way his key says, or for at most
  // two seconds of SIM time once they start moving, then let go; the assertions below check the
  // distances. Fixed holds were either wall time (a software-rendered 3D frame gives the sim at most
  // 0.2 s, so CI once saw 0.4 m in a 500 ms hold) or a tick count that sat too close to the
  // thresholds once acceleration and turning out of the previous run are counted (0.87 m for 1 m).
  const hold = async (keys, goals) => {
    await page.evaluate((goals) => {
      const s = window.__derbyMatch;
      window.__hold = { from: -1, start: goals.map((g) => ({ ...s.players[s.controlled[g.team]].pos })) };
    }, goals);
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForFunction((goals) => {
      const s = window.__derbyMatch;
      const h = window.__hold;
      let reached = 0;
      goals.forEach((g, n) => {
        const m = s.players[s.controlled[g.team]];
        // Count from when one moves the way his key says (under load the key event can land a few frames late).
        if (h.from < 0 && m.vel.x * g.dir.x + m.vel.y * g.dir.y > 0.3) h.from = s.tick;
        if ((m.pos.x - h.start[n].x) * g.dir.x + (m.pos.y - h.start[n].y) * g.dir.y >= g.dist + 0.3) reached++;
      });
      return reached === goals.length || (h.from >= 0 && s.tick >= h.from + 120);
    }, goals, { timeout: 30_000, polling: 'raf' });
    for (const k of keys) await page.keyboard.up(k);
  };
  // Pin each human to the man they start on: the auto-switch hands control to whoever is nearest the
  // ball, and player 2's man running away from it gets switched off after about 40 ticks, which would
  // make the next step measure a different player. Switching has its own tests (controls.e2e.cjs).
  await page.evaluate(() => { window.__derbyMatch.switchTimer[0] = window.__derbyMatch.switchTimer[1] = 1e9; });
  const a1 = await pos(page, 'p1');
  const a2 = await pos(page, 'p2');
  await hold(['ArrowDown'], [{ team: 1, dir: { x: 0, y: 1 }, dist: 2 }]);
  const b1 = await pos(page, 'p1');
  const b2 = await pos(page, 'p2');
  expect(b2.i, 'player 2 still on the same player').toBe(a2.i);
  expect(b2.y - a2.y, 'player 2 ran down on the arrow key').toBeGreaterThan(2);
  expect(Math.hypot(b1.x - a1.x, b1.y - a1.y), 'player 1 stayed put meanwhile').toBeLessThan(1);
  await hold(['w'], [{ team: 0, dir: { x: 0, y: -1 }, dist: 2 }]);
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
  const c2 = await pos(page, 'p2');
  await hold(['d', 'ArrowLeft'], [{ team: 0, dir: { x: 1, y: 0 }, dist: 1 }, { team: 1, dir: { x: -1, y: 0 }, dist: 1 }]);
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
