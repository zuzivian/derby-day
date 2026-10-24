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

test('with the HUD Menu button focused, WASD and the arrows still move the player; Enter opens the menu', async (t) => {
  // Review of #19: a focused HUD button swallowed every game key, so a keyboard player who had Tabbed
  // onto Mute, Menu or Cam could not move.
  const page = await openApp(t, { prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d' });
  await startRanked(page);
  await waitFor(page, () => window.__derbyMatch && window.__derbyMatch.phase === 'play');
  const freeze = () =>
    page.evaluate(() => {
      const s = window.__derbyMatch;
      const me = s.players[s.controlled[0]];
      for (const p of s.players) if (p !== me) p.stun = 1e7;
      me.pos = { x: 52, y: 34 };
      me.vel = { x: 0, y: 0 };
      s.ball.owner = me.i;
      s.ball.pos = { x: 52.4, y: 34 };
      s.ball.vel = { x: 0, y: 0 };
      return me.i;
    });
  const posOf = (i) => page.evaluate((i) => ({ ...window.__derbyMatch.players[i].pos }), i);
  await page.locator('#pause-btn').focus();
  // Without a key he stays put (so the movement below is the key's).
  const i0 = await freeze();
  const a0 = await posOf(i0);
  await page.waitForTimeout(700);
  const b0 = await posOf(i0);
  expect(Math.hypot(b0.x - a0.x, b0.y - a0.y), 'no key, no run').toBeLessThan(0.5);
  for (const key of ['d', 'ArrowLeft']) {
    const i = await freeze();
    const a = await posOf(i);
    await page.keyboard.down(key);
    await page.waitForTimeout(700);
    await page.keyboard.up(key);
    const b = await posOf(i);
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'the Menu button still has focus').toBe('pause-btn');
    expect(Math.hypot(b.x - a.x, b.y - a.y), `${key} moves him with the Menu button focused`).toBeGreaterThan(1);
  }
  await page.keyboard.press('Enter');
  await page.locator(SEL.pause).waitFor({ state: 'visible', timeout: 3000 });
});
