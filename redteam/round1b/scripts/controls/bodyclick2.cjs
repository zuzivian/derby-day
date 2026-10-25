const { launch, liveMatch, project, ground, frames } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page } = await liveMatch(browser, { width: 1280, height: 800 });
  // Record what the sim receives: wrap step via a per-tick snapshot hook on s.humanAim writes.
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    window.__log = [];
    let ha = s.humanAim;
    Object.defineProperty(s, 'humanAim', { configurable: true, get: () => ha, set: (v) => { ha = v; window.__log.push({ tick: s.tick, aim: v[0] && { x: +v[0].x.toFixed(2), y: +v[0].y.toFixed(2) }, owner: s.ball.owner, ctl: s.controlled[0], recv: s.ball.receiver, pa: s.stats[0].passAttempts }); if (window.__log.length > 400) window.__log.shift(); } });
  });
  const setup = (withBall) => page.evaluate((withBall) => {
    const s = window.__derbyMatch;
    const mine = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    const me = mine[3], mate = mine[6], decoy = mine[5];
    for (const p of s.players) { p.stun = 1e7; p.vel = { x: 0, y: 0 }; p.pos = { x: 100 + (p.i % 4), y: 70 }; }
    me.stun = 0; me.pos = { x: 40, y: 40 }; me.facing = { x: 1, y: 0 };
    mate.pos = { x: 46, y: 33 }; decoy.pos = { x: 43, y: 37 };
    s.controlled[0] = me.i; s.switchTimer[0] = 0; if (s.ctlHold) s.ctlHold[0] = false;
    const opp = s.players.find((p) => p.team === 1 && p.role === 'MID');
    Object.assign(s.ball, { owner: withBall ? me.i : opp.i, pos: { x: 41, y: 40 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1, touch: 0, inHands: false });
    if (!withBall) opp.pos = { x: 41.6, y: 40 };
    s.ball.noPickup.fill(0);
    return { me: me.i, mate: mate.i, decoy: decoy.i, matePos: mate.pos };
  }, withBall);
  let ids = await setup(true);
  await page.waitForTimeout(3000);
  for (const h of [0, 1.35]) {
    ids = await setup(true);
    await page.waitForTimeout(1500);
    const px = await project(page, ids.matePos, h);
    await page.mouse.move(px.x - 20, px.y - 20);
    await page.mouse.move(px.x, px.y, { steps: 4 });
    const g = await ground(page, px);
    await page.evaluate(() => (window.__log = []));
    await page.mouse.down();
    await page.waitForTimeout(70);
    await page.mouse.up();
    await page.waitForTimeout(800);
    const log = await page.evaluate(() => window.__log);
    const st = await page.evaluate(() => ({ owner: window.__derbyMatch.ball.owner, recv: window.__derbyMatch.ball.receiver, me: window.__derbyMatch.controlled[0] }));
    console.log('h', h, 'ground', g, 'ids', ids, 'state', st);
    console.log(log.filter((l, i) => i < 3 || (log[i - 1] && (l.owner !== log[i - 1].owner || l.recv !== log[i - 1].recv || l.pa !== log[i - 1].pa))).slice(0, 12));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
