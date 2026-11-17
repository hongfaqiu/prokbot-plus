import { execFile, execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WIN_INTEGRITY_RE = /\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/g;

export function replaceWindowsAsarIntegrityHex(buffer, expected, replacement) {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(replacement)) {
    throw new Error('Invalid ASAR header hash format');
  }
  const text = buffer.toString('latin1');
  const matches = [...text.matchAll(WIN_INTEGRITY_RE)];
  if (matches.length !== 1) throw new Error('Embedded Windows ASAR integrity record not found');
  if (matches[0][1] !== expected) throw new Error('Embedded Windows ASAR integrity mismatch');
  const out = Buffer.from(buffer);
  const at = matches[0].index + matches[0][0].indexOf(expected);
  out.write(replacement, at, 64, 'latin1');
  return out;
}

export async function canApplyAsarUpdate({ resourcesDir, execPath }) {
  if (!resourcesDir || !execPath) return false;
  try {
    await access(resourcesDir, constants.W_OK);
  } catch {
    return false;
  }

  if (process.platform === 'win32') {
    try {
      await access(path.dirname(execPath), constants.W_OK);
      const exe = await readFile(execPath);
      const matches = [...exe.toString('latin1').matchAll(WIN_INTEGRITY_RE)];
      return matches.length === 1;
    } catch {
      return false;
    }
  }

  if (process.platform === 'darwin') {
    const appBundle = path.resolve(resourcesDir, '../..');
    if (!appBundle.endsWith('.app') || appBundle.startsWith('/Volumes/') || appBundle.includes('/AppTranslocation/')) {
      return false;
    }
    try {
      await access(path.dirname(appBundle), constants.W_OK);
      await access('/usr/bin/codesign', constants.X_OK);
      await access('/usr/bin/plutil', constants.X_OK);
      const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dv', appBundle], { encoding: 'utf8' });
      return /^Signature=adhoc$/m.test(stderr);
    } catch {
      return false;
    }
  }

  return false;
}

export async function applyAsarUpdateAndRestart({
  asarFile,
  headerSha256,
  baseHeaderSha256,
  version,
  resourcesDir,
  execPath,
  quitApp,
}) {
  const stageRoot = path.join(path.dirname(asarFile), `apply-${version}-${process.pid}`);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  if (process.platform === 'win32') {
    const stagedExe = path.join(stageRoot, path.basename(execPath));
    const stagedAsar = path.join(stageRoot, 'app.asar');
    const updatedExe = replaceWindowsAsarIntegrityHex(await readFile(execPath), baseHeaderSha256, headerSha256);
    await writeFile(stagedExe, updatedExe);
    await copyFile(asarFile, stagedAsar);

    const targetAsar = path.join(resourcesDir, 'app.asar');
    const cmdScript = path.join(stageRoot, 'apply-update.cmd');
    const esc = s => String(s).replace(/"/g, '');
    const bat = [
      '@echo off',
      'setlocal',
      `set "PID=${process.pid}"`,
      ':waitloop',
      'tasklist /FI "PID eq %PID%" 2>NUL | findstr /R /C:" %PID% " >NUL',
      'if not errorlevel 1 (',
      '  timeout /t 1 /nobreak >NUL',
      '  goto waitloop',
      ')',
      'timeout /t 1 /nobreak >NUL',
      `for /L %%i in (1,1,10) do (`,
      `  copy /Y "${esc(stagedAsar)}" "${esc(targetAsar)}" >NUL 2>&1 && copy /Y "${esc(stagedExe)}" "${esc(execPath)}" >NUL 2>&1 && goto copied`,
      '  timeout /t 1 /nobreak >NUL',
      ')',
      ':copied',
      `start "" "${esc(execPath)}"`,
      `rmdir /S /Q "${esc(stageRoot)}"`,
    ].join('\r\n');
    await writeFile(cmdScript, bat, 'utf8');
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmdScript}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.unref();
    quitApp();
    return;
  }

  if (process.platform === 'darwin') {
    const appBundle = path.resolve(resourcesDir, '../..');
    const stagedApp = path.join(stageRoot, path.basename(appBundle));
    const entitlementsPath = path.join(stageRoot, 'entitlements.plist');
    try {
      execFileSync('/usr/bin/ditto', [appBundle, stagedApp], { stdio: 'ignore' });
      await copyFile(asarFile, path.join(stagedApp, 'Contents/Resources/app.asar'));

      const infoPlistPath = path.join(stagedApp, 'Contents/Info.plist');
      const infoJson = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPlistPath], { encoding: 'utf8' }));
      infoJson.ElectronAsarIntegrity = {
        ...(infoJson.ElectronAsarIntegrity ?? {}),
        'Resources/app.asar': { algorithm: 'SHA256', hash: headerSha256 },
      };
      await writeFile(infoPlistPath, JSON.stringify(infoJson), 'utf8');
      execFileSync('/usr/bin/plutil', ['-convert', 'xml1', infoPlistPath], { stdio: 'ignore' });

      const entitlementsXml = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', appBundle], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      await writeFile(entitlementsPath, entitlementsXml, 'utf8');
      execFileSync('/usr/bin/codesign', [
        '--force', '--deep', '--sign', '-', '--options', 'runtime', '--timestamp=none',
        '--entitlements', entitlementsPath, stagedApp,
      ], { timeout: 120000, stdio: 'ignore' });
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], { timeout: 60000, stdio: 'ignore' });
    } catch (err) {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const backupApp = `${appBundle}.backup-${process.pid}`;
    const swapScript = path.join(stageRoot, 'apply-update.sh');
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const sh = [
      '#!/bin/sh',
      `PID=${process.pid}`,
      'while kill -0 "$PID" 2>/dev/null; do sleep 0.1; done',
      `APP=${q(appBundle)}`,
      `STAGED=${q(stagedApp)}`,
      `BACKUP=${q(backupApp)}`,
      `ROOT=${q(stageRoot)}`,
      'rm -rf "$BACKUP"',
      'if mv "$APP" "$BACKUP"; then',
      '  if mv "$STAGED" "$APP"; then',
      '    rm -rf "$BACKUP" "$ROOT"',
      '    open -n "$APP"',
      '  else',
      '    mv "$BACKUP" "$APP" 2>/dev/null || true',
      '    rm -rf "$ROOT"',
      '  fi',
      'else',
      '  rm -rf "$ROOT"',
      'fi',
    ].join('\n');
    await writeFile(swapScript, sh, { mode: 0o755 });
    const child = spawn('/bin/sh', [swapScript], { detached: true, stdio: 'ignore' });
    child.unref();
    quitApp();
    return;
  }

  await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  throw new Error(`ASAR incremental swap is unsupported on ${process.platform}`);
}
