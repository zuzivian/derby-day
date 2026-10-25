#!/usr/bin/env node
// Screenshots of the 3D match view for checking how it reads: the human keeper's long view (ball in
// his hands) and open play, at a phone's 390x844 or any size, at low and high quality.
//
//   bun run build && NODE_PATH="$(npm root -g)" node scripts/view-probe.cjs [outDir=probe] [width=390] [height=844]
//
// CLUB_KIT=#rrggbb,#rrggbb sets your club's colours (shirt, then the second colour) first.
// SEED=n makes Math.random seeded (and Date.now fixed) in the page: the same fixture on every build.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function loadPlaywright() {
  for (const f of [() => require('playwright'), () => require('/opt/node22/lib/node_modules/playwright'), () => require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'))]) {
    try {
      return f();
    } catch {
      /* next */
    }
  }
  console.error('Could not find Playwright. npm i -g playwright@1 and set NODE_PATH="$(npm root -g)".');
  process.exit(2);
}

const { openApp, startRanked } = require('../tests/e2e/lib/helpers.cjs');

const outDir = path.resolve(process.argv[2] || 'probe');
const width = Number(process.argv[3] || 390);
const height = Number(process.argv[4] || 844);

async function waitFor(page, fn, arg, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

(async () => {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const seed = Number(process.env.SEED || 0);
  const t = {
    async newPage(opts) {
      const ctx = await browser.newContext(opts);
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      // SEED=n: Math.random is a seeded generator in the page and Date.now is held, so the club, the
      // opponent, the crowd and the players are the same from one build to the next (before and after).
      if (seed) {
        await ctx.addInitScript((n) => {
          let a = n >>> 0;
          Math.random = () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let x = Math.imul(a ^ (a >>> 15), 1 | a);
            x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
            return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
          };
          // A new club's seed mixes in Date.now() (main.ts): hold it at a fixed base, moving only
          // every couple of minutes, so it doesn't vary between runs.
          const base = 1_700_000_000_000;
          Date.now = () => base + (Math.floor(performance.now()) & ~0x1ffff);
        }, seed);
      }
      return ctx.newPage();
    },
  };
  for (const quality of ['low', 'high']) {
    const kit = (process.env.CLUB_KIT || '').split(',').filter((c) => /^#[0-9a-f]{6}$/i.test(c));
    // eslint-disable-next-line no-new-func
    const mutateSave = kit.length === 2 ? new Function('save', `save.club.primary = '${kit[0]}'; save.club.secondary = '${kit[1]}';`) : undefined;
    const page = await openApp(t, { width, height, prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d', query: `quality=${quality}`, mutateSave });
    await startRanked(page);
    await waitFor(page, () => window.__derbyMatch && window.__derbyMatch.phase === 'play');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, `${quality}-play-${width}x${height}.png`) });
    // The human keeper with the ball in his hands, everyone else stood still: the long view.
    await page.evaluate(() => {
      const s = window.__derbyMatch;
      const me = s.humans[0] ? 0 : 1;
      const gk = s.players.find((p) => p.team === me && p.role === 'GK');
      for (const p of s.players) if (p !== gk) p.stun = 1e7;
      s.ball.owner = gk.i;
      s.ball.inHands = true;
      s.ball.pos = { ...gk.pos };
      s.ball.vel = { x: 0, y: 0 };
      s.ball.z = 1;
    });
    // Software rendering at high quality runs at a few frames a second here, so the camera takes
    // seconds to ease in; at low quality play runs faster and the keeper would kick it long first.
    await page.waitForTimeout(quality === 'high' ? 8000 : 3000);
    const cam = await page.evaluate(() => {
      const s = window.__derbyMatch;
      const k = s.players[s.controlled[s.humans[0] ? 0 : 1]];
      return `${document.querySelector('#pitch').dataset.camera}, controlled ${k.role} at ${k.pos.x.toFixed(1)}, ${k.pos.y.toFixed(1)}`;
    });
    await page.screenshot({ path: path.join(outDir, `${quality}-long-${width}x${height}.png`) });
    console.log(`${quality}: camera ${cam}`);
    await page.context().close();
  }
  await browser.close();
})();
