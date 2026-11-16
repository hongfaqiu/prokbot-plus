import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));

// supported.json and recipes/ beside this file follow the Windows release the patcher builds.
// An older release that the Android client still takes its interface from keeps its pins and
// recipes in a directory named after that version.
export async function windowsInputs(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Windows version: ${version}`);
  const current = await readJson(path.join(desktop, 'supported.json'));
  const directory = current.version === version ? desktop : path.join(desktop, version);
  const supported = directory === desktop ? current : await readJson(path.join(directory, 'supported.json')).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`No Windows ${version} inputs under windows/patchers/desktop.`);
    throw error;
  });
  if (supported.version !== version) throw new Error(`Windows inputs in ${directory} are for ${supported.version}, not ${version}.`);
  return { directory, supported };
}
