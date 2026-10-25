// In the 3D view, where does a click on a team-mate's feet / knees / waist / chest / head land on the grass,
// and who does it switch to (without the ball) or pass to (with the ball)?
const { launch, liveMatch, project, ground, frames } = require('./common.cjs');

(async () => {
  const browser = await launch();
  const { page } = await liveMatch(browser, { width: 1280, height: 800 });
  // Freeze a scene: opponent has the ball far off-screen-ish, everyone stunned, we steer a defender.
  const setup = (withBall) =>
    page.evaluate((withBall) => {
      const s = window.__derbyMatch;
      const mine = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
      const me = mine[3];
      const mate = mine[6];
      const decoy = mine[5];
      for (const p of s.players) {
        p.stun = 1e7;
        p.vel = { x: 0, y: 0 };
        p.pos = { x: 100 + (p.i % 4), y: 70 };
      }
      me.stun = 0;
      me.pos = { x: 40, y: 40 };
      me.facing = { x: 1, y: 0 };
      // Mate up the screen (further from the camera) and across: 9 m away. Decoy nearer in the same direction.
      mate.pos = { x: 46, y: 33 };
      decoy.pos = { x: 43, y: 37 };
      mate.stun = 0;
      decoy.stun = 0;
      // Pin them where they stand (the CPU would move them) until someone has the ball.
      window.__pinId = (window.__pinId || 0) + 1;
      const id = window.__pinId;
      const pin = () => {
        if (id !== window.__pinId) return;
        if (s.ball.owner === mate.i || s.ball.owner === decoy.i) return;
        if (s.ball.receiver !== mate.i && s.ball.receiver !== decoy.i) { mate.pos = { x: 46, y: 33 }; decoy.pos = { x: 43, y: 37 }; mate.vel = { x: 0, y: 0 }; decoy.vel = { x: 0, y: 0 }; }
        requestAnimationFrame(pin);
      };
      pin();
      s.controlled[0] = me.i;
      s.switchTimer[0] = 0;
      if (s.ctlHold) s.ctlHold[0] = false;
      const opp = s.players.find((p) => p.team === 1 && p.role === 'MID');
      Object.assign(s.ball, { owner: withBall ? me.i : opp.i, pos: { x: 41, y: 40 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1, touch: 0, inHands: false });
      if (!withBall) opp.pos = { x: 41.6, y: 40 };
      s.ball.noPickup.fill(0);
      return { me: me.i, mate: mate.i, decoy: decoy.i, matePos: mate.pos };
    }, withBall);
  let ids = await setup(false);
  await page.waitForTimeout(2500); // camera settles
  const rows = [];
  for (const h of [0, 0.5, 1.0, 1.35, 1.65]) {
    ids = await setup(false);
    await page.waitForTimeout(1500);
    const px = await project(page, ids.matePos, h);
    const g = await ground(page, px);
    const off = Math.hypot(g.x - ids.matePos.x, g.y - ids.matePos.y);
    // Without the ball: left click there.
    await page.mouse.move(px.x - 20, px.y - 20);
    await page.mouse.move(px.x, px.y, { steps: 4 });
    const g1 = await ground(page, px);
    await page.mouse.down();
    await page.waitForTimeout(70);
    await page.mouse.up();
    await frames(page, 3);
    const ctl = await page.evaluate(() => window.__derbyMatch.controlled[0]);
    // With the ball: left click there.
    ids = await setup(true);
    await page.waitForTimeout(1500);
    const px2 = await project(page, ids.matePos, h);
    await page.mouse.move(px2.x - 20, px2.y - 20);
    await page.mouse.move(px2.x, px2.y, { steps: 4 });
    await page.mouse.down();
    await page.waitForTimeout(70);
    await page.mouse.up();
    await page.waitForFunction(() => window.__derbyMatch.ball.owner === -1, null, { polling: 'raf', timeout: 4000 }).catch(() => {});
    const recv = await page.evaluate(() => window.__derbyMatch.ball.receiver);
    rows.push({ height: h, g1: [+g1.x.toFixed(1), +g1.y.toFixed(1)], px: [Math.round(px.x), Math.round(px.y)], groundOffset_m: +off.toFixed(2), ground: [+g.x.toFixed(1), +g.y.toFixed(1)], switchedTo: ctl === ids.mate ? 'mate' : ctl === ids.decoy ? 'decoy' : ctl === ids.me ? 'nobody (stayed)' : ctl, passTo: recv === ids.mate ? 'mate' : recv === ids.decoy ? 'decoy' : recv === -1 ? 'empty grass' : recv });
  }
  console.table(rows);
  // Screenshot with the mate highlighted: pointer on his chest.
  ids = await setup(false);
  await frames(page, 3);
  const chest = await project(page, ids.matePos, 1.35);
  await page.mouse.move(chest.x, chest.y, { steps: 3 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/rt/controls/out/bodyclick-chest-1280.png' });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
