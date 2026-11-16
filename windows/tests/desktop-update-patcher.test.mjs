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
const win0712RecipesDir = fileURLToPath(new URL('../patchers/desktop/0.71.2/recipes', import.meta.url));
const cachedWin110 = fileURLToPath(new URL('../.cache/Grok_Bot_1.1.0_Setup.exe', import.meta.url));

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

test('Windows 0.71.2 recipe 009 preserves Android pinned target hash while patchDesktopUpdateSettingsUi supports both 0.71.2 and 1.1.0', async () => {
  const recipe = JSON.parse(gunzipSync(await readFile(path.join(win0712RecipesDir, '009.gbp.gz'))).toString('utf8'));
  assert.equal(recipe.targetSha256, 'a5423ee6ba0b931a43e8e1d59c36f669ddf8b787242e5080193ef46562cc44e5');

  const dir0712 = await mkdtemp(path.join(os.tmpdir(), 'grokbot-win-ui-0712-'));
  const dir110 = await mkdtemp(path.join(os.tmpdir(), 'grokbot-win-ui-110-'));
  try {
    const assets0712 = path.join(dir0712, 'dist/renderer/assets');
    await mkdir(assets0712, { recursive: true });
    const chunk0712 = path.join(assets0712, 'chunk-view-BZxQ9Ylk.js');
    await writeFile(chunk0712, [
      'function GrokOriginalUpdateSettings(){ie.d=1731;return o.jsx(Se,{title:"Updates",children:fe().row({value:Me})});}',
      'function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:o.jsx(ie,{})}),t[0]=e):e=t[0],e}',
      'function ie(){return o.jsx(Se,{children:"0.71.2"});}',
    ].join('\n'), 'utf8');
    const patched0712 = await patchDesktopUpdateSettingsUi(dir0712);
    assert.equal(patched0712.file, 'dist/renderer/assets/chunk-view-BZxQ9Ylk.js');
    const updated0712 = await readFile(chunk0712, 'utf8');
    assert.match(updated0712, /function GrokLocalUpdateSettings\(\)/);
    assert.match(updated0712, /t\?\.delivery==="in-app"\?o\.jsx\(GrokOriginalUpdateSettings,\{\}\):o\.jsx\(ie,\{\}\)/);

    const assets110 = path.join(dir110, 'dist/renderer/assets');
    await mkdir(assets110, { recursive: true });
    const chunk110 = path.join(assets110, 'chunk-view-D18ZK0A2.js');
    await writeFile(chunk110, [
      'function E(){E.d=3008;const t=d();return (0,S.jsx)(g,{children:t.row({value:D})});}',
      'function O(){O.d=2763;let e=(0,y.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,S.jsx)(v,{children:(0,S.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
      'function GrokLocalVersion(){return (0,S.jsx)(g,{children:"1.1.0"});}',
    ].join('\n'), 'utf8');
    const patched110 = await patchDesktopUpdateSettingsUi(dir110);
    assert.equal(patched110.file, 'dist/renderer/assets/chunk-view-D18ZK0A2.js');
    const updated110 = await readFile(chunk110, 'utf8');
    assert.match(updated110, /function GrokLocalUpdateSettings\(\)/);
    assert.match(updated110, /t\?\.delivery==="in-app"\?\(0,S\.jsx\)\(E,\{\}\):\(0,S\.jsx\)\(GrokLocalVersion,\{\}\)/);
  } finally {
    await rm(dir0712, { recursive: true, force: true });
    await rm(dir110, { recursive: true, force: true });
  }
});

test('Windows patcher --verify-only verifies cached 1.1.0 installer recipes and update UI patch', { skip: !existsSync(cachedWin110) }, async () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  const { stdout } = await execFileAsync(process.execPath, [
    winPatchCli,
    '--source', cachedWin110,
    '--update-url', 'https://updates.example.com/desktop',
    '--update-public-key', pem,
    '--verify-only',
  ]);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.verified, true);
  assert.equal(parsed.recipesVerified, true);
  assert.equal(parsed.version, '1.1.0');
});
