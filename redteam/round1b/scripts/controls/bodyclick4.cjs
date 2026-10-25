// 3D: click on a team-mate's body at several heights; what grass point does the sim get, who is picked / passed to?
const { launch, liveMatch, project, ground, frames } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page } = await liveMatch(browser, { width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    window.__aims = [];
    let ha = s.humanAim;
    Object.defineProperty(s, 'humanAim', { configurable: true, get: () => ha, set: (v) => { ha = v; window.__aims.push({ tick: s.tick, aim: v[0] && { ...v[0] }, prevRecv: s.ball.receiver, prevOwner: s.ball.owner, prevCtl: s.controlled[0] }); if (window.__aims.length > 50) window.__aims.shift(); } });
  });
  const scene = (withBall, mateAt, decoyAt) => page.evaluate(([withBall, mateAt, decoyAt]) => {
    const s = window.__derbyMatch;
    const mine = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    const me = mine[3], mate = mine[6], decoy = mine[5];
    const opp = s.players.find((p) => p.team === 1 && p.role === 'MID');
    for (const p of s.players) if (p !== me && p !== mate && p !== decoy) { p.stun = 1e7; p.pos = { x: 100 + (p.i % 4), y: 70 }; p.vel = { x: 0, y: 0 }; }
    for (const p of [me, mate, decoy]) { p.stun = 0; p.vel = { x: 0, y: 0 }; }
    me.pos = { x: 40, y: 40 }; mate.pos = { ...mateAt }; decoy.pos = { ...decoyAt };
    s.controlled[0] = me.i; if (s.ctlHold) s.ctlHold[0] = false;
    s.switchTimer[0] = withBall ? 1e9 : 0;
    if (withBall) Object.assign(s.ball, { owner: me.i, pos: { x: 41, y: 40 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1, touch: 0, inHands: false });
    else { opp.stun = 1e7; opp.pos = { x: 41.6, y: 40.5 }; Object.assign(s.ball, { owner: opp.i, pos: { x: 41, y: 40.5 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1, touch: 0, inHands: false }); }
    s.ball.noPickup.fill(0);
    // Pin mate and decoy (the CPU would wander) until the ball is on its way.
    const tag = (window.__tag = (window.__tag || 0) + 1);
    const pin = () => { if (tag !== window.__tag || s.ball.owner !== (withBall ? me.i : opp.i)) return; mate.pos = { ...mateAt }; decoy.pos = { ...decoyAt }; mate.vel = { x: 0, y: 0 }; decoy.vel = { x: 0, y: 0 }; requestAnimationFrame(pin); };
    pin();
    return { me: me.i, mate: mate.i, decoy: decoy.i };
  }, [withBall, mateAt, decoyAt]);
  const name = (ids, i) => (i === ids.mate ? 'mate' : i === ids.decoy ? 'decoy' : i === ids.me ? 'stayed' : i === -1 ? 'empty grass' : String(i));
  const rows = [];
  // Two layouts: mate up-screen (further from the camera) with a decoy nearer the same way; and mate across the screen.
  for (const [label, mateAt, decoyAt] of [['up-screen 9 m', { x: 46, y: 33 }, { x: 43, y: 37 }], ['across 7 m', { x: 47, y: 40 }, { x: 44, y: 39 }]]) {
    for (const h of [0, 0.5, 1.0, 1.35, 1.65]) {
      for (const withBall of [false, true]) {
        const ids = await scene(withBall, mateAt, decoyAt);
        await page.waitForTimeout(1800);
        const px = await project(page, mateAt, h);
        await page.mouse.move(px.x - 25, px.y + 25);
        await page.mouse.move(px.x, px.y, { steps: 5 });
        await page.waitForTimeout(150);
        await page.evaluate(() => (window.__aims = []));
        await page.mouse.down();
        await page.waitForTimeout(70);
        await page.mouse.up();
        await page.waitForTimeout(400);
        // humanAim is written at the start of each step, so entry k+1 shows the state step k left behind.
        const r = await page.evaluate(() => {
          const a = window.__aims;
          const kick = a.findIndex((e) => e.prevOwner === -1);
          const ctlAfter = a.length > 2 ? a[2].prevCtl : window.__derbyMatch.controlled[0];
          return { ctl: ctlAfter, recv: kick >= 0 ? a[kick].prevRecv : -99, aim: a[0] && a[0].aim };
        });
        const off = r.aim ? Math.hypot(r.aim.x - mateAt.x, r.aim.y - mateAt.y) : NaN;
        rows.push({ layout: label, height_m: h, withBall, simAimOffset_m: +off.toFixed(2), result: withBall ? 'pass to ' + name(ids, r.recv) : 'switch to ' + name(ids, r.ctl) });
      }
    }
  }
  console.table(rows);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
