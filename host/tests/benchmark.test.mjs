import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const python = process.platform === 'win32' ? 'python' : 'python3';
for (const [name, url, args] of [
  ['offline synthetic benchmark smoke never establishes capacity', '../bench/bench.py', ['selftest']],
  ['benchmark capture, phase, topology and before/after evidence validation', 'benchmark_checks.py', []],
]) {
  test(name, () => {
    const result = spawnSync(python, ['-B', fileURLToPath(new URL(url, import.meta.url)), ...args], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (args.length) assert.deepEqual(JSON.parse(result.stdout), {
      selftest: 'passed', source: 'synthetic', capacityEvidence: false, liveRequests: 0,
    });
  });
}
