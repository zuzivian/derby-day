// The mouse scheme in a real browser: real pointer events through InputController into the sim.
// The page exposes the live match as window.__derbyMatch when window.__e2e is set (openApp's
// e2eHook), so each test sets a scene up (who has the ball, where everyone stands), drives the
// mouse, and reads the match back.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, startRanked } = require('./lib/helpers.cjs');

const PREFS = { halfSeconds: 120, controls: 'mouse', onboarded: true };
// Pitch view in metres, see render.ts: the 105 x 68 m pitch plus a 3.5 m margin each side.
const MARGIN = 3.5;
const VIEW_W = 105 + 2 * MARGIN;
const VIEW_H = 68 + 2 * MARGIN;

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
/** Two animation frames: the match loop has taken the input and stepped the sim with it. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function click(page, w, button = 'left') {
  const p = await screen(page, w);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button });
  await page.waitForTimeout(40);
  await page.mouse.up({ button });
  await frames(page);
}
async function hold(page, w, ms, button = 'left') {
  const p = await screen(page, w);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button });
  await page.waitForTimeout(ms);
  await page.mouse.up({ button });
  await frames(page);
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

/**
 * Track the ball's peak height and first touchdown from now on, on every sim tick: a setter on
 * ball.z sees each value the sim writes, so a slow frame rate (several ticks per frame, as under a
 * software WebGL renderer) cannot skip the one tick the ball touches down before it bounces.
 */
const startTracking = (page) =>
  page.evaluate(() => {
    const b = window.__derbyMatch.ball;
    window.__track = { peak: 0, air: false, td: null };
    let z = b.z;
    Object.defineProperty(b, 'z', {
      configurable: true,
      enumerable: true,
      get: () => z,
      set: (v) => {
        z = v;
        const k = window.__track;
        if (b.owner >= 0) return;
        k.peak = Math.max(k.peak, v);
        if (v > 0) k.air = true;
        else if (k.air && !k.td) k.td = { x: b.pos.x, y: b.pos.y };
      },
    });
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

test('mouse with the ball: a slow click (250 ms, a trackpad tap) is still a ground pass, firm to the teammate under the pointer', async (t) => {
  const page = await openMatch(t);
  const me = await carrier(page, { x: 20, y: 20 });
  const mate = await page.evaluate(() => {
    const s = window.__derbyMatch;
    const m = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== s.controlled[0]);
    Object.assign(m, { stun: 0, pos: { x: 34, y: 24 }, vel: { x: 0, y: 0 } });
    // Hold him where he stands, so the scene does not depend on the CPU's ideas.
    const pin = () => {
      if (window.__derbyMatch.ball.owner === m.i) return;
      m.pos = { x: 34, y: 24 };
      m.vel = { x: 0, y: 0 };
      requestAnimationFrame(pin);
    };
    pin();
    return m.i;
  });
  await startTracking(page);
  await hold(page, { x: 34.6, y: 24.4 }, 250);
  await afterKick(page, me);
  const b = await ball(page);
  expect(b.receiver, 'the pass is to the teammate under the pointer').toBe(mate);
  expect(Math.hypot(b.vx, b.vy), 'played firmly (over 9 m/s)').toBeGreaterThan(9);
  await page.waitForFunction((m) => window.__derbyMatch.ball.owner === m, mate, { polling: 'raf', timeout: 6000 });
  expect((await tracked(page)).peak, 'it never left the floor').toBeLessThan(0.05);
});

test("mouse: the human's keeper holds the ball for the human, with a countdown, and a click plays it out", async (t) => {
  const page = await openMatch(t);
  const gk = await page.evaluate(() => {
    const s = window.__derbyMatch;
    const g = s.players.find((p) => p.team === 0 && p.role === 'GK');
    for (const p of s.players) if (p !== g) p.stun = 1e7;
    Object.assign(g, { stun: 0, pos: { x: 6, y: 34 }, vel: { x: 0, y: 0 } });
    const opp = s.players.find((p) => p.team === 1 && p.role === 'FWD');
    Object.assign(s.ball, { owner: -1, pos: { x: 13, y: 34 }, vel: { x: -9, y: 0 }, z: 0, vz: 0, receiver: -1, passFrom: -1, kickedBy: -1, lastTouch: opp.i, touch: 0, inHands: false });
    s.ball.noPickup.fill(0);
    return g.i;
  });
  await page.waitForFunction((g) => window.__derbyMatch.ball.owner === g, gk, { polling: 'raf', timeout: 6000 });
  expect(await page.evaluate(() => window.__derbyMatch.ball.inHands), 'caught').toBe(true);
  expect(await page.evaluate(() => window.__derbyMatch.controlled[0]), 'control goes to the keeper').toBe(gk);
  await page.waitForSelector('.hud-hold:not([hidden])', { timeout: 3000 });
  expect(await page.locator('.hud-hold').innerText(), 'a countdown shows').toMatch(/keeper/i);
  await page.waitForTimeout(1200);
  expect(await page.evaluate((g) => window.__derbyMatch.ball.owner === g, gk), 'he waits for the human: no auto-distribution').toBe(true);
  const mate = await page.evaluate(() => {
    const s = window.__derbyMatch;
    const m = s.players.find((p) => p.team === 0 && p.role === 'DEF');
    Object.assign(m, { stun: 0, pos: { x: 18, y: 22 }, vel: { x: 0, y: 0 } });
    return m.i;
  });
  await click(page, { x: 18, y: 22 });
  await page.waitForFunction(() => window.__derbyMatch.ball.owner === -1, null, { polling: 'raf', timeout: 4000 });
  expect((await ball(page)).receiver, 'rolled out to the defender clicked on').toBe(mate);
});

test('mouse with the ball: right click shoots at the pointer, hold right for power', async (t) => {
  const page = await openMatch(t);
  const target = { x: 52, y: 6 };
  const shot = async (ms) => {
    const me = await carrier(page, { x: 38, y: 24 });
    // A top finisher, so this checks where the controls send it, not how far a 67 m strike strays (LONG_SHOT_ERR).
    await page.evaluate((i) => (window.__derbyMatch.players[i].attrs.shooting = 1), me);
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
    mates.slice(5).forEach((p, k) => (p.pos = { x: 95 + k * 2, y: 66 })); // eleven-a-side: the rest too
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
      // kickCd too: when nobody clicks at the kick-off the CPU takes it for our man after five seconds
      // (Law 8: it is a kick), and a right click straight after his own kick is never a tackle.
      Object.assign(me, { stun: 0, tackleCd: 0, kickCd: 0, pos: { x: 30, y: 20 }, vel: { x: 0, y: 0 } });
      // Facing the tackler: a challenge from the front (one from behind is harder and riskier, Law 12).
      Object.assign(opp, { stun: 0, pos: { x: 30 + gap, y: 20 }, vel: { x: 0, y: 0 }, facing: { x: -1, y: 0 } });
      opp.attrs.dribbling = 0;
      me.attrs.defending = 1;
      Object.assign(s.ball, { owner: opp.i, pos: { x: 30 + gap - 0.9, y: 20 }, vel: { x: 0, y: 0 }, z: 0, receiver: -1 });
      s.switchTimer[0] = 1e9;
      // He is the human's man now, not one handed over by the kick-off pass: no hold waiting for the
      // pointer to move (MatchState.ctlHold), which under load can outlast the click.
      s.ctlHold = [false, false];
      // Back to open play: the first challenge is sometimes a foul or knocks the ball out (23 seeds in
      // 1000 headless), and a right click during the restart that follows is not a tackle.
      Object.assign(s, { phase: 'play', restart: null, advantage: null, offside: null });
      window.__cd = 0;
      // Every value the sim writes, not one sample a frame (a slow frame steps several ticks).
      if (!me.__cdHooked) {
        let cd = me.tackleCd;
        Object.defineProperty(me, 'tackleCd', {
          configurable: true,
          enumerable: true,
          get: () => cd,
          set: (v) => {
            cd = v;
            window.__cd = Math.max(window.__cd, v);
          },
        });
        Object.defineProperty(me, '__cdHooked', { value: true });
      }
      return opp.i;
    }, gap);
  // Wait for the challenge itself rather than a fixed time: under load (software 3D on a busy runner)
  // 250 ms of wall time can pass before the sim has stepped the click at all (CI saw 0 once).
  const challenged = () => page.waitForFunction(() => window.__cd > 0, null, { timeout: 15_000, polling: 20 }).then(() => page.waitForTimeout(100));
  await setup(1.3);
  await click(page, { x: 31.5, y: 20 }, 'right');
  await challenged();
  const stand = await page.evaluate(() => window.__cd);
  // A standing tackle sets a 36-tick cooldown, or 50 if it fails (it wins at most 88% of the
  // time), so accept either outcome; a slide is 70 or 90, which is what tells the two apart.
  expect(stand, 'a close pointer is a standing tackle').toBeGreaterThan(30);
  expect(stand, 'standing tackle cooldown (won or lost), shorter than any slide').toBeLessThan(55);
  const opp = await setup(2.6);
  await click(page, { x: 36, y: 20 }, 'right');
  await challenged();
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
  // The training-ground marker (drills.ts MARKER: the drills sit in the attacking end of the full pitch).
  const marker = { x: 79, y: 26 };
  await moveTo(page, marker);
  await page.waitForSelector('.coach-dots li[data-drill="move"].done', { timeout: 15_000 });
  // Drill 2: left click a teammate. The CPU moves them about, so hold them where they stand.
  await page.waitForFunction(() => /Pass to a teammate/.test(document.querySelector('#coach-title').textContent), null, { timeout: 10_000 });
  expect(await page.locator('#coach-text').innerText(), 'pass drill text').toMatch(/left click/i);
  // Wait until the drill is live and our player has the ball, rather than for a fixed time.
  await page.waitForFunction(() => {
    const s = window.__derbyMatch;
    return s && s.ball.owner === s.controlled[0];
  }, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
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
    const m = pins.map((k) => k.pos).sort((a, b) => Math.hypot(a.x - 79, a.y - 26) - Math.hypot(b.x - 79, b.y - 26))[0];
    return { x: m.x + 0.4, y: m.y - 0.3 };
  });
  await click(page, mate);
  await page.waitForSelector('.coach-dots li[data-drill="pass"].done', { timeout: 15_000 });
});

test('trackpad: a pinch (ctrl+wheel) over the pitch zooms the 3D camera, not the page', async (t) => {
  const page = await openApp(t, { prefs: { halfSeconds: 600, controls: 'mouse', onboarded: true }, renderer: '3d' });
  await startRanked(page);
  if ((await page.evaluate(() => document.querySelector('#pitch').dataset.renderer)) !== '3d') return; // no WebGL2 here
  const zoom = () => page.evaluate(() => Number(localStorage.getItem('derby-zoom') || '1'));
  // A Mac trackpad pinch out arrives as wheel events with ctrlKey and small negative deltas.
  const prevented = await page.evaluate(() => {
    const el = document.querySelector('#pitch');
    let n = 0;
    for (let i = 0; i < 15; i++) if (!el.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true }))) n++;
    return n;
  });
  expect(prevented, 'every pinch event is kept from zooming the page').toBe(15);
  const zin = await zoom();
  expect(zin, 'a pinch out zooms the camera in').toBeLessThan(0.8);
  await page.evaluate(() => {
    const el = document.querySelector('#pitch');
    for (let i = 0; i < 15; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: 4, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(await zoom(), 'a pinch in zooms back out').toBeGreaterThan(zin);
  // A mouse wheel notch with Ctrl held is left to the browser's page zoom.
  const before = await zoom();
  const mousePrevented = await page.evaluate(() => !document.querySelector('#pitch').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true })));
  expect(mousePrevented, 'a mouse ctrl+wheel still zooms the page').toBe(false);
  expect(await zoom(), 'and leaves the camera alone').toBe(before);
  // A smooth-scrolling mouse with Ctrl held sends small deltas too, but after a real Control keydown.
  await page.keyboard.down('Control');
  const smoothPrevented = await page.evaluate(() => !document.querySelector('#pitch').dispatchEvent(new WheelEvent('wheel', { deltaY: 4, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true })));
  await page.keyboard.up('Control');
  expect(smoothPrevented, 'a smooth-scrolling mouse ctrl+wheel still zooms the page').toBe(false);
  expect(await zoom(), 'and leaves the camera alone too').toBe(before);
});

test('a free kick in range: the wall forms 9.15 m off, the HUD names it, and a right press dragged sideways curls the shot', async (t) => {
  const page = await openMatch(t);
  // A foul 23 m out, a little left of centre (awardRestart's fields), with both sides gathered round the ball first.
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const spot = { x: 82.2, y: 36 };
    for (const p of s.players) {
      if (p.role === 'GK') continue;
      p.pos = { x: Math.min(103, Math.max(2, 52.5 + (p.pos.x - 52.5) * 0.5 + 0.85 * (spot.x - 52.5))), y: p.pos.y };
      p.vel = { x: 0, y: 0 };
    }
    Object.assign(s.ball, { owner: -1, receiver: -1, passFrom: -1, inHands: false, setPiece: null, kickedBy: -1, restartBy: -1, noHands: -1, pos: { ...spot }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
    s.offside = null;
    s.advantage = null;
    s.restart = { kind: 'freekick', team: 0, spot, taker: -1, stage: 'whistle', ticks: 0, direct: true, reason: 'foul', wait: 0 };
    s.phase = 'restart';
  });
  await page.waitForFunction(() => window.__derbyMatch.restart?.stage === 'ready' && window.__derbyMatch.controlled[0] === window.__derbyMatch.restart.taker, null, { timeout: 30_000 });
  // A slow CI browser must not run out the human's five seconds while the mouse is moving.
  await page.evaluate(() => {
    window.__holdRestart = setInterval(() => {
      const r = window.__derbyMatch.restart;
      if (r && r.stage === 'ready') r.ticks = 0;
    }, 50);
  });
  const wall = await page.evaluate(() => {
    const s = window.__derbyMatch;
    return (s.wall?.players ?? []).map((i) => Math.hypot(s.players[i].pos.x - s.restart.spot.x, s.players[i].pos.y - s.restart.spot.y));
  });
  expect(wall.length, 'three men in the wall at 23 m').toBe(3);
  for (const d of wall) expect(d, 'each 9.15 m off, or a little more').toBeGreaterThanOrEqual(9.14);
  expect(await page.locator('.hud-fk').innerText(), 'the HUD names it').toMatch(/direct free kick/i);
  // Right down on the far top corner, dragged 3 m across toward the middle of the goal, released.
  const aim = await screen(page, { x: 105, y: 31 });
  const drag = await screen(page, { x: 105, y: 34 });
  await page.mouse.move(aim.x, aim.y);
  await frames(page);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(drag.x, drag.y, { steps: 5 });
  await frames(page);
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction(() => window.__derbyMatch.phase === 'play' && window.__derbyMatch.ball.owner < 0, null, { timeout: 10_000 });
  await page.evaluate(() => clearInterval(window.__holdRestart));
  const shot = await page.evaluate(() => {
    const b = window.__derbyMatch.ball;
    return { spin: b.spin, vx: b.vel.x, vy: b.vel.y, vz: b.vz, y: b.pos.y };
  });
  // Dragged to the kicker's left (+y, shooting toward x = 105): it bends left, so it sets off to the right of the line.
  expect(shot.spin, 'the strike carries spin').toBeTruthy();
  expect(shot.spin.side, 'bent to the left').toBeGreaterThan(1);
  expect(shot.spin.top, 'and dips over the wall').toBeGreaterThan(0);
  expect(shot.vx, 'struck toward goal').toBeGreaterThan(10);
  expect(shot.vz, 'rising to clear the wall').toBeGreaterThan(4);
});

test('a corner: a man comes short, and left held where the cross should land puts it there', async (t) => {
  const page = await openMatch(t);
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const ball = { x: 96, y: 27 };
    for (const p of s.players) {
      if (p.role === 'GK') continue;
      p.pos = { x: Math.min(103, Math.max(2, 52.5 + (p.pos.x - 52.5) * 0.5 + 0.85 * (ball.x - 52.5))), y: p.pos.y };
      p.vel = { x: 0, y: 0 };
    }
    Object.assign(s.ball, { owner: -1, receiver: -1, passFrom: -1, inHands: false, setPiece: null, kickedBy: -1, restartBy: -1, noHands: -1, pos: { x: 104.5, y: 0.5 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
    s.offside = null;
    s.advantage = null;
    s.restart = { kind: 'corner', team: 0, spot: { x: 104.5, y: 0.5 }, taker: -1, stage: 'whistle', ticks: 0, direct: true, reason: 'out', wait: 0 };
    s.phase = 'restart';
  });
  await page.waitForFunction(() => window.__derbyMatch.restart?.stage === 'ready' && window.__derbyMatch.controlled[0] === window.__derbyMatch.restart.taker, null, { timeout: 30_000 });
  await page.evaluate(() => {
    window.__holdRestart = setInterval(() => {
      const r = window.__derbyMatch.restart;
      if (r && r.stage === 'ready') r.ticks = 0;
    }, 50);
  });
  const short = await page.evaluate(() => {
    const s = window.__derbyMatch;
    const r = s.restart;
    return Math.min(...s.players.filter((p) => p.team === 0 && p.i !== r.taker && p.role !== 'GK').map((p) => Math.hypot(p.pos.x - r.spot.x, p.pos.y - r.spot.y)));
  });
  expect(short, 'a man short, near the flag').toBeLessThan(12);
  // Left down on the penalty spot, held half a second (a loft), released.
  const spot = await screen(page, { x: 94, y: 34 });
  await page.mouse.move(spot.x, spot.y);
  await frames(page);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  await page.waitForFunction(() => window.__derbyMatch.phase === 'play' && window.__derbyMatch.ball.owner < 0, null, { timeout: 10_000 });
  await page.evaluate(() => clearInterval(window.__holdRestart));
  // Where it is heading: follow its flight in the page until it comes down or someone touches it.
  const landed = await page.evaluate(() => new Promise((resolve) => {
    const s = window.__derbyMatch;
    const by = s.ball.lastTouch;
    const tick = () => {
      if (s.ball.z === 0 || s.ball.lastTouch !== by || s.phase !== 'play') resolve({ x: s.ball.pos.x, y: s.ball.pos.y, z: s.ball.z, touched: s.ball.lastTouch !== by });
      else requestAnimationFrame(tick);
    };
    tick();
  }));
  const d = Math.hypot(landed.x - 94, landed.y - 34);
  // Headed or taken before it lands, it was still on its way there: within a few metres.
  expect(d, 'the cross came down where left went down').toBeLessThan(landed.touched ? 6 : 2);
});

test('a goal kick: left held on the centre circle puts it there', async (t) => {
  const page = await openMatch(t);
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    Object.assign(s.ball, { owner: -1, receiver: -1, passFrom: -1, inHands: false, setPiece: null, kickedBy: -1, restartBy: -1, noHands: -1, pos: { x: 5.5, y: 30 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
    s.offside = null;
    s.advantage = null;
    s.restart = { kind: 'goalkick', team: 0, spot: { x: 5.5, y: 30 }, taker: -1, stage: 'whistle', ticks: 0, direct: true, reason: 'out', wait: 0 };
    s.phase = 'restart';
  });
  await page.waitForFunction(() => window.__derbyMatch.restart?.stage === 'ready' && window.__derbyMatch.controlled[0] === window.__derbyMatch.restart.taker, null, { timeout: 30_000 });
  await page.evaluate(() => {
    window.__holdRestart = setInterval(() => {
      const r = window.__derbyMatch.restart;
      if (r && r.stage === 'ready') r.ticks = 0;
    }, 50);
  });
  const spot = await screen(page, { x: 52.5, y: 34 });
  await page.mouse.move(spot.x, spot.y);
  await frames(page);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
  await page.waitForFunction(() => window.__derbyMatch.phase === 'play' && window.__derbyMatch.ball.owner < 0, null, { timeout: 10_000 });
  await page.evaluate(() => clearInterval(window.__holdRestart));
  const landed = await page.evaluate(() => new Promise((resolve) => {
    const s = window.__derbyMatch;
    const by = s.ball.lastTouch;
    const tick = () => {
      if (s.ball.z === 0 || s.ball.lastTouch !== by || s.phase !== 'play') resolve({ x: s.ball.pos.x, y: s.ball.pos.y, touched: s.ball.lastTouch !== by });
      else requestAnimationFrame(tick);
    };
    tick();
  }));
  // Before, a held goal kick came down 10-20 m short of the centre circle.
  expect(Math.hypot(landed.x - 52.5, landed.y - 34), 'it came down where left went down').toBeLessThan(landed.touched ? 8 : 3);
});

test('a penalty in a match: right held by the post strikes it there, and it ends as the kick decided', async (t) => {
  const page = await openMatch(t);
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    Object.assign(s.ball, { owner: -1, receiver: -1, passFrom: -1, inHands: false, setPiece: null, kickedBy: -1, restartBy: -1, noHands: -1, penalty: null, pos: { x: 94, y: 34 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
    s.offside = null;
    s.advantage = null;
    s.restart = { kind: 'penalty', team: 0, spot: { x: 94, y: 34 }, taker: -1, stage: 'whistle', ticks: 0, direct: true, reason: 'foul', wait: 0 };
    s.phase = 'restart';
  });
  await page.waitForFunction(() => window.__derbyMatch.restart?.stage === 'ready' && window.__derbyMatch.controlled[0] === window.__derbyMatch.restart.taker, null, { timeout: 30_000 });
  await page.evaluate(() => {
    window.__holdRestart = setInterval(() => {
      const r = window.__derbyMatch.restart;
      if (r && r.stage === 'ready') r.ticks = 0;
    }, 50);
  });
  // Right down just inside the far post, held a moment, released.
  const at = await screen(page, { x: 105, y: 34 + 3 });
  await page.mouse.move(at.x, at.y);
  await frames(page);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(250);
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction(() => !!window.__derbyMatch.ball.penalty, null, { timeout: 10_000 });
  await page.evaluate(() => clearInterval(window.__holdRestart));
  const fate = await page.evaluate(() => window.__derbyMatch.ball.penalty.fate);
  const ended = await page.evaluate(() => new Promise((resolve) => {
    const s = window.__derbyMatch;
    const pen = s.ball.penalty;
    const g0 = s.score[0];
    const tick = () => {
      if (s.score[0] > g0) resolve('goal');
      else if (s.ball.lastTouch === pen.gk) resolve('saved');
      else if (s.restart && s.restart.kind === 'goalkick') resolve('out');
      else if (s.ball.lastTouch !== pen.by && s.ball.lastTouch >= 0) resolve('back in play');
      else requestAnimationFrame(tick);
    };
    tick();
  }));
  const ok = { goal: ['goal'], saved: ['saved'], wide: ['out'], over: ['out'], post: ['back in play', 'saved', 'out'] }[fate];
  expect(ok.includes(ended), `decided ${fate}, ended ${ended}`).toBe(true);
});
