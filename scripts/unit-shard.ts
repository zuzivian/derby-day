// Splitting the unit tests (tests/*.test.ts) into groups so CI can run them as parallel jobs, by file, balanced by the
// seconds per file in tests/unit-weights.json (the same split as the e2e shards: tests/e2e/lib/shard.cjs).
//
//   bun test $(bun run scripts/unit-shard.ts 1/2)    the first of two groups (prints the files, one per line)
//   bun run scripts/unit-shard.ts --measure          time every file on its own and rewrite tests/unit-weights.json
//
// tests/shard.test.ts checks the groups run every file exactly once. A new file with no weight counts as the median.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shardItems } = require('../tests/e2e/lib/shard.cjs') as { shardItems: (items: string[], spec: string, weights?: Record<string, number>) => string[] };

const dir = new URL('../tests/', import.meta.url).pathname;
const weightsPath = `${dir}unit-weights.json`;
/** Every unit test file, by name. */
export const unitFiles = () => readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
export const unitWeights = (): Record<string, number> => JSON.parse(readFileSync(weightsPath, 'utf8'));

if (import.meta.main) {
  const arg = process.argv[2] ?? '';
  if (arg === '--measure') {
    const weights: Record<string, number> = {};
    for (const f of unitFiles()) {
      const t0 = performance.now();
      const r = Bun.spawnSync([process.execPath, 'test', `./tests/${f}`], { stdout: 'ignore', stderr: 'ignore' });
      weights[f] = Math.round((performance.now() - t0) / 100) / 10;
      console.log(`${f}: ${weights[f]} s${r.exitCode ? ' (failed)' : ''}`);
    }
    writeFileSync(weightsPath, `${JSON.stringify(weights, null, 2)}\n`);
  } else {
    // ./ makes each an exact path for `bun test` (a bare name is a filter: rules.test.ts would also pick rules-laws.test.ts).
    for (const f of shardItems(unitFiles(), arg, unitWeights())) console.log(`./tests/${f}`);
  }
}
