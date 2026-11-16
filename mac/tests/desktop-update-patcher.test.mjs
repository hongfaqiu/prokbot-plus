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
import vm from 'node:vm';
import {
  normalizeEcPublicKey as updaterNormalizeEcPublicKey,
  validUpdateUrl as updaterValidUpdateUrl,
} from '../clients/desktop/updater.mjs';
import {
  normalizeEcPublicKey,
  patchDesktopUpdateSettingsUi,
  resolveDesktopUpdateConfig,
  validUpdateUrl,
} from '../patchers/desktop/update-config.mjs';

const execFileAsync = promisify(execFile);
const macPatchCli = fileURLToPath(new URL('../patchers/desktop/patch.mjs', import.meta.url));
const cachedMac0712 = fileURLToPath(new URL('../.cache/Grok_Bot_0.71.2.dmg', import.meta.url));

function p256Pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    pem: publicKey.export({ format: 'pem', type: 'spki' }),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    spkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

test('desktop patcher update URL and ECDSA P-256 key validation match updater.mjs and support --update-public-key-file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-update-cfg-'));
  try {
    const { pem, privatePem, spkiBase64 } = p256Pair();
    const pemFile = path.join(dir, 'update-key.pem');
    const b64File = path.join(dir, 'update-key.b64');
    await writeFile(pemFile, pem, 'utf8');
    await writeFile(b64File, `  ${spkiBase64}\n`, 'utf8');

    assert.equal(await resolveDesktopUpdateConfig([]), null);

    const fromInline = await resolveDesktopUpdateConfig([
      '--update-url', 'https://updates.example.com/desktop///',
      '--update-public-key', spkiBase64,
    ]);
    assert.deepEqual(fromInline, {
      updateUrl: 'https://updates.example.com/desktop',
      updatePublicKey: spkiBase64,
    });

    const fromInlinePem = await resolveDesktopUpdateConfig([
      '--update-url', 'https://updates.example.com/desktop',
      '--update-public-key', pem,
    ]);
    assert.deepEqual(fromInlinePem, {
      updateUrl: 'https://updates.example.com/desktop',
      updatePublicKey: spkiBase64,
    });

    const fromPemFile = await resolveDesktopUpdateConfig([
      '--update-url', 'http://127.0.0.1:8443/',
      '--update-public-key-file', pemFile,
    ]);
    assert.deepEqual(fromPemFile, {
      updateUrl: 'http://127.0.0.1:8443',
      updatePublicKey: spkiBase64,
    });

    const fromB64File = await resolveDesktopUpdateConfig([
      '--update-url', 'https://updates.example.com',
      '--update-public-key-file', b64File,
    ]);
    assert.equal(fromB64File.updatePublicKey, spkiBase64);

    for (const candidate of [
      'https://updates.example.com/feed/',
      'http://127.0.0.1:9000/',
      'http://example.com/feed',
      'https://user:pass@updates.example.com/feed',
      'ftp://updates.example.com/feed',
      'not-a-url',
      '',
    ]) {
      assert.equal(validUpdateUrl(candidate), updaterValidUpdateUrl(candidate), candidate);
    }
    assert.equal(normalizeEcPublicKey(pem), updaterNormalizeEcPublicKey(pem));

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' });
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const badArgs of [
      ['--update-url', 'https://updates.example.com'],
      ['--update-public-key', spkiBase64],
      ['--update-public-key-file', pemFile],
      ['--update-url', 'https://updates.example.com', '--update-public-key', spkiBase64, '--update-public-key-file', pemFile],
      ['--update-url', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com', '--update-public-key'],
      ['--update-url', 'https://updates.example.com', '--update-public-key', '   '],
      ['--update-url', 'https://updates.example.com', '--update-url', 'https://other.example', '--update-public-key', spkiBase64],
      ['--update-url', 'http://updates.example.com', '--update-public-key', spkiBase64],
      ['--update-url', 'https://user:pw@updates.example.com', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com/feed?token=1', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com/feed#frag', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com', '--update-public-key', 'not-base64!!!'],
      ['--update-url', 'https://updates.example.com', '--update-public-key', `${spkiBase64}===`],
      ['--update-url', 'https://updates.example.com', '--update-public-key', privatePem],
      ['--update-url', 'https://updates.example.com', '--update-public-key', `${privatePem}\n${pem}`],
      ['--update-url', 'https://updates.example.com', '--update-public-key', rsa],
      ['--update-url', 'https://updates.example.com', '--update-public-key', p384],
      ['--update-url', 'https://updates.example.com', '--update-public-key-file', path.join(dir, 'missing.pem')],
    ]) {
      await assert.rejects(resolveDesktopUpdateConfig(badArgs));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('patchDesktopUpdateSettingsUi restores GrokOriginalUpdateSettings only when delivery === "in-app" and fails closed on drift', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-update-ui-'));
  try {
    const assetsDir = path.join(dir, 'dist/renderer/assets');
    await mkdir(assetsDir, { recursive: true });
    const chunkPath = path.join(assetsDir, 'chunk-view-FIXTURE.js');
    const fixture = [
      'function GrokOriginalUpdateSettings(){ie.d=1731;return o.jsx(Se,{title:"Updates",children:fe().row({value:Me})});}',
      'function Me(t){return o.jsx(ae,{status:t});}',
      'function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:o.jsx(ie,{})}),t[0]=e):e=t[0],e}',
      'function ie(){return o.jsx(Se,{children:"0.71.2 Local"});}',
    ].join('\n');
    await writeFile(chunkPath, fixture, 'utf8');

    const result = await patchDesktopUpdateSettingsUi(dir);
    assert.equal(result.file, 'dist/renderer/assets/chunk-view-FIXTURE.js');
    const patched = await readFile(chunkPath, 'utf8');

    // Evaluate patched component behavior across loading, package-manager, and in-app delivery states.
    const renderTree = node => {
      if (node == null || typeof node !== 'object' || !('type' in node)) return node;
      if (typeof node.type === 'function') return renderTree(node.type(node.props ?? {}));
      if (Array.isArray(node.props?.children)) return { ...node, children: node.props.children.map(renderTree) };
      return { tag: node.type, children: renderTree(node.props?.children) };
    };
    let currentRow = { kind: 'loading' };
    const context = vm.createContext({
      Symbol,
      o: { jsx: (type, props) => ({ type, props }) },
      M: { c: () => [] },
      Se: ({ title, children }) => ({ tag: 'Se', title, children: renderTree(children) }),
      ue: ({ children }) => ({ tag: 'ue', children: renderTree(children) }),
      ae: ({ status }) => ({ tag: 'ae', delivery: status.delivery }),
      fe: () => ({
        row: opts => {
          if (currentRow.kind === 'loading') return renderTree(opts.loading);
          if (currentRow.kind === 'empty') return renderTree(opts.empty);
          if (currentRow.kind === 'unavailable') return renderTree(opts.unavailable);
          return renderTree(opts.value(currentRow.status, 'ready'));
        },
      }),
    });
    vm.runInContext(`${patched}\nthis.re = re;`, context);

    currentRow = { kind: 'loading' };
    assert.equal(renderTree(context.re()).children.children, '0.71.2 Local');

    currentRow = { kind: 'ready', status: { delivery: 'package-manager', state: { type: 'disabled' } } };
    assert.equal(renderTree(context.re()).children.children, '0.71.2 Local');

    currentRow = { kind: 'ready', status: { delivery: 'in-app', state: { type: 'idle' } } };
    const inAppTree = renderTree(context.re());
    assert.equal(inAppTree.children.title, 'Updates');
    assert.equal(inAppTree.children.children.delivery, 'in-app');

    // Re-applying fails closed.
    await assert.rejects(patchDesktopUpdateSettingsUi(dir), /已被修改/);

    // Missing anchor fails closed.
    await writeFile(chunkPath, 'function GrokOriginalUpdateSettings(){} function ie(){} fe();', 'utf8');
    await assert.rejects(patchDesktopUpdateSettingsUi(dir), /缺少预期锚点/);

    // Duplicate candidates fail closed.
    await writeFile(chunkPath, fixture, 'utf8');
    await writeFile(path.join(assetsDir, 'chunk-view-DUP.js'), fixture, 'utf8');
    await assert.rejects(patchDesktopUpdateSettingsUi(dir), /存在多个更新设置模块/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('macOS patch CLI documents update flags in --help and rejects malformed update arguments before build', async () => {
  const { stdout } = await execFileAsync(process.execPath, [macPatchCli, '--help']);
  assert.match(stdout, /--update-url/);
  assert.match(stdout, /--update-public-key/);
  assert.match(stdout, /--update-public-key-file/);

  const { pem, spkiBase64 } = p256Pair();
  await assert.rejects(
    execFileAsync(process.execPath, [macPatchCli, '--update-url', 'http://insecure.example/updates', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /HTTPS/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [macPatchCli, '--update-url', 'https://updates.example/feed?x=1', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /查询参数/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [macPatchCli, '--update-url', 'https://updates.example/']),
    err => err.code === 1 && /--update-public-key/.test(err.stderr),
  );
});

test('macOS patcher --verify-only verifies cached 0.71.2 DMG recipes and update UI patch', { skip: process.platform !== 'darwin' || !existsSync(cachedMac0712) }, async () => {
  const { pem } = p256Pair();
  const { stdout } = await execFileAsync(process.execPath, [
    macPatchCli,
    '--source', cachedMac0712,
    '--update-url', 'https://updates.example.com/desktop',
    '--update-public-key', pem,
    '--verify-only',
  ]);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.verified, true);
  assert.equal(parsed.recipesVerified, true);
  assert.equal(parsed.version, '0.71.2');
});
