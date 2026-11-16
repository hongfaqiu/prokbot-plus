import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('whole-guest evidence rejects diagnostic topology, inconsistent swap and unmatched workloads', () => {
  const script = fileURLToPath(new URL('./benchmark-evidence.py', import.meta.url));
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', '-S', script], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
