// Fails when the built page grows past its budget, and prints the size either way.
//   bun run size            (after `bun run build`)
// The budget is the size when this check was added (2026-10-24: 1,001,948 bytes) plus 25%. When a feature
// really needs more, raise BUDGET_BYTES in the same PR and say why in the description; never delete the check.
// 2026-10-25: raised to 1,400,000. The owner set in-match gameplay (models, audio, HUD, physics) as the priority,
// and main had reached 1,246,647 bytes (about 352 KB gzipped) with more of that work queued.

const BUDGET_BYTES = 1_400_000;

const file = new URL('../dist/index.html', import.meta.url).pathname;
const f = Bun.file(file);
if (!(await f.exists())) {
  console.error('dist/index.html is missing. Run `bun run build` first.');
  process.exit(2);
}
const bytes = f.size;
const gz = Bun.gzipSync(new Uint8Array(await f.arrayBuffer())).length;
const pct = Math.round((bytes / BUDGET_BYTES) * 100);
console.log(`dist/index.html: ${bytes.toLocaleString('en-GB')} bytes (${(bytes / 1024).toFixed(0)} KB, ${(gz / 1024).toFixed(0)} KB gzipped) = ${pct}% of the ${BUDGET_BYTES.toLocaleString('en-GB')} byte budget`);
if (bytes > BUDGET_BYTES) {
  console.error(`Over budget by ${(bytes - BUDGET_BYTES).toLocaleString('en-GB')} bytes. Trim the bundle, or raise BUDGET_BYTES in scripts/size-budget.ts with a reason.`);
  process.exit(1);
}
