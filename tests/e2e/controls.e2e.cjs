// The mouse scheme in a real browser: real pointer events through InputController into the sim.
// The page exposes the live match as window.__derbyMatch when window.__e2e is set (openApp's
// e2eHook), so each test sets a scene up (who has the ball, where everyone stands), drives the
// mouse, and reads the match back.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, startRanked } = require('./lib/helpers.cjs');

const PREFS = { halfSeconds: 120, controls: 'mouse', onboarded: true };
// Pitch view in metres, see render.ts: the pitch plus a 2.6 m margin each side.
const VIEW_W = 64 + 5.2;
const VIEW_H = 40 + 5.2;
const MARGIN = 2.6;

async function openMatch(t) {
  // The 2D view: these tests place the pointer by world metres, and the 3D camera follows play.
  const page = await openApp(t, { prefs: PREFS, e2eHook: true, renderer: '2d' });
  await startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 15_000 });
  return page;
}

/** World metres to page pixels. */
async function screen(page, w) {
  const box = await page.locator(`${SEL.pitch}, #tr-pitch`).first().boundingBox();
  return { x: box.x + ((w.x + MARGIN) / VIEW_W) * box.width, y: box.y + ((w.y + MARGIN) / VIEW_H) * box.height };
}
async function moveTo(page, w) {
  const p = await screen(page, w);
  await page.mouse.move(p.x, p.y);
}
async function click(page, w, button = 'left') {
  const p = await screen(page, w);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button });
  await page.waitForTimeout(40);
  await page.mouse.up({ button });
}
async function hold(page, w, ms, button = 'left') {
  const p = await screen(page, w);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button });
  await page.waitForTimeout(ms);
  await page.mouse.up({ button });
}

/** The human's player has the ball at `at`; everybody else is on the floor, and control stays put. Returns his index. */
const carrier = (page, at) =>
  page.evaluate((at) => {
    const s = window.__derbyMatch;
    const me = s.players[s.controlled[0]];
    for (const p of s.players) if (p !== me) p.stun = 1e7;
    s.switchTimer[0] = 1e9;
    Object.assign(me, { stun: 0, pos: { ...at }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 } });
    Object.assign(s.ball, { owner: me.i, pos: { x: at.x + 1, y: at.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1, touch: 0 });
    return me.i;
  }, at);

/** Wait for the kick, then put the kicker on the floor so he cannot collect the ball again. */
async function afterKick(page, me) {
  await page.waitForFunction(() => window.__derbyMatch.ball.owner === -1, null, { polling: 'raf', timeout: 4000 });
  await page.evaluate((i) => {
    window.__derbyMatch.players[i].stun = 1e7;
  }, me);
}

const ball = (page) => page.evaluate(() => ({ ...window.__derbyMatch.ball.pos, z: window.__derbyMatch.ball.z, vx: window.__derbyMatch.ball.vel.x, vy: window.__derbyMatch.ball.vel.y, receiver: window.__derbyMatch.ball.receiver }));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Track the ball's peak height and first touchdown from now on, once per animation frame. */
const startTracking = (page) =>
  page.evaluate(() => {
    const s = window.__derbyMatch;
    window.__track = { peak: 0, air: false, td: null };
    const f = () => {
      const k = window.__track;
      if (s.ball.owner < 0) {
        k.peak = Math.max(k.peak, s.ball.z);
        if (s.ball.z > 0) k.air = true;
        else if (k.air && !k.td) k.td = { x: s.ball.pos.x, y: s.ball.pos.y };
      }
      requestAnimationFrame(f);
    };
    f();
  });
const tracked = (page) => page.evaluate(() => window.__track);

test('mouse: the further the pointer, the faster the player runs, and a far pointer sprints with no key held', async (t) => {
  const page = await openMatch(t);
  const run = async (dx) => {
    await page.evaluate(() => {
      const s = window.__derbyMatch;
      const me = s.players[s.controlled[0]];
      for (const p of s.players) if (p !== me) p.stun = 1e7;
      s.switchTimer[0] = 1e9;
      Object.assign(me, { stun: 0, pos: { x: 8, y: 20 }, vel: { x: 0, y: 0 }, energy: 1, winded: false });
      Object.assign(s.ball, { owner: -1, pos: { x: 60, y: 3 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1 });
      s.ball.noPickup.fill(1e7);
    });
    // Keep the pointer a fixed distance ahead of him while he runs.
    const samples = [];
    for (let i = 0; i < 8; i++) {
      const me = await page.evaluate(() => {
        const s = window.__derbyMatch;
        const m = s.players[s.controlled[0]];
        return { x: m.pos.x, y: m.pos.y, speed: Math.hypot(m.vel.x, m.vel.y), sprinting: m.sprinting };
      });
      await moveTo(page, { x: Math.min(63, me.x + dx), y: 20 });
      await page.waitForTimeout(110);
      if (i >= 5) samples.push(me);
      if (me.x > 50) await page.evaluate(() => (window.__derbyMatch.players[window.__derbyMatch.controlled[0]].pos.x = 8));
    }
    return { speed: Math.max(...samples.map((m) => m.speed)), sprinting: samples.some((m) => m.sprinting) };
  };
  const near = await run(2.5);
  const jog = await run(6);
  const far = await run(16);
  expect(near.sprinting, 'close pointer: no sprint').toBe(false);
  expect(jog.sprinting, 'a jog is not a sprint').toBe(false);
  expect(far.sprinting, 'far pointer: sprinting without any key').toBe(true);
  expect(far.speed, 'far is faster than the jog').toBeGreaterThan(jog.speed + 0.5);
  expect(jog.speed, 'the jog is faster than the walk').toBeGreaterThan(near.speed + 1.5);
});

test('mouse with the ball: left click rolls it to the pointer, no snapping to a teammate', async (t) => {
  const page = await openMatch(t);
  const me = await carrier(page, { x: 20, y: 20 });
  const target = { x: 36, y: 27 };
  await click(page, target);
  await afterKick(page, me);
  const b = await ball(page);
  expect(b.receiver, 'a pass into space has no receiver').toBe(-1);
  await page.waitForTimeout(3200);
  const end = await ball(page);
  expect(dist(end, target), 'the ball ends up by the pointer').toBeLessThan(4);
  // Aimed the other way it goes the other way.
  await carrier(page, { x: 30, y: 20 });
  await click(page, { x: 12, y: 8 });
  await afterKick(page, me);
  await page.waitForTimeout(150);
  const west = await ball(page);
  expect(west.vx, 'rolls toward the pointer, west').toBeLessThan(-5);
  expect(west.vy, 'and north').toBeLessThan(-1);
});

test('mouse with the ball: holding left lofts it to the pointer, and a longer hold flies higher', async (t) => {
  const page = await openMatch(t);
  const target = { x: 32, y: 20 };
  const loft = async (ms) => {
    const me = await carrier(page, { x: 20, y: 20 });
    await startTracking(page);
    await hold(page, target, ms);
    await afterKick(page, me);
    await page.waitForFunction(() => window.__track.td, null, { polling: 'raf', timeout: 6000 });
    return tracked(page);
  };
  const short = await loft(330);
  expect(short.peak, 'it goes up').toBeGreaterThan(1.3);
  expect(dist(short.td, target), 'short hold lands at the pointer').toBeLessThan(3);
  const long = await loft(900);
  expect(dist(long.td, target), 'long hold lands at the pointer too').toBeLessThan(3);
  expect(long.peak, 'longer hold peaks higher').toBeGreaterThan(short.peak + 0.8);
  // A quick click is a ground pass, not a lob.
  const me = await carrier(page, { x: 20, y: 20 });
  await startTracking(page);
  await click(page, target);
  await afterKick(page, me);
  await page.waitForTimeout(1500);
  expect((await tracked(page)).peak, 'a click stays on the floor').toBeLessThan(0.1);
});

test('mouse with the ball: right click shoots at the pointer, hold right for power', async (t) => {
  const page = await openMatch(t);
  const target = { x: 52, y: 6 };
  const shot = async (ms) => {
    const me = await carrier(page, { x: 38, y: 24 });
    if (ms) await hold(page, target, ms, 'right');
    else await click(page, target, 'right');
    await afterKick(page, me);
    await page.waitForTimeout(30);
    const b = await ball(page);
    const want = { x: target.x - 39, y: target.y - 24 };
    const l = Math.hypot(want.x, want.y);
    const sp = Math.hypot(b.vx, b.vy);
    return { speed: sp, aim: (b.vx * want.x + b.vy * want.y) / (sp * l) };
  };
  const quick = await shot(0);
  expect(quick.aim, 'the quick shot goes toward the pointer').toBeGreaterThan(0.95);
  expect(quick.speed, 'a quick click is a real shot').toBeGreaterThan(14);
  const hard = await shot(900);
  expect(hard.aim, 'the held shot goes toward the pointer').toBeGreaterThan(0.93);
  expect(hard.speed, 'holding adds power').toBeGreaterThan(quick.speed + 3);
});

test('mouse without the ball: left click on a teammate switches to him, elsewhere picks the nearest that way', async (t) => {
  const page = await openMatch(t);
  const scene = await page.evaluate(() => {
    const s = window.__derbyMatch;
    const opp = s.players.find((p) => p.team === 1 && p.role === 'MID');
    Object.assign(s.ball, { owner: opp.i, pos: { x: 60, y: 38 }, vel: { x: 0, y: 0 }, receiver: -1, z: 0 });
    opp.pos = { x: 60, y: 38 };
    const mates = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    const [cur, east, west, south, spare] = mates;
    spare.pos = { x: 60, y: 38 }; // out of everyone's way
    for (const p of s.players) {
      p.vel = { x: 0, y: 0 };
      p.stun = 1e7;
    }
    cur.stun = 0;
    cur.pos = { x: 30, y: 20 };
    east.pos = { x: 46, y: 20 };
    west.pos = { x: 14, y: 21 };
    south.pos = { x: 31, y: 35 };
    s.controlled[0] = cur.i;
    s.switchTimer[0] = 1e9;
    return { cur: cur.i, east: east.i, west: west.i, south: south.i };
  });
  const ctrl = () => page.evaluate(() => window.__derbyMatch.controlled[0]);
  await click(page, { x: 46.5, y: 19.5 });
  expect(await ctrl(), 'clicking on a teammate switches to him').toBe(scene.east);
  await click(page, { x: 50, y: 5 });
  expect(await ctrl(), 'nobody that way: you stay on him').toBe(scene.east);
  await click(page, { x: 22, y: 21.5 });
  expect(await ctrl(), 'west of him: the nearest player that way, not the far one').toBe(scene.cur);
  await click(page, { x: 14.6, y: 21.4 });
  expect(await ctrl(), 'on the far player: him').toBe(scene.west);
  await click(page, { x: 25, y: 38 });
  expect(await ctrl(), 'south of him').toBe(scene.south);
});

test('mouse without the ball: right click tackles toward the pointer, and slides when the pointer is far', async (t) => {
  const page = await openMatch(t);
  const setup = (gap) =>
    page.evaluate((gap) => {
      const s = window.__derbyMatch;
      const me = s.players[s.controlled[0]];
      const opp = s.players.find((p) => p.team === 1 && p.role === 'MID');
      for (const p of s.players) p.stun = 1e7;
      Object.assign(me, { stun: 0, tackleCd: 0, pos: { x: 30, y: 20 }, vel: { x: 0, y: 0 } });
      Object.assign(opp, { stun: 0, pos: { x: 30 + gap, y: 20 }, vel: { x: 0, y: 0 } });
      opp.attrs.dribbling = 0;
      me.attrs.defending = 1;
      Object.assign(s.ball, { owner: opp.i, pos: { x: 30 + gap - 0.9, y: 20 }, vel: { x: 0, y: 0 }, z: 0, receiver: -1 });
      s.switchTimer[0] = 1e9;
      window.__cd = 0;
      const f = () => {
        window.__cd = Math.max(window.__cd, me.tackleCd);
        requestAnimationFrame(f);
      };
      f();
      return opp.i;
    }, gap);
  await setup(1.3);
  await click(page, { x: 31.5, y: 20 }, 'right');
  await page.waitForTimeout(250);
  const stand = await page.evaluate(() => window.__cd);
  expect(stand, 'a close pointer is a standing tackle').toBeGreaterThan(30);
  expect(stand, 'standing tackle cooldown').toBeLessThan(40);
  const opp = await setup(2.6);
  await click(page, { x: 36, y: 20 }, 'right');
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__cd), 'a far pointer slides: a longer recovery').toBeGreaterThan(60);
  void opp;
});

test('mouse: right click opens no context menu, and the hint text describes the new controls', async (t) => {
  const page = await openMatch(t);
  await page.evaluate(() => {
    window.__cm = null;
    document.querySelector('#pitch').addEventListener('contextmenu', (e) => (window.__cm = e.defaultPrevented));
  });
  await click(page, { x: 30, y: 20 }, 'right');
  expect(await page.evaluate(() => window.__cm), 'contextmenu is prevented').toBe(true);
  const hint = await page.locator('.controls-hint').innerText();
  expect(hint, 'mentions the left click pass').toMatch(/left click/i);
  expect(hint, 'mentions the loft hold').toMatch(/hold left/i);
  expect(hint, 'no middle button sprint any more').notToContain('middle');
  expect(hint, 'no Ctrl chords any more').notToContain('Ctrl');
});

test('keys still work as the secondary scheme: WASD runs, Shift sprints, Space passes', async (t) => {
  const page = await openApp(t, { prefs: { ...PREFS, controls: 'keys' }, e2eHook: true });
  await startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 15_000 });
  const me = await carrier(page, { x: 20, y: 20 });
  await page.keyboard.down('d');
  await page.keyboard.down('Shift');
  await page.waitForTimeout(700);
  const sprinting = await page.evaluate((i) => window.__derbyMatch.players[i].sprinting, me);
  await page.keyboard.up('Shift');
  await page.keyboard.up('d');
  expect(sprinting, 'Shift sprints in key mode').toBe(true);
  await page.keyboard.press('Space');
  await afterKick(page, me);
  expect((await ball(page)).vx, 'Space passed the ball on').toBeGreaterThan(3);
});

test('training ground: the move and pass drills are done with the pointer', async (t) => {
  // The 2D view: these tests place the pointer by world metres, and the 3D camera follows play.
  const page = await openApp(t, { prefs: PREFS, e2eHook: true, renderer: '2d' });
  await goTab(page, SEL.clubScreen);
  await page.locator('[data-action="replay-tutorial"]').click();
  await page.waitForSelector('#tr-pitch');
  expect(await page.locator('#coach-text').innerText(), 'the coach explains the speed by distance').toMatch(/further/i);
  // Drill 1: put the pointer on the marker.
  const marker = { x: 38, y: 12 };
  await moveTo(page, marker);
  await page.waitForSelector('.coach-dots li[data-drill="move"].done', { timeout: 15_000 });
  // Drill 2: left click a teammate. The CPU moves them about, so hold them where they stand.
  await page.waitForFunction(() => /Pass to a teammate/.test(document.querySelector('#coach-title').textContent), null, { timeout: 10_000 });
  expect(await page.locator('#coach-text').innerText(), 'pass drill text').toMatch(/left click/i);
  await page.waitForTimeout(1300);
  const mate = await page.evaluate(() => {
    const s = window.__derbyMatch;
    const mates = s.players.filter((p) => p.team === 0 && p.role !== 'GK' && p.i !== s.controlled[0]);
    const pins = mates.map((p) => ({ i: p.i, pos: { ...p.pos } }));
    const pin = () => {
      for (const k of pins) {
        s.players[k.i].pos = { ...k.pos };
        s.players[k.i].vel = { x: 0, y: 0 };
      }
      requestAnimationFrame(pin);
    };
    pin();
    const m = pins.map((k) => k.pos).sort((a, b) => Math.hypot(a.x - 38, a.y - 12) - Math.hypot(b.x - 38, b.y - 12))[0];
    return { x: m.x + 0.4, y: m.y - 0.3 };
  });
  await click(page, mate);
  await page.waitForSelector('.coach-dots li[data-drill="pass"].done', { timeout: 15_000 });
});
