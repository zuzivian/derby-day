// Readable players on an upright phone (review of #19): in the long view they are drawn 4 to 5 px
// tall, so each gets a shirt-coloured dot; on a desktop the long view has none.

const { test, expect } = require('./lib/harness.cjs');
const { openApp, startRanked } = require('./lib/helpers.cjs');

async function waitFor(page, fn, arg, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** Give our keeper the ball in his hands (the long view), everyone else stood still. */
const keeperBall = (page) =>
  page.evaluate(() => {
    const s = window.__derbyMatch;
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK');
    for (const p of s.players) if (p !== gk) p.stun = 1e7;
    s.ball.owner = gk.i;
    s.ball.inHands = true;
    s.ball.pos = { ...gk.pos };
    s.ball.vel = { x: 0, y: 0 };
    s.ball.z = 1;
  });

for (const [w, h, want] of [
  [390, 844, 'on'],
  [1280, 800, 'off'],
]) {
  test(`3D view: the keeper's long view at ${w}x${h} has player dots ${want}`, async (t) => {
    const page = await openApp(t, { width: w, height: h, prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d' });
    await startRanked(page);
    expect(await waitFor(page, () => window.__derbyMatch && window.__derbyMatch.phase === 'play'), 'kick-off').toBe(true);
    await keeperBall(page);
    expect(await waitFor(page, () => document.querySelector('#pitch').dataset.camera === 'long', null, 10_000), 'the long view').toBe(true);
    expect(await waitFor(page, (v) => document.querySelector('#pitch').dataset.dots === v, want, 10_000), `dots ${want}`).toBe(true);
  });
}
