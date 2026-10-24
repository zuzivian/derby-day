// The 3D match view: camera zoom (wheel and keys, remembered), the camera chip, and instant replays
// (shown at the stoppage after a goal, the live match held while it plays, skippable, resuming on the
// tick it stopped at). Uses the e2e hook (window.__derbyMatch) to set scenes up.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, startRanked } = require('./lib/helpers.cjs');

const LONG = { halfSeconds: 600 };

const pitchData = (page) => page.evaluate(() => ({ ...document.querySelector('#pitch').dataset }));
const tick = (page) => page.evaluate(() => window.__derbyMatch.tick);

async function waitFor(page, fn, arg, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

test('3D view: the mouse wheel and + / - zoom the camera, within limits, and the zoom is remembered', async (t) => {
  const page = await openApp(t, { prefs: LONG, renderer: '3d' });
  await startRanked(page);
  if ((await pitchData(page)).renderer !== '3d') return; // no WebGL2 here: nothing to zoom
  const zoom = () => page.evaluate(() => Number(localStorage.getItem('derby-zoom') || '1'));
  const box = await page.locator(SEL.pitch).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(150);
  const out = await zoom();
  expect(out, 'wheel down zooms out').toBeGreaterThan(1);
  expect(await page.locator('#cam-btn').innerText(), 'the chip says the new zoom').toMatch(/zoom \d+%/i);
  for (let i = 0; i < 12; i++) await page.keyboard.press('Minus');
  const tight = await zoom();
  expect(tight, 'minus zooms in').toBeLessThan(out);
  expect(tight, 'but not past the limit').toBeGreaterThanOrEqual(0.59);
  // The page itself did not scroll on the wheel.
  expect(await page.evaluate(() => window.scrollY), 'wheel over the pitch does not scroll the page').toBe(0);
  await page.keyboard.press('0');
  expect(await zoom(), '0 resets').toBe(1);
  await page.keyboard.press('Equal');
  const kept = await zoom();
  await page.reload();
  await page.waitForSelector(SEL.app + ' *');
  expect(await zoom(), 'remembered across reloads').toBe(kept);
});

test('3D view: a goal gets an instant replay at the stoppage; the live match waits, Space skips, play resumes where it stopped', async (t) => {
  const page = await openApp(t, { prefs: LONG, renderer: '3d', e2eHook: true });
  await startRanked(page);
  if ((await pitchData(page)).renderer !== '3d') return;
  await waitFor(page, () => window.__derbyMatch.phase === 'play');
  // Score: the ball flies into the far goal off the human's player.
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const me = s.players[s.controlled[0]];
    const b = s.ball;
    b.owner = -1;
    // Keeper out of the way, so it goes in.
    for (const k of s.players) if (k.team === 1 && k.role === 'GK') k.pos = { x: 100, y: 40 };
    b.pos = { x: 95, y: 31.5 };
    b.vel = { x: 26, y: 0 };
    b.z = 0.3;
    b.vz = 0.5;
    b.lastTouch = me.i;
    s.stats[0].shots++;
  });
  expect(await waitFor(page, () => window.__derbyMatch.score[0] === 1), 'the goal counts').toBe(true);
  expect(await waitFor(page, () => !!document.querySelector('#pitch').dataset.replay), 'a replay starts').toBe(true);
  const d = await pitchData(page);
  expect(d.replay, 'it is the goal').toBe('goal');
  expect(d.camera, 'with a replay camera').toMatch(/^replay-/);
  expect(await page.locator('.hud-replay').isVisible(), 'REPLAY shows in the HUD').toBe(true);
  expect(await page.locator('.hud-replay').innerText(), 'with what it is').toMatch(/goal/i);
  // The live sim is held.
  const held = await tick(page);
  await page.waitForTimeout(900);
  expect(await tick(page), 'the live match does not move during the replay').toBe(held);
  await page.keyboard.press('Space');
  expect(await waitFor(page, () => !document.querySelector('#pitch').dataset.replay, null, 5000), 'Space skips it').toBe(true);
  expect(await page.locator('.hud-replay').isVisible(), 'REPLAY gone').toBe(false);
  expect(await page.locator(SEL.pause).isVisible(), 'skipping did not pause the match').toBe(false);
  // Play resumes from the tick it stopped on (give it a moment to step on).
  await page.waitForTimeout(600);
  const after = await tick(page);
  expect(after, 'the match runs again').toBeGreaterThan(held);
  expect(after - held, 'from where it stopped, not jumped ahead').toBeLessThan(60 * 8);
  // One replay per stoppage: nothing else starts before play is live again.
  await page.waitForTimeout(800);
  expect((await pitchData(page)).replay, 'no second replay in this stoppage').toBe(undefined);
});

test('3D view: instant replays can be turned off in the pause menu', async (t) => {
  const page = await openApp(t, { prefs: LONG, renderer: '3d', e2eHook: true });
  await startRanked(page);
  if ((await pitchData(page)).renderer !== '3d') return;
  await page.keyboard.press('Escape');
  await page.locator(SEL.pause).waitFor({ state: 'visible' });
  const box = page.locator('#opt-replays');
  expect(await box.isChecked(), 'on by default').toBe(true);
  await box.uncheck();
  expect(await page.evaluate(() => localStorage.getItem('derby-instant-replays')), 'stored').toBe('off');
  await page.locator(SEL.resume).click();
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const b = s.ball;
    b.owner = -1;
    // Keeper out of the way, so it goes in.
    for (const k of s.players) if (k.team === 1 && k.role === 'GK') k.pos = { x: 100, y: 40 };
    b.pos = { x: 95, y: 31.5 };
    b.vel = { x: 26, y: 0 };
    b.z = 0.3;
    b.lastTouch = s.controlled[0];
  });
  expect(await waitFor(page, () => window.__derbyMatch.score[0] === 1), 'the goal counts').toBe(true);
  const start = await tick(page);
  await waitFor(page, (t0) => window.__derbyMatch.tick > t0 + 60 * 4, start, 30_000);
  expect((await pitchData(page)).replay, 'no replay').toBe(undefined);
});
