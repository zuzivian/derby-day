// A newbie's play loop: dribble forward, pass to a teammate ahead after a moment on the ball, shoot near goal, chase and tackle.
const { st, Steer } = require('./play.cjs');
const { shot } = require('./lib.cjs');
async function click(page, button = 'left', ms = 120) { await page.mouse.down({ button }); await page.waitForTimeout(ms); await page.mouse.up({ button }); }
async function playFor(page, ms, { tag = 'm', tipShots = true, log = console.log, onTip } = {}) {
  const box = await page.locator('#pitch').boundingBox();
  const steer = new Steer(page, box);
  const t0 = Date.now();
  let heldSince = null, lastTip = null, lastAct = 0;
  const tips = [];
  const acts = { pass: 0, shoot: 0, tackle: 0 };
  while (Date.now() - t0 < ms) {
    const s = await st(page);
    if (!s) break;
    if (s.phase === 'fulltime') break;
    if (s.tip && s.tip !== lastTip) {
      const el = await page.locator('.coach-tip').boundingBox().catch(() => null);
      const text = await page.locator('.coach-tip').innerText().catch(() => '');
      tips.push({ id: s.tip, tick: s.tick, wall: Date.now() - t0, phase: s.phase, owner: s.owner, me: s.me, box: el, text });
      log(`TIP ${s.tip} @tick ${s.tick} phase ${s.phase} owner ${s.owner} me ${s.me}: ${text.replace(/\n/g, ' ')}`);
      if (tipShots) await shot(page, `${tag}_tip_${s.tip}`);
      if (onTip) await onTip(s.tip, s);
    }
    lastTip = s.tip;
    if (!['play', 'restart', 'kickoff'].includes(s.phase) || s.paused) { await page.waitForTimeout(150); continue; }
    const me = s.mePos;
    if (!me) { await page.waitForTimeout(100); continue; }
    if (s.owner === s.me) {
      heldSince ??= Date.now();
      const held = Date.now() - heldSince;
      if (me.x > 80 && held > 600) {
        const goal = { x: 105, y: 34 + (Math.random() - 0.5) * 4 };
        for (let k = 0; k < 2; k++) { await steer.toward(goal, await st(page)); await page.waitForTimeout(60); }
        await click(page, 'right', 160); acts.shoot++; heldSince = null; lastAct = Date.now();
      } else if (held > 1400) {
        const mates = s.mates.filter((m) => m.x > me.x - 4 && m.role !== 'GK').sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
        const m = mates[0];
        if (m) {
          for (let k = 0; k < 3; k++) { const s2 = await st(page); const mm = s2.mates.find((q) => q.i === m.i) || m; await steer.toward({ x: mm.x + 1, y: mm.y }, s2); await page.waitForTimeout(50); }
          await click(page, 'left', 110); acts.pass++; heldSince = null; lastAct = Date.now();
        }
      } else {
        await steer.toward({ x: me.x + 7, y: me.y + (34 - me.y) * 0.15 }, s);
      }
    } else {
      heldSince = null;
      const d = Math.hypot(s.ball.x - me.x, s.ball.y - me.y);
      await steer.toward({ x: s.ball.x, y: s.ball.y }, s);
      if (s.ownerTeam === 1 && d < 2.5 && Date.now() - lastAct > 1200) { await click(page, 'right', 90); acts.tackle++; lastAct = Date.now(); }
    }
    await page.waitForTimeout(70);
  }
  return { tips, acts };
}
async function ffHalf(page) {
  // Fast-forward: run the clock to 2 ticks before the end of the current half.
  return page.evaluate(() => { const s = window.__derbyMatch; s.clock = Math.max(s.clock, s.halfTicks * s.half - 2); return { half: s.half, clock: s.clock }; });
}
module.exports = { playFor, ffHalf, click };
