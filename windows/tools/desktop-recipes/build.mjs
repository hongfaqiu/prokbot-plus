#!/usr/bin/env node
// Maintainer tool: regenerate the Windows desktop recipes from the official installer and
// the anchored edits in spec.mjs. Every anchor must occur exactly once in its source;
// unchanged original bytes become copy ranges, so a recipe adds only this project's code.
//
//   node windows/tools/desktop-recipes/build.mjs [--source <Grok_Bot_<version>_Setup.exe | app-64.7z | 安装目录>] [--check]
//
// Without --source the pinned installer is downloaded and verified like patch.mjs does.
// --check rebuilds in memory and fails unless the committed recipes are byte-identical.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync, constants } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { acquireDesktopSource } from '../../../mac/patchers/desktop/download-original.mjs';
import { applyByteRecipe } from '../../../mac/patchers/desktop/release-recipes.mjs';
import { unpackOriginal } from '../../patchers/desktop/original.mjs';
import { SPEC } from './spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const windowsRoot = path.resolve(here, '../..');
const repo = path.resolve(windowsRoot, '..');
const desktop = path.join(windowsRoot, 'patchers/desktop');
const recipes = path.join(desktop, 'recipes');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function unique(source, anchor, label) {
  const needle = Buffer.from(anchor, 'utf8');
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`${label}: anchor not found: ${anchor.slice(0, 120)}`);
  if (source.indexOf(needle, at + 1) >= 0) throw new Error(`${label}: anchor not unique: ${anchor.slice(0, 120)}`);
  return { at, end: at + needle.length };
}

// A replacement keeps the original bytes it shares with the anchor at either end.
function trimmed(source, at, end, text) {
  const before = source.subarray(at, end), after = Buffer.from(text, 'utf8');
  let head = 0, tail = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  while (tail < before.length - head && tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return [at + head, end - tail, after.subarray(head, after.length - tail)];
}

/** Turn one spec entry into a grokbot-bytepatch/v1 recipe over its pinned source. */
export function buildRecipe(entry, source) {
  const label = entry.path, changes = [];
  for (const edit of entry.edits) {
    if ('replaceAll' in edit) changes.push([0, source.length, Buffer.from(edit.replaceAll)]);
    else if ('prepend' in edit) changes.push([0, 0, Buffer.from(edit.prepend)]);
    else if ('append' in edit) changes.push([source.length, source.length, Buffer.from(edit.append)]);
    else if ('cutFrom' in edit) { const { at } = unique(source, edit.cutFrom, label); changes.push([at, source.length, Buffer.from(edit.text ?? '')]); }
    else if ('insertAfter' in edit) { const { end } = unique(source, edit.insertAfter, label); changes.push([end, end, Buffer.from(edit.text)]); }
    else if ('insertBefore' in edit) { const { at } = unique(source, edit.insertBefore, label); changes.push([at, at, Buffer.from(edit.text)]); }
    else if ('replace' in edit) { const { at, end } = unique(source, edit.replace, label); changes.push(trimmed(source, at, end, edit.text)); }
    else if ('removeThrough' in edit) {
      const from = unique(source, edit.removeThrough[0], label), to = unique(source, edit.removeThrough[1], label);
      changes.push([from.at, to.end, Buffer.from(edit.text ?? '')]);
    } else throw new Error(`${label}: unknown edit`);
  }
  // Edits at one offset keep their spec order (for example two insertions at the start).
  changes.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (let i = 1; i < changes.length; i++) if (changes[i][0] < changes[i - 1][1]) throw new Error(`${label}: overlapping edits`);
  const ops = []; let cursor = 0, added = 0;
  const copy = (from, to) => {
    if (to <= from) return;
    const last = ops.at(-1);
    if (last?.[0] === 'copy' && last[1] + last[2] === from) last[2] += to - from; else ops.push(['copy', from, to - from]);
  };
  const add = bytes => {
    if (!bytes.length) return;
    added += bytes.length;
    const last = ops.at(-1);
    if (last?.[0] === 'add') last[1] = Buffer.concat([Buffer.from(last[1], 'base64'), bytes]).toString('base64');
    else ops.push(['add', bytes.toString('base64')]);
  };
  for (const [start, end, bytes] of changes) { copy(cursor, start); add(bytes); cursor = Math.max(cursor, end); }
  copy(cursor, source.length);
  const target = Buffer.concat(ops.map(op => op[0] === 'copy' ? source.subarray(op[1], op[1] + op[2]) : Buffer.from(op[1], 'base64')));
  const recipe = { schema: 'grokbot-bytepatch/v1', sourceBytes: source.length, sourceSha256: sha(source),
    targetBytes: target.length, targetSha256: sha(target), ops };
  if (!applyByteRecipe(source, recipe).equals(target)) throw new Error(`${label}: recipe does not replay`);
  return { recipe, target, added };
}

/** Build every recipe file and the manifest from an extracted original app.asar. */
export async function buildRecipes(unpacked) {
  const files = new Map(), entries = [];
  const sorted = [...SPEC].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const [index, entry] of sorted.entries()) {
    const source = entry.source === null ? Buffer.alloc(0) : await readFile(path.join(unpacked, entry.source));
    const { recipe, target, added } = buildRecipe(entry, source);
    const name = `${String(index).padStart(3, '0')}.gbp.gz`;
    const compressed = gzipSync(JSON.stringify(recipe), { level: constants.Z_BEST_COMPRESSION });
    files.set(name, compressed);
    entries.push({ path: entry.path, source: entry.source, newFile: entry.source !== entry.path, recipe: name,
      sha256: sha(compressed), targetBytes: target.length, addedBytes: added });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify({ schema: 'grokbot-desktop-recipes/v1', files: entries }, null, 2) + '\n'));
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const supported = JSON.parse(await readFile(path.join(desktop, 'supported.json'), 'utf8'));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grokbot-desktop-recipes-'));
  try {
    const source = await acquireDesktopSource({ source: arg('--source'), cacheDirectory: path.join(windowsRoot, '.cache'), supported,
      onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} Windows x64…`) });
    const app = await unpackOriginal(source, temporary, supported);
    const asarFile = path.join(app, 'resources/app.asar');
    if (sha(await readFile(asarFile)) !== supported.asarSha256) throw new Error(`Not the pinned Grok Bot ${supported.version} app.asar`);
    const asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar');
    const unpacked = path.join(temporary, 'app');
    asar.extractAll(asarFile, unpacked);
    const files = await buildRecipes(unpacked);
    if (args.includes('--check')) {
      const committed = (await readdir(recipes)).sort();
      const stale = [...files.keys()].filter(name => !committed.includes(name)).concat(committed.filter(name => !files.has(name)));
      for (const [name, bytes] of files) if (committed.includes(name) && !bytes.equals(await readFile(path.join(recipes, name)))) stale.push(name);
      if (stale.length) throw new Error(`Committed recipes differ from spec.mjs: ${stale.join(', ')}`);
    } else {
      for (const name of await readdir(recipes)) if (/^\d{3}\.gbp\.gz$|^manifest\.json$/.test(name)) await rm(path.join(recipes, name));
      for (const [name, bytes] of files) await writeFile(path.join(recipes, name), bytes);
    }
    console.log(JSON.stringify({ version: supported.version, recipes: files.size - 1, checked: args.includes('--check') }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
