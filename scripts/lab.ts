// Build the player lab (src/client/r3d/lab.ts) into dist/lab.html: a dev page, not shipped with the game.
//   bun run scripts/lab.ts && open dist/lab.html?cam=close
// Screenshots: NODE_PATH="$(npm root -g)" node scripts/player-lab.cjs [outDir] [t...]

import { mkdir, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const out = await Bun.build({ entrypoints: [`${root}src/client/r3d/lab.ts`], target: 'browser', minify: false });
if (!out.success) {
  for (const l of out.logs) console.error(l);
  process.exit(1);
}
const js = await out.outputs[0].text();
await mkdir(`${root}dist`, { recursive: true });
await writeFile(`${root}dist/lab.html`, `<!doctype html><meta charset="utf-8"><title>Player lab</title><body><script type="module">${js.replace(/<\/script/g, '<\\/script')}</script></body>`);
console.log(`dist/lab.html: ${(js.length / 1024).toFixed(0)} KB`);
