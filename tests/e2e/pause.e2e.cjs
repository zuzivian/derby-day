// Pause, full time and the keyboard (red-team round 1): after the final whistle there is no pause
// menu and no forfeit; in the pause menu Space presses the focused button or checkbox instead of
// queueing a pass for when play resumes.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, readSave, startRanked } = require('./lib/helpers.cjs');

async function waitFor(page, fn, arg, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

test('after the final whistle Esc opens no pause menu, and the result stands', async (t) => {
  const page = await openApp(t, { prefs: { halfSeconds: 3 }, e2eHook: true });
  const before = await readSave(page);
  await startRanked(page);
  expect(await waitFor(page, () => window.__derbyMatch && window.__derbyMatch.phase === 'fulltime', null, 60_000), 'the match reaches full time').toBe(true);
  const score = await page.evaluate(() => [...window.__derbyMatch.score]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  expect(await page.locator(SEL.pause).isVisible(), 'no pause menu after full time').toBe(false);
  await page.locator(SEL.modal).waitFor({ timeout: 30_000 });
  const after = await readSave(page);
  expect(after.history.length, 'one match recorded').toBe(before.history.length + 1);
  const rec = after.history.at(-1);
  expect([rec.goalsFor, rec.goalsAgainst], 'the real score, not a 0-3 forfeit').toEqual(score);
});

test('in the pause menu Space presses the focused button and checkbox, and nothing is passed on resume', async (t) => {
  const page = await openApp(t, { prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d' });
  await startRanked(page);
  await waitFor(page, () => window.__derbyMatch && window.__derbyMatch.phase === 'play');
  // Our man on the ball, everyone else frozen.
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const me = s.players[s.controlled[0]];
    for (const p of s.players) if (p !== me) p.stun = 1e7;
    s.ball.owner = me.i;
    s.ball.pos = { x: me.pos.x + 0.4, y: me.pos.y };
    s.ball.vel = { x: 0, y: 0 };
  });
  await page.keyboard.press('Escape');
  await page.locator(SEL.pause).waitFor({ state: 'visible' });
  const box = page.locator('#opt-replays');
  if (await box.isVisible()) {
    const was = await box.isChecked();
    await box.focus();
    await page.keyboard.press('Space');
    expect(await box.isChecked(), 'Space toggles the focused checkbox').toBe(!was);
    await page.keyboard.press('Space');
  }
  const owner = await page.evaluate(() => window.__derbyMatch.ball.owner);
  await page.locator(SEL.resume).focus();
  await page.keyboard.press('Space');
  await page.locator(SEL.pause).waitFor({ state: 'hidden', timeout: 3000 });
  // Let play run a moment: no phantom pass from the Space presses in the menu.
  const t0 = await page.evaluate(() => window.__derbyMatch.tick);
  await waitFor(page, (t) => window.__derbyMatch.tick > t + 40, t0, 15_000);
  const b = await page.evaluate(() => ({ owner: window.__derbyMatch.ball.owner, v: Math.hypot(window.__derbyMatch.ball.vel.x, window.__derbyMatch.ball.vel.y) }));
  expect(b.owner, 'still on the ball').toBe(owner);
  expect(b.v, 'not kicked').toBeLessThan(4);
});
