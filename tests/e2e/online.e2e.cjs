// Online friendlies: two pages in separate browser contexts (so BroadcastChannel can't connect
// them; only the relay can) pair through the Bun relay (server/bun.ts) on a free local port,
// with ?relay=ws://127.0.0.1:<port>/ws. They play lockstep, compare state hashes, survive a
// dropped socket, and when one page crashes the other shows the disconnect countdown and ends
// the match as an abandoned friendly.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, readSave } = require('./lib/helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function bunBinary() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN;
  const home = path.join(process.env.HOME || '/root', '.bun', 'bin', 'bun');
  return fs.existsSync(home) ? home : 'bun';
}

/** Start the relay on a free port; resolves to { port, stop }. */
function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn(bunBinary(), [path.join(ROOT, 'server', 'bun.ts')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', RELAY_QUIET: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${out}`)), 15_000);
    const onData = (d) => {
      out += d;
      const m = /listening on port (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve({ port: Number(m[1]), stop: () => child.kill('SIGTERM') });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const net = (page) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const w = document.getElementById('net-wait');
    return {
      tick: Number(el.dataset.tick || 0),
      desync: el.dataset.desync || null,
      stopped: el.dataset.stopped || null,
      checks: Number(el.dataset.checks || 0),
      link: el.dataset.link || null,
      lost: Number(el.dataset.lost || 0),
      wait: w && !w.hidden ? w.textContent : null,
      mode: el.dataset.mode,
    };
  }, SEL.netMatch);

const hashes = (page) => page.evaluate(() => Object.fromEntries(window.__derbyNetHashes || []));

const T0 = Date.now();
const step = (what) => process.env.E2E_DEBUG && console.log(`      [${((Date.now() - T0) / 1000).toFixed(1)}s] ${what}`);

async function pairedPages(t, relayPort, opts = {}) {
  const query = `relay=${encodeURIComponent(`ws://127.0.0.1:${relayPort}/ws`)}`;
  // The 2D renderer: this is a network test, and two SwiftShader WebGL pages in separate
  // processes can each block their main thread for seconds while compiling shaders.
  const common = { prefs: { controls: 'mouse', ...(opts.prefs || {}) }, query, e2eHook: true, renderer: '2d' };
  const host = await openApp(t, common);
  const guest = await openApp(t, common);
  await goTab(host, SEL.homeScreen);
  await host.locator(SEL.playOnline).click();
  await host.locator(SEL.onlineHost).click();
  await host.locator(SEL.onlineCode).waitFor({ state: 'visible', timeout: 10_000 });
  const code = (await host.locator(SEL.onlineCode).innerText()).trim();
  const link = await host.locator(SEL.onlineLink).inputValue();
  return { host, guest, code, link };
}

test('Online: Home shows no Online option without a relay', async (t) => {
  const page = await openApp(t);
  await goTab(page, SEL.homeScreen);
  expect(await page.locator(SEL.playLink).count(), 'two tabs still offered').toBe(1);
  expect(await page.locator(SEL.playOnline).count(), 'no relay, no Online button').toBe(0);
});

test('Online: two browsers pair by invite link, stay in sync through a dropped socket, and a crash ends in an abandoned friendly', async (t) => {
  const relay = await startRelay();
  try {
    const { host, guest, code, link } = await pairedPages(t, relay.port);
    expect(code, 'room code').toMatch(/^[A-Z0-9]{5}$/);
    expect(link, 'invite link').toContain(`?join=${code}`);
    expect(await host.locator(SEL.onlineStatus).innerText(), 'host waiting').toMatch(/Waiting for them to join/);
    const before = await readSave(host);

    step('lobby ready');
    // The guest opens the invite link and lands in the match without typing anything.
    await guest.goto(`${link}&renderer=2d`);
    await Promise.all([host.waitForSelector(SEL.netMatch, { timeout: 20_000 }), guest.waitForSelector(SEL.netMatch, { timeout: 20_000 })]);
    expect(await guest.evaluate(() => location.search), 'join code removed from the address').notToContain('join=');
    const [h0, g0] = await Promise.all([net(host), net(guest)]);
    expect([h0.mode, g0.mode], 'online mode').toEqual(['online', 'online']);
    expect(await host.locator(SEL.netMatch).getAttribute('data-side'), 'host is home').toBe('0');
    expect(await guest.locator(SEL.netMatch).getAttribute('data-side'), 'guest is away').toBe('1');

    step('paired');
    // Some play: the host waves the mouse and clicks.
    const box = await host.locator(SEL.pitch).boundingBox();
    let playing = true;
    const script = (async () => {
      for (let i = 0; playing; i++) {
        await host.mouse.move(box.x + box.width * (0.3 + 0.4 * ((Math.sin(i / 6) + 1) / 2)), box.y + box.height * (0.3 + 0.4 * ((Math.cos(i / 4) + 1) / 2)));
        if (i % 10 === 0) await host.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
        await host.waitForTimeout(80);
      }
    })();
    await host.waitForFunction((sel) => Number(document.querySelector(sel)?.dataset.tick || 0) > 300, SEL.netMatch, { timeout: 40_000 });

    step('played 300 ticks');
    // Drop the guest's socket as a network blip would: it reconnects, resumes its seat and play goes on.
    await guest.evaluate(() => window.__derbyNet.drop());
    await guest.waitForFunction(() => window.__derbyNet.resumes === 1 && window.__derbyNet.status === 'open', null, { timeout: 15_000 });
    step('guest resumed');
    const afterDrop = (await net(host)).tick;
    await host.waitForFunction((args) => Number(document.querySelector(args[0])?.dataset.tick || 0) > args[1] + 120, [SEL.netMatch, afterDrop], { timeout: 40_000 });
    playing = false;
    await script;

    const [h1, g1] = await Promise.all([net(host), net(guest)]);
    expect(h1.desync, 'host: no desync').toBe(null);
    expect(g1.desync, 'guest: no desync').toBe(null);
    expect(h1.stopped, 'host not stopped').toBe(null);
    expect(h1.checks, 'hash checks passed on the host').toBeGreaterThanOrEqual(4);
    // Both sides' own record of the state hash every 60 ticks: identical wherever both have one.
    const [hh, gh] = await Promise.all([hashes(host), hashes(guest)]);
    const common = Object.keys(hh).filter((k) => k in gh);
    expect(common.length, 'ticks hashed on both sides').toBeGreaterThanOrEqual(5);
    for (const k of common) expect(gh[k], `state hash at tick ${k}`).toBe(hh[k]);

    step('checks done');
    // Crash the guest's renderer: its socket dies with it, the relay tells the host, the host counts down.
    const cdp = await guest.context().newCDPSession(guest);
    // The crashed renderer never answers this command, so don't wait for it.
    cdp.send('Page.crash').catch(() => {});
    await host.waitForFunction((sel) => /Opponent disconnected, waiting \d+ s/.test(document.getElementById('net-wait')?.textContent || '') && !document.getElementById('net-wait').hidden, SEL.netMatch, { timeout: 10_000 });
    step('countdown visible');
    const c1 = await net(host);
    await host.waitForTimeout(2200);
    const c2 = await net(host);
    expect(c1.lost, 'countdown starts near 20 s').toBeGreaterThanOrEqual(15);
    expect(c2.lost, 'countdown runs down').toBeLessThan(c1.lost);
    expect(c2.tick, 'match paused while the opponent is gone').toBe(c1.tick);
    console.log(`      online: ${common.length} shared hashes equal, host checks ${h1.checks}, countdown ${c1.wait} -> ${c2.wait}`);

    step('countdown checked');
    // Nobody comes back: an abandoned friendly, nothing recorded.
    await host.locator(SEL.modal).waitFor({ timeout: 30_000 });
    expect(await host.locator(SEL.modal).innerText(), 'abandoned result').toMatch(/Abandoned/);
    const after = await readSave(host);
    expect(after.club.elo, 'Elo unchanged').toBe(before.club.elo);
    expect(after.history.length, 'nothing recorded').toBe(before.history.length);
  } finally {
    relay.stop();
  }
});

test('Online: a wrong code and a different game version get clear messages', async (t) => {
  const relay = await startRelay();
  try {
    const { guest, code } = await pairedPages(t, relay.port);
    await goTab(guest, SEL.homeScreen);
    await guest.locator(SEL.playOnline).click();
    await guest.locator(SEL.onlineCodeInput).fill('ZZZZZ');
    await guest.locator(SEL.onlineJoin).click();
    await guest.waitForFunction((sel) => /No match with code ZZZZZ/.test(document.querySelector(sel).textContent), SEL.onlineStatus, { timeout: 10_000 });
    expect(await guest.locator(SEL.onlineJoin).isEnabled(), 'can try again').toBe(true);

    // Pretend to be an older build: rewrite the version this page sends to the relay.
    await guest.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) {
        return send.call(this, typeof d === 'string' ? d.replace(/"v":"[^"]*"/, '"v":"p1.s0.r0"') : d);
      };
    });
    await guest.locator(SEL.onlineCodeInput).fill(code);
    await guest.locator(SEL.onlineJoin).click();
    await guest.waitForFunction((sel) => /different version/.test(document.querySelector(sel).textContent), SEL.onlineStatus, { timeout: 10_000 });
    expect(await guest.locator(SEL.onlineLobby).getAttribute('data-state'), 'version state').toBe('version');
  } finally {
    relay.stop();
  }
});
