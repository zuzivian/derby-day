#!/usr/bin/env node
// Regenerates the committed images in static/: PNG icons from static/icons/favicon.svg and the
// 1200x630 share image from scripts/share-template.html. Run by hand when the art changes:
//
//   NODE_PATH="$(npm root -g)" node scripts/make-assets.cjs
//
// Playwright is not a repo dependency (see tests/e2e/run.cjs for how it is found). The output is
// committed, so `bun run build` never needs a browser.

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

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'static/icons/favicon.svg'), 'utf8');
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

/** The crest on its own, or inset on a full-bleed square (maskable icons keep to the middle 80%). */
const iconPage = (size, maskable, inset = 0.74) =>
  `<!doctype html><body style="margin:0;background:${maskable ? '#17223a' : 'transparent'}">` +
  `<div style="width:${size}px;height:${size}px;display:grid;place-items:center">` +
  `<div style="width:${maskable ? size * inset : size}px;height:${maskable ? size * inset : size}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></div>`;

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: exe });
  const shot = async (html, w, h, out, opaque) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.screenshot({ path: path.join(root, out), omitBackground: !opaque });
    await page.close();
    console.log('wrote', out);
  };
  await shot(iconPage(192, false), 192, 192, 'static/icons/icon-192.png');
  await shot(iconPage(512, false), 512, 512, 'static/icons/icon-512.png');
  await shot(iconPage(512, true), 512, 512, 'static/icons/icon-maskable-512.png', true);
  await shot(iconPage(180, true, 0.86), 180, 180, 'static/icons/apple-touch-icon.png', true);
  const tpl = fs.readFileSync(path.join(root, 'scripts/share-template.html'), 'utf8').replace('<!--CREST-->', svg.replace('<svg ', '<svg width="100%" height="100%" '));
  await shot(tpl, 1200, 630, 'static/og.png', true);
  await browser.close();
})();
