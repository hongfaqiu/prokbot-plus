import { createPublicKey } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function validUpdateUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1') return null;
  return parsed.href.replace(/\/+$/, '');
}

export function normalizeEcPublicKey(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Update public key cannot be empty.');
  if (trimmed.includes('PRIVATE KEY')) {
    throw new Error('Update public key must be a public key, not a private key.');
  }
  let key;
  if (trimmed.includes('BEGIN PUBLIC KEY')) {
    key = createPublicKey(trimmed);
  } else {
    const normalizedBase64 = trimmed.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64) || normalizedBase64.length % 4 === 1) {
      throw new Error('Invalid base64 SPKI update public key.');
    }
    const der = Buffer.from(normalizedBase64, 'base64');
    if (!der.length || der.toString('base64').replace(/=+$/, '') !== normalizedBase64.replace(/=+$/, '')) {
      throw new Error('Invalid base64 SPKI update public key.');
    }
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Update public key must be an ECDSA P-256 (prime256v1) SPKI key.');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return { present: false, value: null };
  if (args.indexOf(name, index + 1) >= 0) {
    throw new Error(`${name} 不能重复提供。`);
  }
  const value = args[index + 1];
  if (value === undefined || value.trim() === '' || /^--[a-z]/i.test(value)) {
    throw new Error(`${name} 缺少参数值。`);
  }
  return { present: true, value };
}

export async function resolveDesktopUpdateConfig(args) {
  const urlFlag = flagValue(args, '--update-url');
  const keyFlag = flagValue(args, '--update-public-key');
  const keyFileFlag = flagValue(args, '--update-public-key-file');
  if (keyFlag.present && keyFileFlag.present) {
    throw new Error('--update-public-key 与 --update-public-key-file 不能同时提供。');
  }
  const hasKey = keyFlag.present || keyFileFlag.present;
  if (urlFlag.present !== hasKey) {
    throw new Error('--update-url 必须与 --update-public-key（或 --update-public-key-file）同时提供。');
  }
  if (!urlFlag.present) return null;

  const updateUrl = validUpdateUrl(urlFlag.value);
  if (!updateUrl) {
    throw new Error('--update-url 必须是有效的 HTTPS 地址（本地测试允许 127.0.0.1）。');
  }
  const parsedUrl = new URL(updateUrl);
  if (parsedUrl.search || parsedUrl.hash) {
    throw new Error('--update-url 不能包含查询参数或片段标识符。');
  }
  const keyInput = keyFlag.present
    ? keyFlag.value
    : await readFile(path.resolve(keyFileFlag.value), 'utf8');
  const updatePublicKey = normalizeEcPublicKey(keyInput);
  return { updateUrl, updatePublicKey };
}

const UPDATE_SETTINGS_ANCHOR =
  'function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:o.jsx(ie,{})}),t[0]=e):e=t[0],e}';
const UPDATE_SETTINGS_REPLACEMENT =
  'function GrokLocalUpdateSettings(){return fe().row({loading:o.jsx(ie,{}),empty:o.jsx(ie,{}),unavailable:o.jsx(ie,{}),value:t=>t?.delivery==="in-app"?o.jsx(GrokOriginalUpdateSettings,{}):o.jsx(ie,{})})}function re(){re.d=1588;return o.jsx(ue,{children:o.jsx(GrokLocalUpdateSettings,{})})}';

export async function patchDesktopUpdateSettingsUi(unpacked) {
  const assetsDir = path.join(unpacked, 'dist/renderer/assets');
  const entries = (await readdir(assetsDir)).filter(name => /^chunk-view-.*\.js$/.test(name)).sort();
  const candidates = [];
  for (const name of entries) {
    const filename = path.join(assetsDir, name);
    const content = await readFile(filename, 'utf8');
    if (content.includes('function GrokOriginalUpdateSettings(')) {
      candidates.push({ name, filename, content });
    }
  }
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? '未找到受支持的更新设置模块，无法恢复桌面自动更新界面。'
      : '存在多个更新设置模块，无法确定桌面自动更新界面目标。');
  }
  const { name, filename, content } = candidates[0];
  if (content.includes('function GrokLocalUpdateSettings(')) {
    throw new Error(`更新设置模块已被修改：${name}`);
  }
  if (!content.includes('fe()') || !content.includes('function ie(')) {
    throw new Error(`更新设置模块缺少必需符号：${name}`);
  }
  const at = content.indexOf(UPDATE_SETTINGS_ANCHOR);
  if (at < 0) {
    throw new Error(`更新设置模块缺少预期锚点：${name}`);
  }
  if (content.indexOf(UPDATE_SETTINGS_ANCHOR, at + 1) >= 0) {
    throw new Error(`更新设置模块锚点不唯一：${name}`);
  }
  const updated = content.slice(0, at) + UPDATE_SETTINGS_REPLACEMENT + content.slice(at + UPDATE_SETTINGS_ANCHOR.length);
  await writeFile(filename, updated, 'utf8');
  return { file: `dist/renderer/assets/${name}` };
}
