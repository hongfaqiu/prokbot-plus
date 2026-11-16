import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  patchDesktopUpdateSettingsUi,
  resolveDesktopUpdateConfig,
} from '../../mac/patchers/desktop/update-config.mjs';

const execFileAsync = promisify(execFile);
const winPatchCli = fileURLToPath(new URL('../patchers/desktop/patch.mjs', import.meta.url));
const winRecipesDir = fileURLToPath(new URL('../patchers/desktop/recipes', import.meta.url));
const cachedWin0712 = [
  fileURLToPath(new URL('../.cache/Grok_Bot_0.71.2_Setup.exe', import.meta.url)),
  fileURLToPath(new URL('../../android/.cache/Grok_Bot_0.71.2_Setup.exe', import.meta.url)),
].find(candidate => existsSync(candidate));

test('Windows patch CLI documents update flags in --help and validates update flags before platform build checks', async () => {
  const { stdout } = await execFileAsync(process.execPath, [winPatchCli, '--help']);
  assert.match(stdout, /--update-url/);
  assert.match(stdout, /--update-public-key/);
  assert.match(stdout, /--update-public-key-file/);

  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  const spkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  const resolvedPem = await resolveDesktopUpdateConfig([
    '--update-url', 'https://updates.example/desktop///',
    '--update-public-key', pem,
  ]);
  assert.deepEqual(resolvedPem, {
    updateUrl: 'https://updates.example/desktop',
    updatePublicKey: spkiBase64,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/']),
    err => err.code === 1 && /--update-public-key/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'http://insecure.example/feed', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /HTTPS/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/feed?x=1', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /查询参数/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/', '--update-public-key', 'bad-key']),
    err => err.code === 1 && /public key/i.test(err.stderr),
  );
  if (process.platform !== 'win32') {
    await assert.rejects(
      execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/', '--update-public-key', pem]),
      err => err.code === 1 && /Windows 客户端需要在 Windows 上生成/.test(err.stderr),
    );
  }
});

test('Windows recipe 009 preserves Android pinned target hash while patchDesktopUpdateSettingsUi patches Windows chunk-view', async () => {
  const recipe = JSON.parse(gunzipSync(await readFile(path.join(winRecipesDir, '009.gbp.gz'))).toString('utf8'));
  assert.equal(recipe.targetSha256, 'a5423ee6ba0b931a43e8e1d59c36f669ddf8b787242e5080193ef46562cc44e5');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-win-ui-'));
  try {
    const assetsDir = path.join(dir, 'dist/renderer/assets');
    await mkdir(assetsDir, { recursive: true });
    const chunkPath = path.join(assetsDir, 'chunk-view-BZxQ9Ylk.js');
    await writeFile(chunkPath, [
      'function GrokOriginalUpdateSettings(){ie.d=1731;return o.jsx(Se,{title:"Updates",children:fe().row({value:Me})});}',
      'function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:o.jsx(ie,{})}),t[0]=e):e=t[0],e}',
      'function ie(){return o.jsx(Se,{children:"0.71.2"});}',
    ].join('\n'), 'utf8');
    const patched = await patchDesktopUpdateSettingsUi(dir);
    assert.equal(patched.file, 'dist/renderer/assets/chunk-view-BZxQ9Ylk.js');
    const updated = await readFile(chunkPath, 'utf8');
    assert.match(updated, /function GrokLocalUpdateSettings\(\)/);
    assert.match(updated, /t\?\.delivery==="in-app"\?o\.jsx\(GrokOriginalUpdateSettings,\{\}\):o\.jsx\(ie,\{\}\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows patcher --verify-only verifies cached 0.71.2 installer recipes and update UI patch', { skip: !cachedWin0712 }, async () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  const { stdout } = await execFileAsync(process.execPath, [
    winPatchCli,
    '--source', cachedWin0712,
    '--update-url', 'https://updates.example.com/desktop',
    '--update-public-key', pem,
    '--verify-only',
  ]);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.verified, true);
  assert.equal(parsed.recipesVerified, true);
  assert.equal(parsed.version, '0.71.2');
});
