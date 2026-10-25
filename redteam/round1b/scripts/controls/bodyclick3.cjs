const { launch, liveMatch, project, ground, frames } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page } = await liveMatch(browser, { width: 1280, height: 800 });
  const info = await page.evaluate(() => {
    const s = window.__derbyMatch;
    const mine = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    return mine.map((p) => ({ i: p.i, role: p.role, stun: p.stun, sent: p.sentOff }));
  });
  console.log(info);
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const mine = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    const me = mine[3], mate = mine[6];
    for (const p of s.players) if (p !== me && p !== mate) { p.stun = 1e7; p.pos = { x: 100 + (p.i % 4), y: 70 }; p.vel = { x: 0, y: 0 }; }
    me.stun = 0; mate.stun = 0;
    me.pos = { x: 40, y: 40 }; me.vel = { x: 0, y: 0 };
    mate.pos = { x: 46, y: 33 }; mate.vel = { x: 0, y: 0 };
    s.controlled[0] = me.i;
    Object.assign(s.ball, { owner: me.i, pos: { x: 41, y: 40 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1, touch: 0, inHands: false });
    s.switchTimer[0] = 1e9;
    window.__ids = { me: me.i, mate: mate.i };
  });
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => { const s = window.__derbyMatch; const m = s.players[window.__ids.mate]; return { mate: m.pos, stun: m.stun, vel: m.vel, me: s.players[window.__ids.me].pos, owner: s.ball.owner, ctl: s.controlled[0], ids: window.__ids }; });
  console.log(st);
  const px = await project(page, st.mate, 0);
  await page.mouse.move(px.x - 20, px.y - 20);
  await page.mouse.move(px.x, px.y, { steps: 4 });
  console.log('ground', await ground(page, px));
  await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
  await page.waitForTimeout(500);
  console.log(await page.evaluate(() => { const s = window.__derbyMatch; return { owner: s.ball.owner, recv: s.ball.receiver, vel: s.ball.vel, ctl: s.controlled[0], mate: s.players[window.__ids.mate].pos, ev: s.events.slice(-3).map((e) => e.kind) }; }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
