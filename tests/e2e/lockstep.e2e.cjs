// Link two tabs: two pages of the same file:// origin play each other over BroadcastChannel in
// deterministic lockstep. Host + join, play to full-time with scripted inputs on both sides,
// then check that no desync was reported and both tabs finished on the same tick, score and hash.

const { test, expect } = require('./lib/harness.cjs');
const { APP_URL, SEL, openApp, goTab, readSave, skipOnboarding } = require('./lib/helpers.cjs');

/** A second tab in the same browser context (same origin, so BroadcastChannel connects them). */
async function secondTab(page, problems) {
  const p = await page.context().newPage();
  p.setDefaultTimeout(20_000);
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  p.on('pageerror', (e) => problems.push(`guest pageerror: ${e.message}`));
  p.on('console', (m) => {
    const where = m.location().url || '';
    // Fonts are unreachable here, and the root-relative manifest/icon links cannot resolve on file://.
    if (m.type() !== 'error' || /fonts\.(googleapis|gstatic)\.com/.test(`${where} ${m.text()}`) || /^file:\/\/\/(manifest\.webmanifest|icons\/|sw\.js)/.test(where)) return;
    problems.push(`guest console.error: ${m.text()}`);
  });
  await p.goto(APP_URL);
  // The club is owned by the first tab, so the second one is offered as a read-only guest (src/client/guardView.ts).
  await p.locator('#guard-guest').click();
  await p.waitForSelector(SEL.app + ' *');
  await skipOnboarding(p);
  return p;
}

/** The linked match's status attributes, or null once the tab has moved on (no waiting). */
const net = (page) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
    tick: Number(el.dataset.tick || 0),
    desync: el.dataset.desync || null,
    stopped: el.dataset.stopped || null,
    stallMs: Number(el.dataset.stallMs || 0),
    longestStallMs: Number(el.dataset.longestStallMs || 0),
    stallEvents: Number(el.dataset.stallEvents || 0),
    rttMs: Number(el.dataset.rttMs || 0),
    checks: Number(el.dataset.checks || 0),
    score: [document.getElementById('sb-h').textContent, document.getElementById('sb-a').textContent].join('-'),
    };
  }, SEL.netMatch);

test('Link two tabs: host and guest play a lockstep match to full-time with no desync', async (t) => {
  const problems = [];
  // 2 x 5 s halves keeps the run near 15 s including kick-off and half-time pauses.
  const host = await openApp(t, { prefs: { halfSeconds: 5, controls: 'mouse' } });
  const before = await readSave(host);
  const guest = await secondTab(host, problems);

  await goTab(host, SEL.homeScreen);
  await host.locator(SEL.playLink).click();
  await host.locator(SEL.linkHost).click();
  const code = (await host.locator(SEL.linkCode).innerText()).trim();
  expect(code, 'room code shown').toMatch(/^[A-Z0-9]{4}$/);

  await goTab(guest, SEL.homeScreen);
  await guest.locator(SEL.playLink).click();
  await guest.locator(SEL.linkCodeInput).fill(code.toLowerCase());
  await guest.locator(SEL.linkJoin).click();
  await Promise.all([host.waitForSelector(SEL.netMatch), guest.waitForSelector(SEL.netMatch)]);
  expect(await host.locator(SEL.netMatch).getAttribute('data-side'), 'host is home').toBe('0');
  expect(await guest.locator(SEL.netMatch).getAttribute('data-side'), 'guest is away').toBe('1');

  // Scripted play on both: the host steers with the mouse and clicks, the guest with the keys.
  const box = await host.locator(SEL.pitch).boundingBox();
  let playing = true;
  const hostScript = (async () => {
    for (let i = 0; playing; i++) {
      const u = (Math.sin(i / 7) + 1) / 2;
      const v = (Math.cos(i / 5) + 1) / 2;
      await host.mouse.move(box.x + box.width * (0.35 + 0.5 * u), box.y + box.height * (0.15 + 0.7 * v));
      if (i % 9 === 0) await host.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
      await host.waitForTimeout(60);
    }
  })();
  const guestScript = (async () => {
    const keys = ['ArrowLeft', 'ArrowUp', 'ArrowLeft', 'ArrowDown'];
    for (let i = 0; playing; i++) {
      const k = keys[i % keys.length];
      await guest.keyboard.down(k);
      if (i % 3 === 0) await guest.keyboard.press('Space');
      await guest.waitForTimeout(250);
      await guest.keyboard.up(k);
    }
  })();

  // While it runs, the two tabs never drift apart by more than the input delay (plus read skew).
  let maxGap = 0;
  let samples = 0;
  let last = { host: null, guest: null };
  for (let i = 0; i < 80; i++) {
    const [a, b] = await Promise.all([net(host).catch(() => null), net(guest).catch(() => null)]);
    if (!a || !b) break; // a tab has moved on to the result dialog
    last = { host: a, guest: b };
    expect(a.desync, `host reports no desync (tick ${a.tick})`).toBe(null);
    expect(b.desync, `guest reports no desync (tick ${b.tick})`).toBe(null);
    expect(a.stopped, 'host not stopped').toBe(null);
    expect(b.stopped, 'guest not stopped').toBe(null);
    maxGap = Math.max(maxGap, Math.abs(a.tick - b.tick));
    if (process.env.E2E_DEBUG) console.log(Date.now(), a.tick, b.tick, a.stallMs, b.stallMs, a.rttMs);
    samples++;
    await host.waitForTimeout(250);
  }
  playing = false;
  await Promise.all([hostScript, guestScript]);
  expect(samples, 'sampled the match while it ran').toBeGreaterThan(20);
  expect(maxGap, 'tick gap between tabs').toBeLessThanOrEqual(16);
  expect(last.host.checks, 'state hashes matched during play').toBeGreaterThan(5);

  // Both reach the result dialog with the same final line: score, tick and state hash.
  await Promise.all([host.locator(SEL.modal).waitFor({ timeout: 30_000 }), guest.locator(SEL.modal).waitFor({ timeout: 30_000 })]);
  const [hn, gn] = await Promise.all([host.locator(SEL.resultNote).innerText(), guest.locator(SEL.resultNote).innerText()]);
  expect(hn, 'final line has tick and hash').toMatch(/at tick \d+, state #[0-9a-f]{8}/);
  expect(gn, 'guest final line equals host final line').toBe(hn);
  expect(await host.locator(SEL.modal).innerText(), 'nothing recorded').toMatch(/no Elo/i);
  const after = await readSave(host);
  expect(after.club.elo, 'Elo unchanged').toBe(before.club.elo);
  expect(after.history.length, 'no match recorded').toBe(before.history.length);

  // Feel numbers, for docs/ROADMAP.md: how often each tab waited on the other, and the round trip.
  console.log(`      lockstep stats: ticks ${last.host.tick}, max gap ${maxGap} ticks, host waited ${last.host.stallMs} ms (longest ${last.host.longestStallMs} ms, ${last.host.stallEvents} waits), guest waited ${last.guest.stallMs} ms (longest ${last.guest.longestStallMs} ms), RTT ${last.host.rttMs} ms, checks ${last.host.checks}; ${hn}`);
  if (problems.length) throw new Error(problems.join('\n'));
});

test('Link two tabs: a wrong code times out with a clear message', async (t) => {
  const page = await openApp(t);
  await goTab(page, SEL.homeScreen);
  await page.locator(SEL.playLink).click();
  expect(await page.locator(SEL.linkUnsupported).count(), 'file:// tabs are supported').toBe(0);
  await page.locator(SEL.linkCodeInput).fill('ZZZZ');
  await page.locator(SEL.linkJoin).click();
  await page.waitForFunction((sel) => /No host answered/.test(document.querySelector(sel).textContent), SEL.linkStatus, { timeout: 12_000 });
  expect(await page.locator(SEL.linkJoin).isEnabled(), 'can try again').toBe(true);
});

test('Link two tabs: when one tab goes quiet the other shows "waiting for opponent", then the leaver is reported', async (t) => {
  const problems = [];
  const host = await openApp(t, { prefs: { controls: 'mouse' } }); // the standard length: long enough to freeze a tab mid-match
  const guest = await secondTab(host, problems);
  await goTab(host, SEL.homeScreen);
  await host.locator(SEL.playLink).click();
  await host.locator(SEL.linkHost).click();
  const code = (await host.locator(SEL.linkCode).innerText()).trim();
  await goTab(guest, SEL.homeScreen);
  await guest.locator(SEL.playLink).click();
  await guest.locator(SEL.linkCodeInput).fill(code);
  await guest.locator(SEL.linkJoin).click();
  await Promise.all([host.waitForSelector(SEL.netMatch), guest.waitForSelector(SEL.netMatch)]);
  await host.waitForTimeout(800);

  // Freeze the guest's page (no frames, no timers, no messages handled): the host must stall.
  const cdp = await guest.context().newCDPSession(guest);
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }).catch(() => {});
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await host.locator(SEL.netWait).waitFor({ state: 'visible', timeout: 5000 });
  const t1 = await net(host);
  await host.waitForTimeout(500);
  const t2 = await net(host);
  expect(t2.tick, 'host does not advance while the guest is frozen').toBe(t1.tick);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {});
  await host.locator(SEL.netWait).waitFor({ state: 'hidden', timeout: 5000 });
  await host.waitForTimeout(500);
  expect((await net(host)).tick, 'host advances again').toBeGreaterThan(t2.tick);

  // The guest leaves from its menu: the host is told.
  await guest.keyboard.press('Escape');
  await guest.locator('#net-leave').click();
  await host.locator(SEL.netStop).waitFor({ state: 'visible', timeout: 5000 });
  expect(await host.locator(SEL.netStop).innerText(), 'host told the opponent left').toMatch(/left/i);
  if (problems.length) throw new Error(problems.join('\n'));
});
