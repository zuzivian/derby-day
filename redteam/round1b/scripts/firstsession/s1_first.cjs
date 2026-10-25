const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const c = await ctx(browser, {});
  const page = await c.newPage();
  logErrors(page, 'desk');
  const t0 = Date.now();
  await page.goto(URL);
  const kick = page.locator('#ob-kickoff');
  await kick.waitFor({ state: 'visible' });
  const tWelcome = Date.now() - t0;
  console.log('welcome visible ms', tWelcome);
  await page.waitForTimeout(500);
  await shot(page, 'd01_welcome');
  const info = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText,
    buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()),
    focus: document.activeElement?.id,
    scrollH: document.documentElement.scrollHeight,
  }));
  console.log(JSON.stringify(info, null, 1));
  // Click Kick off with the mouse
  const box = await kick.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.up();
  const tClick = Date.now() - t0;
  await page.locator('#pitch').waitFor();
  const tPitch = Date.now() - t0;
  console.log('click ms', tClick, 'pitch ms', tPitch);
  // poll for first kick
  let first = null, firstShot = false;
  const samples = [];
  for (let i = 0; i < 400; i++) {
    const st = await page.evaluate(() => {
      const s = window.__derbyMatch; if (!s) return null;
      const b = s.ball;
      return { tick: s.tick, phase: s.phase, owner: b.owner, sp: Math.hypot(b.vel.x, b.vel.y), z: b.z, r: s.restart && { kind: s.restart.kind, team: s.restart.team, stage: s.restart.stage, taker: s.restart.taker, ticks: s.restart.ticks }, ctl: s.controlled[0], kickoffTeam: s.kickoffTeam, tipShown: (() => { const el = document.querySelector('.coach-tip'); return el && !el.hidden ? el.dataset.coachTip : null; })() };
    });
    if (st) samples.push({ t: Date.now() - t0, ...st });
    if (st && !firstShot && st.tick > 5) { await shot(page, 'd02_match_start'); firstShot = true; }
    if (st && st.phase === 'play' && !first) { first = { t: Date.now() - t0, ...st }; console.log('FIRST PLAY', JSON.stringify(first)); }
    if (first && Date.now() - t0 > first.t + 1500) break;
    await page.waitForTimeout(100);
  }
  // print condensed samples
  let last = '';
  for (const s of samples) { const k = `${s.phase}|${s.r?.stage}|${s.r?.taker}|${s.owner}|${s.tipShown}`; if (k !== last) { console.log(JSON.stringify(s)); last = k; } }
  await shot(page, 'd03_after_kick');
  await browser.close();
})();
