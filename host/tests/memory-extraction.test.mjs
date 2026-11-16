import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function child(mode, policy, seed) {
  const fixture = new URL('./memory-extraction-fixture.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [`--unhandled-rejections=${policy}`, '--input-type=module', '-e',
    'const fixture = await import(process.argv[1]); await fixture.run(...process.argv.slice(2));', fixture.href, mode, seed],
    { encoding: 'utf8', timeout: 15_000, env: { ...process.env, SAND_DISABLE_ANALYTICS: '1', SAND_DISABLE_TELEMETRY: '1' } });
  assert.ifError(result.error);
  return result;
}

const sources = new Map([['portable', '']]);
if (process.env.PROKBOT_TEST_HOST_SEED) sources.set('generated Host', process.env.PROKBOT_TEST_HOST_SEED);
for (const [source, seed] of sources) {
  test(`${source}: a post-turn memory reset is reported once and the same child saves the next memory`, () => {
    const result = child('recover', 'strict', seed);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /next memory saved; foreground and evidence errors preserved/);
    assert.equal(result.stderr.match(/\[memory\]/g)?.length, 1, result.stderr);
    assert.match(result.stderr, /ECONNRESET/);
    assert.doesNotMatch(result.stderr, /private provider detail|incomplete fact/);
  });

  test(`${source}: an unrelated unhandled rejection during memory extraction is still fatal`, () => {
    const result = child('unrelated', 'throw', seed);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Error: unrelated rejection during memory extraction/);
    assert.doesNotMatch(result.stdout, /next memory saved/);
  });
}
