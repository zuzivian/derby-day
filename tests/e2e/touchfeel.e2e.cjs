// Touch feel on a phone (390x844, real touch events through CDP): the Pass / Shoot pads take a thumb that lands a
// little off them, a cancelled press never kicks, and a fresh finger far from the last one steers from where it
// lands (the run target used to glide there over six or seven ticks).

const { test, expect } = require('./lib/harness.cjs');
const { openApp, SEL } = require('./lib/helpers.cjs');

async function phone(t) {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true, renderer: '2d', e2eHook: true });
  await page.locator(SEL.kickOff).click();
  await page.waitForSelector(SEL.pitch);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.tick > 5);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, pts = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ id: i, radiusX: 8, radiusY: 8, force: 1, ...p })) });
  // The kick-off is yours: tap Pass (as a player would) so the match is in open play and the pointer is live.
  const pad = await page.evaluate(() => document.querySelector('#pad-pass').getBoundingClientRect().toJSON());
  await touch('touchStart', [{ x: pad.left + 33, y: pad.top + 33 }]);
  await page.waitForTimeout(50);
  await touch('touchEnd');
  await page.waitForFunction(() => { const s = window.__derbyMatch; return s.phase === 'play' && !s.restart; }, null, { timeout: 15_000 });
  return { page, touch };
}

/** The human's man has the ball and nobody else moves; any kick shows as the ball leaving him. */
const carrier = (page) =>
  page.evaluate(() => {
    const s = window.__derbyMatch;
    const me = s.players[s.controlled[0]];
    for (const p of s.players) if (p !== me) p.stun = 1e7;
    s.switchTimer[0] = 1e9;
    Object.assign(me, { stun: 0, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 } });
    Object.assign(s.ball, { owner: me.i, pos: { x: me.pos.x + 1, y: me.pos.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1, touch: 0 });
  });
const kicked = (page) => page.evaluate(() => { const s = window.__derbyMatch; return s.ball.owner !== s.controlled[0]; });
const rect = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);

test('touch: a thumb 8 px off a pad still presses it; 16 px off steers instead', async (t) => {
  const { page, touch } = await phone(t);
  const pass = await rect(page, '#pad-pass');
  const shoot = await rect(page, '#pad-shoot');
  const spots = [
    ['left of Pass', pass.left - 8, pass.top + 33, true],
    ['above Pass', pass.left + 33, pass.top - 8, true],
    ['between the pads', pass.right + 5, pass.top + 33, true],
    ['right of Shoot', shoot.right + 8, shoot.top + 33, true],
    ['below Shoot', shoot.left + 33, shoot.bottom + 8, true],
    ['16 px left of Pass', pass.left - 16, pass.top + 33, false],
  ];
  for (const [what, x, y, hit] of spots) {
    await carrier(page);
    await touch('touchStart', [{ x, y }]);
    await page.waitForTimeout(50);
    await touch('touchEnd');
    await page.waitForTimeout(200);
    expect(await kicked(page), `${what}: ${hit ? 'kicks' : 'does not kick'}`).toBe(hit);
  }
});

test('touch: a pad press the system cancels does not kick', async (t) => {
  const { page, touch } = await phone(t);
  for (const id of ['#pad-pass', '#pad-shoot']) {
    await carrier(page);
    const r = await rect(page, id);
    await touch('touchStart', [{ x: r.left + 33, y: r.top + 33 }]);
    await page.waitForTimeout(60);
    await touch('touchCancel');
    await page.waitForTimeout(250);
    expect(await kicked(page), `${id} cancelled`).toBe(false);
  }
});

test('touch: a fresh finger far from the last one is aimed at on the very first tick', async (t) => {
  const { page, touch } = await phone(t);
  const r = await rect(page, '#pitch');
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    let tk = s.tick;
    window.__aims = [];
    Object.defineProperty(s, 'tick', { get: () => tk, set: (v) => { tk = v; const a = s.humanAim && s.humanAim[0]; window.__aims.push({ tick: v, x: a && a.x, y: a && a.y }); } });
    window.__downTick = [];
    window.addEventListener('pointerdown', () => window.__downTick.push(s.tick), true);
  });
  await touch('touchStart', [{ x: r.left + 50, y: r.top + 100 }]);
  await page.waitForTimeout(250);
  await touch('touchEnd');
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__aims.length = 0; window.__downTick.length = 0; });
  await touch('touchStart', [{ x: r.left + 300, y: r.top + 450 }]);
  await page.waitForTimeout(400);
  const { aims, down } = await page.evaluate(() => ({ aims: window.__aims.slice(), down: window.__downTick[0] }));
  await touch('touchEnd');
  const final = aims[aims.length - 1];
  // The tick hook reads the previous step's aim: the first step that can see the new finger shows at down + 2.
  const first = aims.find((a) => a.tick >= down + 2);
  expect(Math.hypot(first.x - final.x, first.y - final.y), `the first tick that sees the finger already aims at it (${JSON.stringify(first)} vs ${JSON.stringify(final)})`).toBeLessThan(0.3);
});
