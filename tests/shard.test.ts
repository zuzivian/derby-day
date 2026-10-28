// The e2e shards (E2E_SHARD=k/n, tests/e2e/lib/shard.cjs) must run every e2e test exactly once between them, and split
// the work about evenly, or a CI job would silently skip tests or finish long after the others.

import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { shardItems, shardLoads } = require('./e2e/lib/shard.cjs') as {
  shardItems: (items: string[], spec: string, weights?: Record<string, number>) => string[];
  shardLoads: (items: string[], n: number, weights?: Record<string, number>) => number[];
};

const dir = new URL('./e2e/', import.meta.url).pathname;
// Loading a test file only registers its tests (lib/harness.cjs), as run.cjs does to list them.
const { registry } = require('./e2e/lib/harness.cjs') as { registry: { name: string }[] };
for (const f of readdirSync(dir).filter((f) => f.endsWith('.e2e.cjs')).sort()) require(`${dir}${f}`);
const names = registry.map((t) => t.name);
const weightsPath = `${dir}shard-weights.json`;
const weights: Record<string, number> = existsSync(weightsPath) ? JSON.parse(readFileSync(weightsPath, 'utf8')) : {};
// The number of e2e jobs in .github/workflows/ci.yml.
const CI_SHARDS = Number(/shard: \[([\d, ]+)\]/.exec(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))![1].split(',').length);

describe('e2e sharding', () => {
  test('every e2e test has its own name (the shards and the weights go by name)', () => expect(new Set(names).size).toBe(names.length));

  for (const n of [1, 2, 3, CI_SHARDS]) {
    test(`${n} shard(s): disjoint, and together every test`, () => {
      const groups = Array.from({ length: n }, (_, i) => shardItems(names, `${i + 1}/${n}`, weights));
      const all = groups.flat();
      expect(all.length).toBe(names.length);
      expect([...new Set(all)].sort()).toEqual([...names].sort());
    });
  }

  test('a shard runs its tests in their own order (file by file, as each file declares them)', () => {
    const order = new Map(names.map((x, i) => [x, i]));
    for (let k = 1; k <= CI_SHARDS; k++) {
      const idx = shardItems(names, `${k}/${CI_SHARDS}`, weights).map((x) => order.get(x)!);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });

  test('an empty spec runs everything', () => expect(shardItems(names, '', weights)).toEqual(names));

  test('a bad spec is refused', () => {
    for (const bad of ['3', '0/3', '4/3', 'a/b', '1/0']) expect(() => shardItems(names, bad, weights)).toThrow();
  });

  test('the split is deterministic', () => expect(shardItems(names, '2/3', weights)).toEqual(shardItems(names, '2/3', weights)));

  test(`the ${CI_SHARDS} CI shards carry about the same weight (the heaviest within 15% of the lightest)`, () => {
    if (!Object.keys(weights).length) return; // no timings recorded yet
    const loads = shardLoads(names, CI_SHARDS, weights);
    expect(Math.max(...loads)).toBeLessThanOrEqual(Math.min(...loads) * 1.15);
  });

  test('weights name only tests that exist (a renamed or deleted test leaves a stale entry: run tests/e2e/weights.cjs)', () => {
    for (const name of Object.keys(weights)) expect(names).toContain(name);
  });

  test('one huge test gets a shard to itself when there are enough tests', () => {
    const w = { ...Object.fromEntries(names.map((x) => [x, 1])), [names[0]]: 1000 };
    const groups = [1, 2, 3].map((k) => shardItems(names, `${k}/3`, w));
    for (const g of groups) expect(g.length).toBeGreaterThan(0);
    expect(groups.find((g) => g.includes(names[0]))!).toEqual([names[0]]);
  });
});
