// The e2e shards (E2E_SHARD=k/n, tests/e2e/lib/shard.cjs) must run every test file exactly once between them, and split
// the work about evenly, or a CI job would silently skip tests or finish long after the others.

import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { shardFiles, shardLoads } = require('./e2e/lib/shard.cjs') as {
  shardFiles: (files: string[], spec: string, weights?: Record<string, number>) => string[];
  shardLoads: (files: string[], n: number, weights?: Record<string, number>) => number[];
};

const dir = new URL('./e2e/', import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith('.e2e.cjs')).sort();
const weightsPath = `${dir}shard-weights.json`;
const weights: Record<string, number> = existsSync(weightsPath) ? JSON.parse(readFileSync(weightsPath, 'utf8')) : {};

describe('e2e sharding', () => {
  for (const n of [1, 2, 3, 4]) {
    test(`${n} shard(s): disjoint, and together every test file`, () => {
      const groups = Array.from({ length: n }, (_, i) => shardFiles(files, `${i + 1}/${n}`, weights));
      const all = groups.flat();
      expect(all.length).toBe(files.length);
      expect([...new Set(all)].sort()).toEqual(files);
    });
  }

  test('an empty spec runs everything', () => expect(shardFiles(files, '', weights)).toEqual(files));

  test('a bad spec is refused', () => {
    for (const bad of ['3', '0/3', '4/3', 'a/b', '1/0']) expect(() => shardFiles(files, bad, weights)).toThrow();
  });

  test('the split is deterministic', () => expect(shardFiles(files, '2/3', weights)).toEqual(shardFiles(files, '2/3', weights)));

  test('three shards carry about the same weight (the heaviest within 40% of the lightest)', () => {
    if (!Object.keys(weights).length) return; // no timings recorded yet
    const loads = shardLoads(files, 3, weights);
    expect(Math.max(...loads)).toBeLessThanOrEqual(Math.min(...loads) * 1.4);
  });

  test('weights name only test files that exist (a renamed or deleted file leaves a stale entry)', () => {
    for (const f of Object.keys(weights)) expect(files).toContain(f);
  });

  test('one huge file does not make an empty shard when there are enough files', () => {
    const w = { ...Object.fromEntries(files.map((f) => [f, 1])), [files[0]]: 1000 };
    const groups = [1, 2, 3].map((k) => shardFiles(files, `${k}/3`, w));
    for (const g of groups) expect(g.length).toBeGreaterThan(0);
    expect(groups.find((g) => g.includes(files[0]))!.length).toBe(1);
  });
});
