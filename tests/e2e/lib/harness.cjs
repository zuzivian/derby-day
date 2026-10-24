// Minimal test harness: test(name, fn), expect(value), no dependencies.
// Test files call test(); run.cjs collects the registry and runs it sequentially.

const registry = [];

function test(name, fn) {
  registry.push({ name, fn });
}

class AssertionError extends Error {}

function show(v) {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  } catch {
    return String(v);
  }
}

function expect(actual, label) {
  const fail = (msg) => {
    throw new AssertionError(`${label ? label + ': ' : ''}${msg}`);
  };
  return {
    toBe: (e) => Object.is(actual, e) || fail(`expected ${show(e)}, got ${show(actual)}`),
    toEqual: (e) => show(actual) === show(e) || fail(`expected ${show(e)}, got ${show(actual)}`),
    toBeTruthy: () => !!actual || fail(`expected a truthy value, got ${show(actual)}`),
    toBeFalsy: () => !actual || fail(`expected a falsy value, got ${show(actual)}`),
    toBeGreaterThan: (e) => actual > e || fail(`expected ${show(actual)} > ${show(e)}`),
    toBeGreaterThanOrEqual: (e) => actual >= e || fail(`expected ${show(actual)} >= ${show(e)}`),
    toBeLessThan: (e) => actual < e || fail(`expected ${show(actual)} < ${show(e)}`),
    toBeLessThanOrEqual: (e) => actual <= e || fail(`expected ${show(actual)} <= ${show(e)}`),
    toMatch: (re) => re.test(String(actual)) || fail(`expected ${show(actual)} to match ${re}`),
    toContain: (e) => (actual && actual.includes(e)) || fail(`expected ${show(actual)} to contain ${show(e)}`),
    notToBe: (e) => !Object.is(actual, e) || fail(`expected value not to be ${show(e)}`),
    notToContain: (e) => !(actual && actual.includes(e)) || fail(`expected ${show(actual)} not to contain ${show(e)}`),
  };
}

module.exports = { test, expect, registry, AssertionError };
