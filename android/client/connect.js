// Pairing page of the Android client: Host address and six-character pairing code,
// as in the desktop client's connection window (mac/clients/desktop/connect.js).
import { boot, native } from './native.js';

const locale = boot.locale || navigator.language || 'en';
window.connection = { locale };
const { grokText: text } = await import('./desktop/i18n.mjs');

const $ = selector => document.querySelector(selector);
const server = $('#server'), serverLabel = $('[for=server]'), tailcat = $('#tailcat'), key = $('#key'), password = $('#password'), status = $('#status'), connect = $('#connect');
const keyGroup = $('#key-group'), passwordGroup = $('#password-group'), modeCode = $('#mode-code'), modePassword = $('#mode-password');
const paired = $('#paired'), background = $('#background'), disconnect = $('#disconnect'), workspace = $('#workspace');
const permBtn = $('#perm-btn'), batteryBtn = $('#battery-btn');
const pushProvider = $('#push-provider'), upDistributor = $('#up-distributor');
const ntfyUrl = $('#ntfy-url'), ntfyToken = $('#ntfy-token');
const webhookUrl = $('#webhook-url'), webhookSecret = $('#webhook-secret');
const fcmToken = $('#fcm-token'), pushStateText = $('#push-state-text');
const pushSave = $('#push-save'), pushTest = $('#push-test');
const updatesSection = $('#updates'), updateTitle = $('#update-title'), updateVersion = $('#update-version');
const updateStateText = $('#update-state-text'), updateCheck = $('#update-check'), updateInstall = $('#update-install');

let current = boot.connection ?? {};
let pushState = boot.push ?? {};
let updateStatus = boot.updateStatus ?? null;
let backgroundEnabled = boot.settings?.backgroundNotifications !== false;
let busy = false, composing = false, authMode = 'code';

document.documentElement.lang = /^zh/i.test(locale) ? 'zh-CN' : 'en';
document.title = text('连接 Grok Bot', 'Connect Grok Bot');
$('#edition').textContent = text('ProkBot Plus · 自开发 Android 客户端（非官方）', 'ProkBot Plus · Independently developed Android client (unofficial)');
$('h1').textContent = text('连接你的 Grok Bot', 'Connect your Grok Bot');
$('.lead').textContent = text('填写 Host 地址，使用 Host 管理员密码自动配对，或在管理页「设备与通知」生成 6 位配对码。',
  'Enter the Host address, then pair automatically with the Host admin password or a six-character pairing code from Devices & Notifications.');
serverLabel.textContent = text('Host 地址', 'Host address');
modeCode.textContent = text('配对码', 'Pairing code');
modePassword.textContent = text('管理员密码', 'Admin password');
$('[for=key]').textContent = text('配对码', 'Pairing code');
key.placeholder = text('6 位配对码', 'Six characters');
$('[for=password]').textContent = text('管理员密码', 'Admin password');
password.placeholder = text('Host 管理员密码', 'Host admin password');
$('#background-label').textContent = text('后台保活连接', 'Background notification service');
$('#background-hint').textContent = text('在前台服务中保持连接并即时弹出通知；配合下方推送渠道可在系统休眠或杀后台后唤醒。',
  'Keeps a foreground service connection for instant alerts; pair with a push provider below for wakeups after system sleep.');
$('#push-provider-label').textContent = text('后台推送方式（可与保活并用）', 'Background push transport');
pushProvider.options[0].textContent = text('仅在线长连接 / SSE', 'SSE only (default)');
pushProvider.options[1].textContent = text('UnifiedPush（推荐：ntfy / NextPush / Sunup）', 'UnifiedPush (ntfy / NextPush / Sunup)');
pushProvider.options[2].textContent = text('ntfy 直推服务', 'ntfy direct');
pushProvider.options[3].textContent = text('Webhook 推送', 'Webhook');
pushProvider.options[4].textContent = text('Firebase FCM（需 Host 配置）', 'Firebase FCM (requires Host config)');
$('#up-distributor-label').textContent = text('选择 UnifiedPush 分发应用', 'UnifiedPush distributor app');
$('#ntfy-url-label').textContent = text('ntfy 主题完整地址', 'ntfy topic URL');
$('#ntfy-token-label').textContent = text('ntfy 访问令牌（可选，留空保留）', 'ntfy Bearer token (optional)');
$('#webhook-url-label').textContent = text('Webhook 地址', 'Webhook URL');
$('#webhook-secret-label').textContent = text('Webhook 密钥（可选，留空保留）', 'Webhook secret (optional)');
$('#fcm-token-label').textContent = text('FCM 设备令牌', 'FCM device token');
$('#fcm-hint').textContent = text('开源版外壳不含 Google Play 推送 SDK，如需 FCM 请填写托管分发器的 FCM Token 并于 Host 管理页上传服务账号 JSON。',
  'This open-source APK bundles no Google GMS SDK; enter an FCM token if bridged externally and upload the service account JSON on Host.');
pushSave.textContent = text('保存推送设置', 'Save push');
pushTest.textContent = text('发送测试通知', 'Send test push');
disconnect.textContent = text('退出连接', 'Disconnect');
workspace.textContent = text('返回工作区', 'Back to workspace');
updateTitle.textContent = text('应用版本与更新', 'App version & updates');
updateCheck.textContent = text('检查更新', 'Check for updates');
updateInstall.textContent = text('安装更新', 'Install update');

// A revoked or unreadable credential cannot open the workspace; only pairing again helps.
const usable = () => current.paired === true && !current.error;
const updateTransport = () => {
  serverLabel.textContent = tailcat.checked ? text('连接链接', 'Connection link') : text('Host 地址', 'Host address');
  server.placeholder = tailcat.checked ? 'tailcat://connect/…' : 'https://bot.example.com';
  server.inputMode = tailcat.checked ? 'text' : 'url';
};
tailcat.addEventListener('change', updateTransport);
function setAuthMode(nextMode) {
  authMode = nextMode === 'password' ? 'password' : 'code';
  const isPassword = authMode === 'password';
  keyGroup.hidden = isPassword;
  passwordGroup.hidden = !isPassword;
  modeCode.classList.toggle('active', !isPassword);
  modePassword.classList.toggle('active', isPassword);
  modeCode.setAttribute('aria-pressed', String(!isPassword));
  modePassword.setAttribute('aria-pressed', String(isPassword));
}
setAuthMode('code');
modeCode.addEventListener('click', () => { if (!busy) { setAuthMode('code'); key.focus(); } });
modePassword.addEventListener('click', () => { if (!busy) { setAuthMode('password'); password.focus(); } });

function renderPush() {
  const auth = pushState.authorization || 'not_determined';
  permBtn.textContent = auth === 'granted'
    ? text('通知权限：已允许', 'Notifications: Allowed')
    : auth === 'denied'
      ? text('通知权限：已拒绝（点此开启）', 'Notifications: Denied (Enable)')
      : text('允许发送通知', 'Allow notifications');
  batteryBtn.textContent = pushState.batteryOptimizationIgnored
    ? text('电池优化：已忽略（后台更稳定）', 'Battery: Unrestricted')
    : text('关闭电池优化（防杀后台）', 'Allow background running');

  const selected = pushProvider.value || pushState.provider || 'none';
  $('#push-up-fields').hidden = selected !== 'unifiedpush';
  $('#push-ntfy-fields').hidden = selected !== 'ntfy';
  $('#push-webhook-fields').hidden = selected !== 'webhook';
  $('#push-fcm-fields').hidden = selected !== 'fcm';

  const distributors = Array.isArray(pushState.distributors) ? pushState.distributors : [];
  upDistributor.replaceChildren(...(distributors.length
    ? distributors.map(item => new Option(`${item.label} (${item.packageName})`, item.packageName))
    : [new Option(text('未检测到 UnifiedPush 应用（请先安装 ntfy 等）', 'No UnifiedPush app detected (install ntfy, etc.)'), '')]));
  if (pushState.unifiedPushDistributor && distributors.some(d => d.packageName === pushState.unifiedPushDistributor)) {
    upDistributor.value = pushState.unifiedPushDistributor;
  }
  $('#up-hint').textContent = distributors.length
    ? (pushState.unifiedPushEndpoint
        ? text('UnifiedPush 端点已注册，可正常接收后台唤醒。', 'UnifiedPush endpoint registered.')
        : text('点击“保存推送设置”向分发器注册设备端点。', 'Tap Save push to register endpoint with the distributor.'))
    : text('推荐安装开源推送应用 ntfy（F-Droid / GitHub），安装后可在此直接选择。', 'Install ntfy from F-Droid or GitHub to use UnifiedPush.');

  ntfyUrl.value ||= pushState.ntfyUrl || '';
  webhookUrl.value ||= pushState.webhookUrl || '';
  fcmToken.value ||= pushState.fcmToken || '';
  if (pushState.hasNtfyToken) ntfyToken.placeholder = text('已保存（留空保留）', 'Saved (leave blank to keep)');
  if (pushState.hasWebhookSecret) webhookSecret.placeholder = text('已保存（留空保留）', 'Saved (leave blank to keep)');

  const activeLabel = pushState.provider && pushState.provider !== 'none'
    ? text('当前 Host 已登记：{0}', pushState.provider)
    : text('当前仅使用应用内保活 SSE 接收通知。', 'Using in-app foreground service SSE only.');
  pushStateText.textContent = pushState.registrationError ? `${activeLabel} · ${pushState.registrationError}` : activeLabel;
}

function renderUpdates() {
  if (!updateStatus) { updatesSection.hidden = true; return; }
  updatesSection.hidden = false;
  updateVersion.textContent = `v${updateStatus.currentVersion || boot.appVersion || ''}`;
  const state = updateStatus.state || {};
  const disabled = state.type === 'disabled';
  updateCheck.hidden = disabled;
  updateInstall.hidden = state.type !== 'ready';
  updateCheck.disabled = busy || ['checking', 'available', 'downloading', 'staging'].includes(state.type);
  if (disabled) {
    updateStateText.textContent = text('此构建未内置远程更新地址（使用官方签名构建或 --update-url 启用）。',
      'Auto-update feed not embedded in this build.');
  } else if (state.type === 'checking') {
    updateStateText.textContent = text('正在检查更新…', 'Checking for updates…');
  } else if (state.type === 'available') {
    updateStateText.textContent = text('发现新版本 {0}，准备下载…', state.version || '');
  } else if (state.type === 'downloading') {
    const pct = typeof state.progress === 'number' ? ` (${Math.round(state.progress * 100)}%)` : '';
    updateStateText.textContent = text('正在下载新版本 {0}…{1}', state.version || '', pct);
  } else if (state.type === 'staging') {
    updateStateText.textContent = text('正在校验签名与完整性…', 'Verifying signature and APK checksum…');
  } else if (state.type === 'ready') {
    updateStateText.textContent = text('新版本 {0} 已下载并校验通过，点击安装。', state.version || '');
  } else if (state.lastCheck?.result === 'up-to-date') {
    updateStateText.textContent = text('已是最新版本。', 'You are up to date.');
  } else if (state.lastCheck?.result === 'error') {
    updateStateText.textContent = text('检查更新失败：{0}', state.lastCheck.errorMessage || state.lastCheck.failure?.kind || 'error');
  } else {
    updateStateText.textContent = text('已启用签名校验自动更新。', 'Signed auto-updates enabled.');
  }
}

function render() {
  const isPaired = current.paired === true;
  tailcat.checked = current.tailcat === true;
  updateTransport();
  server.value ||= current.server ?? '';
  paired.hidden = !isPaired;
  workspace.hidden = !usable();
  background.checked = backgroundEnabled;
  connect.textContent = isPaired ? text('重新配对', 'Pair again') : text('连接', 'Connect');
  if (pushState.provider) pushProvider.value = pushState.provider;
  renderPush();
  renderUpdates();
  if (current.error) setStatus(current.error);
}
function setStatus(message, ok = false) {
  status.textContent = message;
  status.classList.toggle('ok', ok);
}
function setBusy(value) {
  busy = value;
  for (const control of [tailcat, server, modeCode, modePassword, key, password, connect, disconnect, workspace, background,
    permBtn, batteryBtn, pushProvider, upDistributor, ntfyUrl, ntfyToken, webhookUrl, webhookSecret, fcmToken,
    pushSave, pushTest, updateCheck, updateInstall]) {
    if (control) control.disabled = value;
  }
}
// Chinese input methods often type full-width characters and the ideographic full stop.
const halfWidth = value => value.normalize('NFKC').replace(/\u3002/g, '.').replace(/\s+/g, '');
const tailcatLink = value => {
  const raw = halfWidth(value);
  if (/^tc[A-Za-z0-9_-]{30,16384}$/.test(raw)) return `tailcat://connect/${raw}?port=8000`;
  const candidate = new URL(raw);
  if (candidate.protocol !== 'tailcat:' || candidate.hostname !== 'connect' || candidate.username || candidate.password ||
      candidate.hash || !/^\/tc[A-Za-z0-9_-]{30,16384}$/.test(candidate.pathname) ||
      [...candidate.searchParams.keys()].join() !== 'port' || !/^[1-9][0-9]{0,4}$/.test(candidate.searchParams.get('port')) ||
      Number(candidate.searchParams.get('port')) > 65535)
    throw new Error('Invalid Tailcat link');
  return candidate.href;
};
// Rewriting the field while an input method is still composing would drop the composition.
const tidyKey = () => { key.value = halfWidth(key.value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); };
const form = $('#form');
form.addEventListener('compositionstart', () => { composing = true; });
form.addEventListener('compositionend', event => { composing = false; if (event.target === key) tidyKey(); });
key.addEventListener('input', event => { if (!composing && !event.isComposing) tidyKey(); });
server.addEventListener('change', () => { server.value = halfWidth(server.value); });

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || composing) return;
  const address = halfWidth(server.value), tunneled = tailcat.checked;
  if (!address) {
    setStatus(tunneled ? text('请输入 Tailcat 连接链接。', 'Enter the Tailcat connection link.') : text('请输入 Host 地址。', 'Enter the Host address.'));
    server.focus(); return;
  }
  let payload;
  if (authMode === 'password') {
    const secret = password.value;
    if (!secret) {
      setStatus(text('请输入 Host 管理员密码。', 'Enter the Host admin password.'));
      password.focus(); return;
    }
    payload = { server: address, password: secret, edit: false, ...(tunneled ? { tailcat: true } : {}) };
  } else {
    tidyKey();
    const code = key.value.trim();
    let sameOrigin = false;
    if (usable() && tunneled === (current.tailcat === true)) {
      try {
        if (tunneled) {
          sameOrigin = tailcatLink(address) === tailcatLink(current.server);
        } else {
          const candidate = new URL(address), saved = new URL(current.server);
          sameOrigin = /^(https?:)$/.test(candidate.protocol) && !candidate.username && !candidate.password &&
            candidate.pathname === '/' && !candidate.search && !candidate.hash && candidate.origin === saved.origin;
        }
      } catch { /* Native pairing validates the complete address before sending a new code. */ }
    }
    if (usable() && !code && !sameOrigin) {
      setStatus(text('更换 Host 地址须使用新 Host 的配对码。', 'Enter a new pairing code to change Host.'));
      key.focus(); return;
    }
    const edit = usable() && !code && sameOrigin;
    if (!edit && code.length !== 6) { setStatus(text('请输入 6 位配对码。', 'Enter the six-character pairing code.')); key.focus(); return; }
    payload = { server: address, key: code, edit, ...(tunneled ? { tailcat: true } : {}) };
  }
  setBusy(true);
  setStatus(text('正在连接…', 'Connecting…'), true);
  try {
    const result = await native('pair', payload);
    if (!result.ok) throw new Error(result.error);
    key.value = '';
    password.value = '';
    setStatus(text('已连接，正在打开工作区…', 'Connected. Opening the workspace…'), true);
  } catch (error) {
    setStatus(error.message);
    setBusy(false);
  }
});
disconnect.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await native('disconnect');
    current = { paired: false };
    pushState = { provider: 'none', authorization: pushState.authorization, batteryOptimizationIgnored: pushState.batteryOptimizationIgnored, distributors: pushState.distributors };
    key.value = '';
    password.value = '';
    ntfyUrl.value = '';
    ntfyToken.value = '';
    webhookUrl.value = '';
    webhookSecret.value = '';
    fcmToken.value = '';
    render();
    setStatus(text('已断开', 'Disconnected'), true);
  } catch (error) { setStatus(error.message); }
  finally { setBusy(false); }
});
workspace.addEventListener('click', () => { location.assign('/app/renderer/index.html'); });
background.addEventListener('change', async () => {
  if (busy) return;
  const value = background.checked;
  setBusy(true);
  try {
    const result = await native('settings', { key: 'backgroundNotifications', value });
    backgroundEnabled = result.settings?.backgroundNotifications ?? value;
    setStatus(current.error || '');
  } catch (error) { setStatus(error.message); }
  finally { background.checked = backgroundEnabled; setBusy(false); }
});

pushProvider.addEventListener('change', renderPush);
permBtn.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    const res = await native('notification-permission');
    pushState.authorization = res.authorization || (res.granted ? 'granted' : 'denied');
    renderPush();
  } catch (error) { setStatus(error.message); }
  finally { setBusy(false); }
});
batteryBtn.addEventListener('click', async () => {
  try {
    const res = await native('battery-optimization');
    pushState.batteryOptimizationIgnored = Boolean(res.ignored);
    renderPush();
  } catch (error) { setStatus(error.message); }
});
pushSave.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  setStatus(text('正在保存推送设置并同步到 Host…', 'Saving push settings…'), true);
  try {
    const provider = pushProvider.value;
    const payload = { provider };
    if (provider === 'unifiedpush') payload.distributor = upDistributor.value;
    else if (provider === 'ntfy') {
      payload.ntfyUrl = ntfyUrl.value.trim();
      if (ntfyToken.value.trim()) payload.ntfyToken = ntfyToken.value.trim();
    } else if (provider === 'webhook') {
      payload.webhookUrl = webhookUrl.value.trim();
      if (webhookSecret.value.trim()) payload.webhookSecret = webhookSecret.value.trim();
    } else if (provider === 'fcm') {
      payload.fcmToken = fcmToken.value.trim();
    }
    const res = await native('push-config', payload);
    if (res.state) pushState = res.state;
    ntfyToken.value = '';
    webhookSecret.value = '';
    renderPush();
    setStatus(provider === 'unifiedpush' && !pushState.unifiedPushEndpoint
      ? text('已向 UnifiedPush 分发器发起注册，请稍等片刻或再点一次测试。', 'Requested UnifiedPush endpoint registration.')
      : text('推送设置已保存并同步到 Host。', 'Push settings saved and synced to Host.'), true);
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
});
pushTest.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  setStatus(text('正在发送测试推送…', 'Sending test push…'), true);
  try {
    const res = await native('push-test', {});
    setStatus(res.ok ? text('测试推送已由 Host 发出。', 'Test notification delivered by Host.') : (res.reason || text('测试推送未发送。', 'Test push skipped.')), Boolean(res.ok));
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
});
updateCheck.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    const res = await native('update-check');
    updateStatus = res.status || res;
    renderUpdates();
  } catch (error) { setStatus(error.message); }
  finally { setBusy(false); }
});
updateInstall.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    const res = await native('update-install', { expectedVersion: updateStatus?.state?.version ?? '' });
    if (res.status === 'superseded') {
      setStatus(text('有更新的版本待拉取，请先重新检查更新。', 'Update superseded; check for updates again.'));
    }
  } catch (error) { setStatus(error.message); }
  finally { setBusy(false); }
});

window.__grokbotAndroid = Object.freeze({
  back: () => usable() ? 'workspace' : 'exit',
  event({ type, payload } = {}) {
    if (type === 'update-status' && payload?.state) {
      updateStatus = payload;
      renderUpdates();
    } else if (type === 'push-state' && payload) {
      pushState = payload;
      if (payload.provider) pushProvider.value = payload.provider;
      renderPush();
    } else if (type === 'focus' && payload?.focused) {
      void native('push-state').then(res => { if (res.state) { pushState = res.state; renderPush(); } }).catch(() => {});
      void native('update-status').then(res => { if (res.status) { updateStatus = res.status; renderUpdates(); } }).catch(() => {});
    }
  },
});
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
void native('theme', { dark, background: dark ? '#111111' : '#ffffff' }).catch(() => {});
render();
// compat.js shows an explanation instead of a blank form if this point is never reached.
window.__grokbotStarted = true;
