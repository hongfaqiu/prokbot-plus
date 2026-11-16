import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const VERSION = /^\d+\.\d+\.\d+$/;
const newestFirst = (a, b) => b.supported.version.localeCompare(a.supported.version, 'en', { numeric: true });

// supported.json and recipes/ beside this file follow the recommended Windows release. Older
// releases that still build (the fallback for Windows, the Android interface) keep their pins
// and recipes in a directory named after their version.
export async function windowsInputs(version, root = desktop) {
  if (!VERSION.test(version)) throw new Error(`Invalid Windows version: ${version}`);
  const current = await readJson(path.join(root, 'supported.json'));
  const directory = current.version === version ? root : path.join(root, version);
  const supported = directory === root ? current : await readJson(path.join(directory, 'supported.json')).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`No Windows ${version} inputs under windows/patchers/desktop.`);
    throw error;
  });
  if (supported.version !== version) throw new Error(`Windows inputs in ${directory} are for ${supported.version}, not ${version}.`);
  return { directory, supported };
}

/** Every Windows release with pins and recipes, the recommended one first. */
export async function windowsReleases(root = desktop) {
  const current = await windowsInputs((await readJson(path.join(root, 'supported.json'))).version, root);
  const older = [];
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && VERSION.test(entry.name)) older.push(await windowsInputs(entry.name, root));
  return [current, ...older.sort(newestFirst)];
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The release an explicit source belongs to: a whole official installer, its app-64.7z or an
 * installed directory, recognised only by the pinned size and SHA-256. Anything else gets the
 * first candidate, whose own verification then rejects it.
 */
export async function windowsReleaseFor(source, candidates) {
  if (!candidates.length) throw new Error('No Windows releases to choose from.');
  if (!source) return candidates[0];
  const info = await stat(source);
  if (info.isDirectory()) {
    const asar = path.join(source, 'resources/app.asar');
    const digest = await sha256(asar).catch(() => null);
    return candidates.find(({ supported }) => supported.asarSha256 === digest) ?? candidates[0];
  }
  const pins = candidates.flatMap(release => [release.supported.archive, release.supported.payload]
    .filter(pin => pin?.bytes === info.size).map(pin => ({ release, pin })));
  if (!pins.length) return candidates[0];
  const digest = await sha256(source);
  return pins.find(({ pin }) => pin.sha256 === digest)?.release ?? candidates[0];
}

/** Picks the release for --version, or for the given source, among the releases a patcher builds. */
export async function selectWindowsRelease({ source, version, accepted } = {}) {
  const releases = (await windowsReleases()).filter(({ supported }) => !accepted || accepted.includes(supported.version));
  if (version) {
    const release = releases.find(({ supported }) => supported.version === version);
    if (!release) throw new Error(`不支持 Grok Bot ${version}。可用版本：${releases.map(({ supported }) => supported.version).join('、')}。`);
    return release;
  }
  return windowsReleaseFor(source && path.resolve(source), releases);
}
