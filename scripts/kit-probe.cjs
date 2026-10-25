#!/usr/bin/env node
// How kits and grass actually look in the 3D view: renders one player in a given shirt, close up,
// at low and high quality, and reads the shirt and grass pixels back from screenshots. Used to fit
// and check the "as drawn" colour model in src/client/kits.ts (shirtAsRendered, GRASS), and to
// measure how well a player's outline stands out from the grass (with and without the dark rim).
//
//   bun run build && NODE_PATH="$(npm root -g)" node scripts/kit-probe.cjs [#rrggbb ...]
//
// With no colours it probes every ladder shirt (KIT_COLORS, both colours) and the neutral kits.
// PROBE_QUALITY=low or high probes one quality level only; PROBE_DIR=dir saves the screenshots.
// Prints JSON lines: { quality, hex, shirt (median of his torso pixels), edge (median of his
// silhouette pixels next to the grass), grass: [dark, light stripe] }, all '#rrggbb' as drawn.
// The player is controlled (nearest the ball), so the shirt is found above his yellow ring.

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

const KIT_COLORS = [
  ['#c8102e', '#ffffff'], ['#1d3f8f', '#ffffff'], ['#0b7a3e', '#f4d03f'], ['#f2a900', '#1a1a1a'],
  ['#5b2a86', '#ffffff'], ['#111827', '#e5e7eb'], ['#0e7490', '#fde68a'], ['#9f1239', '#93c5fd'],
  ['#ea580c', '#0f172a'], ['#e5e7eb', '#1e3a8a'], ['#166534', '#ffffff'], ['#7c2d12', '#38bdf8'],
];
const args = process.argv.slice(2).filter((a) => /^#[0-9a-f]{6}$/i.test(a));
const shirts = args.length ? args : [...new Set([...KIT_COLORS.flat(), '#1c1c1c', '#f5f5f5'])];

async function waitFor(page, fn, arg, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** RGBA pixels of a PNG, decoded in the page. */
async function pixels(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, d: Array.from(g.getImageData(0, 0, img.width, img.height).data) };
  }, png.toString('base64'));
}

const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t = {
    async newPage(opts) {
      const ctx = await browser.newContext(opts);
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      return ctx.newPage();
    },
  };
  for (const quality of process.env.PROBE_QUALITY ? [process.env.PROBE_QUALITY] : ['low', 'high']) {
    for (const shirt of shirts) {
      const second = shirt === '#ffffff' || shirt === '#f5f5f5' ? '#1a1a1a' : '#ffffff';
      // eslint-disable-next-line no-new-func
      const mutateSave = new Function('save', `save.club.primary = '${shirt}'; save.club.secondary = '${second}';`);
      const page = await openApp(t, { width: 1280, height: 800, prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d', query: `quality=${quality}`, mutateSave });
      await page.evaluate(() => localStorage.setItem('derby-zoom', '0.6'));
      await startRanked(page);
      await waitFor(page, () => window.__derbyMatch && window.__derbyMatch.phase === 'play');
      // One of our outfield players beside a still ball at the centre spot, everyone else frozen off
      // to the side. He is the one controlled (nearest the ball), so the yellow ring at his feet finds him.
      const applied = await page.evaluate(() => {
        const s = window.__derbyMatch;
        const me = s.humans[0] ? 0 : 1;
        const one = s.players.find((p) => p.team === me && p.role !== 'GK');
        for (const p of s.players) {
          p.stun = 1e7;
          p.vel = { x: 0, y: 0 };
          if (p !== one) p.pos = { x: 4 + (p.i % 11) * 1.5, y: 2 + Math.floor(p.i / 11) * 2 };
        }
        one.pos = { x: 52.5, y: 34 };
        s.ball.owner = -1;
        s.ball.pos = { x: 51, y: 36 };
        s.ball.vel = { x: 0, y: 0 };
        s.ball.z = 0;
        return s.teams[me].primary;
      });
      await page.waitForTimeout(1500);
      const shot = await page.locator('#pitch').screenshot();
      if (process.env.PROBE_DIR) fs.writeFileSync(path.join(process.env.PROBE_DIR, `${quality}-${shirt.slice(1)}.png`), shot);
      const a = await pixels(page, shot);
      const px = (x, y) => {
        const i = (y * a.w + x) * 4;
        return [a.d[i], a.d[i + 1], a.d[i + 2]];
      };
      // The controlled player's ring: its yellow pixels' centre (the ring sits round his feet).
      let rx = 0;
      let ry = 0;
      let rn = 0;
      let top = a.h;
      for (let y = Math.round(a.h * 0.35); y < a.h * 0.85; y++)
        for (let x = Math.round(a.w * 0.25); x < a.w * 0.75; x++) {
          const [r, g, b] = px(x, y);
          if (r > 235 && g > 195 && g < 232 && b < 60) {
            rx += x;
            ry += y;
            rn++;
            top = Math.min(top, y);
          }
        }
      rx = Math.round(rx / rn);
      ry = Math.round(ry / rn);
      // His torso: a box above the ring (the ring's half-height sets the scale), and of its pixels the
      // half nearest the shirt's hue (skin, hair, shorts and grass fall away).
      const s = Math.max(4, ry - top);
      const want = parse(applied);
      const norm = (c) => {
        const t = c[0] + c[1] + c[2] + 1;
        return [c[0] / t, c[1] / t, c[2] / t];
      };
      const wn = norm(want);
      const d2 = (c) => norm(c).reduce((n, v, k) => n + (v - wn[k]) ** 2, 0);
      const box = [];
      for (let y = Math.round(ry - 2.3 * s); y < Math.round(ry - 1.3 * s); y++) for (let x = rx - Math.round(0.5 * s); x <= rx + Math.round(0.5 * s); x++) box.push(px(x, y));
      const take = box.sort((p, q) => d2(p) - d2(q)).slice(0, Math.max(3, Math.floor(box.length / 2)));
      const med = [0, 1, 2].map((k) => median(take.map((c) => c[k])));
      // The grass round about, split into its light and dark mowing stripes.
      const grass = [];
      for (let y = Math.round(a.h * 0.3); y < a.h * 0.8; y += 2) for (let x = 0; x < a.w; x += 2) {
        const c = px(x, y);
        if (c[1] > c[0] + 30 && c[1] > c[2] + 30) grass.push(c);
      }
      grass.sort((p, q) => p[1] - q[1]);
      const lo = grass.slice(0, grass.length >> 1);
      const hi = grass.slice(grass.length >> 1);
      const stripes = [lo, hi].map((g) => hex([0, 1, 2].map((k) => median(g.map((c) => c[k])))));
      // His silhouette: player pixels (not within reach of either stripe's colour) next to grass, from
      // the knees to the top of his head. Their median is what separates him from the pitch.
      const sc = [lo, hi].map((g) => [0, 1, 2].map((k) => median(g.map((c) => c[k]))));
      const isGrass = (c) => sc.some((g) => Math.hypot(c[0] - g[0], c[1] - g[1], c[2] - g[2]) < 45);
      const edge = [];
      for (let y = Math.round(ry - 3 * s); y < Math.round(ry - 0.6 * s); y++)
        for (let x = rx - Math.round(1.3 * s); x <= rx + Math.round(1.3 * s); x++) {
          if (isGrass(px(x, y))) continue;
          if ([px(x - 1, y), px(x + 1, y), px(x, y - 1), px(x, y + 1)].some(isGrass)) edge.push(px(x, y));
        }
      const edgeMed = edge.length ? hex([0, 1, 2].map((k) => median(edge.map((c) => c[k])))) : null;
      console.log(JSON.stringify({ quality, hex: applied, shirt: hex(med), edge: edgeMed, edgePx: edge.length, px: box.length, ring: s, grass: stripes }));
      await page.context().close();
    }
  }
  await browser.close();
})();
