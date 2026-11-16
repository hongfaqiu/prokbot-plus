// Render only the marked portions of each README. An official feed does not change any build pin.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const json = async file => JSON.parse(await readFile(new URL(file, root), 'utf8'));
const version = /^\d+\.\d+\.\d+$/;
const official = {
  win: 'https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand',
  mac: 'https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand',
  ios: 'https://apps.apple.com/us/app/grok-bot/id6794501026',
};

export async function readVersions() {
  const [snap, win, mac, ios, android, host, checkedWindows] = await Promise.all(['ci/official-snapshot.json',
    'windows/patchers/desktop/supported.json', 'mac/patchers/desktop/supported.json', 'ios/recipes/ios/manifest.json',
    'android/patchers/supported.json', 'host/recipes/host/manifest.json', 'windows/patchers/desktop/known-unsupported.json'].map(json));
  assert.match(snap.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(snap.ios.trackId, 6794501026); assert.equal(snap.ios.store, 'us');
  for (const channel of [snap.windows, snap.mac]) assert.match(channel.build, /^[a-f0-9]{40}$/);
  for (const v of [snap.windows.version, snap.mac.version, snap.ios.version, win.version, mac.version, ios.version,
    android.desktopVersion, android.shell.versionName]) assert.match(v, version);
  assert.ok(Number.isSafeInteger(android.shell.versionCode) && android.shell.versionCode > 0);
  assert.match(ios.build, /^\d+$/);
  assert.match(host.archive.version, /^[a-f0-9]{7,40}$/);
  const box = /^grokbot-box-input:([a-f0-9]{7,40})$/.exec(host.box.localTag);
  assert.ok(box); assert.equal(host.box.platform, 'linux/amd64');
  return { snap, win, mac, ios, android, checkedWindows, host: host.archive.version, box: box[1] };
}

function block(text, name, body) {
  const a = `<!-- ${name}:start -->`, b = `<!-- ${name}:end -->`;
  assert.equal(text.split(a).length, 2, `${name}: missing or duplicate start`);
  assert.equal(text.split(b).length, 2, `${name}: missing or duplicate end`);
  const start = text.indexOf(a) + a.length, end = text.indexOf(b);
  assert.ok(start < end, `${name}: reversed markers`);
  return text.slice(0, start) + '\n' + body + '\n' + text.slice(end);
}

function windowsNotes(observed, pin, checked, zh) {
  if (observed.version === pin.version && observed.observedArchiveSha256 === pin.archive.sha256) return { badge: '', table: '' };
  // known-unsupported.json records an official installer that this patch pin was run against and rejected.
  const researched = pin.version === checked.testedAgainst.version && pin.archive?.sha256 === checked.testedAgainst.sha256
    && ['version', 'build', 'observedArchiveSha256', 'observedAsarSha256'].every(field => observed[field] === checked[field]);
  if (researched) return {
    badge: zh ? '与此补丁不兼容' : 'incompatible with this patch',
    table: zh ? '补丁在输入校验时拒绝了该安装包；未测试原生客户端聊天' : 'installer rejected during input verification; no native chat test',
  };
  const unsupported = zh ? '此补丁不支持' : 'not supported by this patch';
  return { badge: unsupported, table: unsupported };
}

export function render(text, lang, data) {
  assert.ok(['zh','en'].includes(lang));
  const { snap, win, mac, ios, android, host, box } = data;
  const zh = lang === 'zh', label = zh ? '官方' : 'official';
  function badge(name, value, description, logo, color) {
    return `  <a href="#client-versions"><img alt="${description}" src="https://img.shields.io/badge/${encodeURIComponent(name)}-${encodeURIComponent(value)}-${color}?logo=${logo}&logoColor=white"></a>`;
  }
  const windowsBadge = (name, value, color) => badge(name,value,`${name} ${value}`,'windows',color);
  const notes = windowsNotes(snap.windows, win, data.checkedWindows, zh);
  const windowsOfficial = `${snap.windows.version} x64${notes.badge ? ` (${notes.badge})` : ''}`;
  const windowsTableNote = notes.table ? (zh ? `（${notes.table}）` : ` (${notes.table})`) : '';
  const badges = [windowsBadge(`Windows ${label}`,windowsOfficial,'0078D4'),
    windowsBadge(zh ? 'Windows 补丁仅接受' : 'Windows patch accepts only',`${win.version} x64`,'237E55'),
    badge(`macOS ${label}`,`${snap.mac.version} ARM64`,`macOS ${label} ${snap.mac.version} ARM64`,'apple','111111'),
    badge(`iOS ${label}`,snap.ios.version,`iOS ${label} ${snap.ios.version}`,'apple','111111'),
    badge(zh ? '自开发 Android' : 'Unofficial Android',android.shell.versionName,`Android shell ${android.shell.versionName}`,'android','237E55')].join('\n');
  const table = [zh ? `**下载哪个版本的官方安装包？** 按右栏下载，补丁只认这些版本。左栏是官方当前最新版（${snap.checkedOn} 核对），比右栏新时要等本项目适配。` :
    `**Which official version should I download?** The one in the right column; the patches accept only those versions. The left column is the latest official release (checked ${snap.checkedOn}); when it is newer, wait until this project supports it.`, '',
    zh ? '| 平台 | 官方最新版 | 本项目需要的版本 |' : '| Platform | Latest official | Version this project needs |',
    '| --- | --- | --- |',
    `| Windows x64 | [${snap.windows.version}](${official.win})${windowsTableNote} | ${win.version} |`,
    `| macOS ARM64 | [${snap.mac.version}](${official.mac}) | ${mac.version}${zh ? '（未在 Mac 真机上测试）' : ' (not tested on a Mac)'} |`,
    `| iOS | [${snap.ios.version}](${official.ios}) | ${ios.version}${zh ? `（构建 ${ios.build}；未在 iPhone / iPad 上测试）` : ` (build ${ios.build}; not tested on an iPhone or iPad)`} |`,
    zh ? `| Android 9+（自开发，非官方） | 不用官方 Android 版 | App **${android.shell.versionName}**（构建 ${android.shell.versionCode}），界面取自 Windows **${android.desktopVersion}** 安装包 |` :
      `| Android 9+ (unofficial) | Does not use the official Android app | App **${android.shell.versionName}** (build ${android.shell.versionCode}), interface taken from the Windows **${android.desktopVersion}** installer |`,
    zh ? `| Linux 服务端 | 不适用 | Host \`${host}\`；Bot 的电脑 \`${box}\`（x86_64） |` :
      `| Linux server | n/a | Host \`${host}\`; Bot computer \`${box}\` (x86_64) |`, '',
    zh ? 'ProkBot Plus 自己的版本号见[最新发布](https://github.com/ferretgeek/prokbot-plus/releases/latest)；上游 ProkBot 基线是 `3e9fe8c`。' :
      'ProkBot Plus has its own version numbers; see the [latest release](https://github.com/ferretgeek/prokbot-plus/releases/latest). The upstream ProkBot baseline is `3e9fe8c`.'].join('\n');
  return block(block(text,'client-badges',badges),'client-versions',table);
}

async function main(argv) {
  if (argv.length > 1 || (argv.length && argv[0] !== '--write')) throw Error('Usage: node ci/homepage-versions.mjs [--write]');
  const data = await readVersions();
  for (const [file,lang] of [['README.md','zh'],['README.en.md','en']]) {
    const url = new URL(file,root), original = await readFile(url,'utf8'), expected = render(original,lang,data);
    if (expected === original) continue;
    if (argv[0] !== '--write') throw Error(`${file}: generated version information is stale`);
    await writeFile(url,expected);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode=1; });
}
