import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('pinned Host patches reuse immutable inputs and verify every output', () => {
  const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [fileURLToPath(new URL('bytepatch_checks.py', import.meta.url))], { encoding: 'utf8' });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
