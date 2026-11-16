// Entry of the Android workspace page. It runs before the original renderer (the
// patcher inserts it ahead of the renderer's module script) and plays the role of
// the Electron main process and preload of the desktop client:
//
// - runs the original preload (official-preload.js, copied from the user's own
//   download) against a small `electron` stand-in, so the renderer gets exactly the
//   window.desktop / window.coordinatorPort API it was built for;
// - answers the preload's IPC with the services of mac/clients/desktop, ported in
//   services.js and gateway.js;
// - adds window.localBot, the API that the ProkBot Plus renderer patches use.
import officialPreload, { methods as preloadMethods, edges as preloadEdges } from './official-preload.js';
import { boot as androidBoot, native, log, timeout } from './native.js';
import { createGateway } from './gateway.js';
import { installWebviewFrames } from './webview.js';
import { installLayoutFixes, computerStageOpen, phoneBack, showConversation } from './layout.js';
import { installAnchorFallback } from './anchor-fallback.js';
import { grokText } from './desktop/i18n.mjs';
import {
  auth, themeState, languageState, createStaging, createAttachments, createProfile,
  createVoiceAvailability, mintVoiceCredential, createPersistence, createServices,
} from './services.js';

// Before the renderer sets any inline style (module scripts run in document order).
const anchorFallback = installAnchorFallback();

const settings = { theme: 'system', language: 'system', realtimeVoice: false, botColor: false, spellCheck: true, ...androidBoot.settings };
const systemLocale = androidBoot.systemLocale || navigator.language || 'en';
let systemDark = androidBoot.systemDark === true;
let connection = androidBoot.connection ?? {};
let server = connection.server ?? '';
const locale = settings.language === 'system' ? systemLocale : settings.language;
document.documentElement.lang = /^zh/i.test(locale) ? 'zh-CN' : 'en';
document.documentElement.classList.add('grokbot-android');

const theme = themeState(settings, systemDark);
const language = languageState(settings, systemLocale);
const experiments = {
  featureGates: {
    sand_create_temporal_agents: false,
    grok_bot_box_harness_turns_blocked: false,
    sand_profile_photo_edit: true,
    // Recording a demonstration needs the desktop screen; it stays on the computer clients.
    sand_teach_by_demonstration: false,
    publish_user_skills: true,
    // No local browser profile to import cookies from on the phone.
    agent_prompted_cookie_sync: false,
    sand_voice_call: false,
    sand_voice_resumption: false,
  },
  dynamicConfigs: {},
};
const bootSnapshot = {
  mainEdge: 'served', theme, language, experiments,
  isAssistiveTechEnabled: false, isEgressTunnelEnabled: false, isWebauthnProxyEnabled: false,
  isBotColorInChatEnabled: settings.botColor === true,
  egressTunnelStatus: { enabled: false, active: false },
  rosterPhotos: null, computerUseHelperName: 'Grok Bot Computer Use',
};

// ---- IPC towards the renderer -------------------------------------------------------------

const listeners = new Map();
function emitIpc(channel, payload, ports = []) {
  const event = { sender: null, ports };
  for (const listener of [...(listeners.get(channel) ?? [])]) {
    try { listener(event, payload); } catch (error) { log('[ipc listener]', channel, error); }
  }
}
const emit = (name, payload) => emitIpc(`dune-rpc:main:e:${name}`, payload);

// ---- connection, services ----------------------------------------------------------------

let focused = document.visibilityState === 'visible';
let blurredAt = focused ? 0 : Date.now();
const connectionListeners = new Set();
const voiceListeners = new Set();
let profile = null;
const gateway = createGateway({
  onUnauthorized: () => { void native('unauthorized').catch(() => {}); },
  onConnected: () => reportFocus(),
  onStateChanged: () => reportConnection(),
});
function connectionStatus() {
  return { paired: true, connected: true, server, tailcat: connection.tailcat === true,
    transportPath: connection.transportPath ?? 'direct',
    state: gateway.getState(), profile: profile?.current() ?? null, error: '' };
}
function reportConnection() {
  const status = connectionStatus();
  for (const listener of [...connectionListeners]) { try { listener(status); } catch {} }
}
function reportFocus() {
  void gateway.command('setWindowFocused', { isFocused: focused }).catch(() => {});
  void gateway.request('/local/device', { foreground: focused }, undefined, 'PUT').catch(() => {});
  if (focused) {
    void profile?.refresh().catch(() => {});
    emit('window-focus', {});
  }
}

profile = createProfile({ request: gateway.request, server, emit, onChange: reportConnection });
const voice = createVoiceAvailability({ request: gateway.request, experiments, emit, getPreference: () => settings.realtimeVoice === true });
const persistence = createPersistence(androidBoot.persistence);
const staging = createStaging();
const attachments = createAttachments({ command: gateway.command, staging,
  onProgress: progress => emit('attachment-commit-progress', progress) });

let deepLinksReady = false;
let pendingAgent = androidBoot.pendingAgent ?? null;
function openAgent(id) {
  pendingAgent = id;
  if (!deepLinksReady) return;
  pendingAgent = null;
  showConversation();
  emit('focus-agent', { id });
  void native('ready').catch(() => {});
}

function backgroundColor() {
  const parse = value => /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value ?? '');
  for (const element of [document.querySelector('#root > *'), document.body, document.documentElement]) {
    if (!element) continue;
    const match = parse(getComputedStyle(element).backgroundColor);
    if (match && (match[4] === undefined || Number(match[4]) > 0.9))
      return `#${match.slice(1, 4).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
  }
  return theme.resolved === 'dark' ? '#111111' : '#ffffff';
}
let chromeTimer = 0, lastChrome = '';
function applyChrome() {
  clearTimeout(chromeTimer);
  // Wait for the renderer to apply the theme before the system bars follow it.
  chromeTimer = setTimeout(() => {
    const chrome = { dark: theme.resolved === 'dark', background: backgroundColor() };
    const key = JSON.stringify(chrome);
    if (key === lastChrome) return;
    lastChrome = key;
    void native('theme', chrome).catch(() => { lastChrome = ''; });
  }, 120);
}

const services = createServices({
  gateway, server, emit, settings, systemLocale, theme, language, boot: bootSnapshot, experiments,
  profile, voice, persistence, attachments,
  reconnectStreams: () => gateway.reconnectStreams(),
  systemDark: () => systemDark,
  applyChrome,
  showConnection: () => { location.assign('/app/client/connect.html'); return null; },
  disconnect: async () => { await native('disconnect'); return null; },
  deepLinksReady: async () => {
    deepLinksReady = true;
    const fromShell = await native('ready').then(value => value.pendingAgent).catch(() => null);
    const id = fromShell ?? pendingAgent;
    pendingAgent = null;
    if (id) setTimeout(() => { showConversation(); emit('focus-agent', { id }); }, 0);
    return null;
  },
  voicePreferenceChanged: enabled => {
    for (const listener of [...voiceListeners]) { try { listener(enabled); } catch {} }
  },
  onSettingsChanged: key => { if (key === 'theme') applyChrome(); },
});

// ---- the Electron stand-in for the original preload ---------------------------------------

const methodNames = new Set(preloadMethods);
// The 1.1.0 desktop mount panels and Spotlight are official windows this client never opens.
const otherEdges = new Set(Object.keys(preloadEdges ?? {}));
const ports = new Set();
async function invoke(channel, args) {
  if (channel === 'dune-rpc:main:probe') return { ok: true, value: methodNames.has(args) || services.has(args) };
  if (channel.startsWith('dune-rpc:main:m:')) {
    const method = channel.slice('dune-rpc:main:m:'.length);
    try { return { ok: true, value: await services.call(method, args) }; }
    catch (error) { return { ok: false, failure: { code: 'edge/handler-failed', detail: error?.message ?? String(error) } }; }
  }
  const edge = /^dune-rpc:([a-z][a-z-]*):(probe|m:)/.exec(channel);
  if (edge && otherEdges.has(edge[1])) return edge[2] === 'probe' ? { ok: true, value: false }
    : { ok: false, failure: { code: 'edge/unknown-method', detail: `The local client does not provide ${edge[1]}` } };
  if (channel === 'sand:coordinator-port-request') {
    const { port1, port2 } = new MessageChannel();
    const dispose = gateway.attach(port1);
    ports.add(dispose);
    setTimeout(() => emitIpc('sand:coordinator-port', null, [port2]), 0);
    return undefined;
  }
  if (channel.startsWith('dune-rpc:')) return { ok: false, failure: { code: 'edge/unavailable', detail: 'Not available on Android' } };
  return undefined;
}
function sendSync(channel) {
  if (channel === 'sand:boot-snapshot-sync') return bootSnapshot;
  if (channel === 'grokbot-local:locale') return locale;
  return undefined;
}
const ipcRenderer = {
  invoke: (channel, ...args) => invoke(channel, args[0]),
  send: () => {},
  sendSync: channel => sendSync(channel),
  postMessage: (_channel, _message, transfer) => { for (const port of transfer ?? []) port?.close?.(); },
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(listener);
    return ipcRenderer;
  },
  once(channel, listener) {
    const wrapper = (...args) => { ipcRenderer.off(channel, wrapper); listener(...args); };
    return ipcRenderer.on(channel, wrapper);
  },
  off(channel, listener) { listeners.get(channel)?.delete(listener); return ipcRenderer; },
  removeListener(channel, listener) { return ipcRenderer.off(channel, listener); },
  removeAllListeners(channel) { if (channel) listeners.delete(channel); else listeners.clear(); return ipcRenderer; },
};
const electron = {
  ipcRenderer,
  contextBridge: { exposeInMainWorld: (name, api) => Object.defineProperty(window, name, { value: api, configurable: true }) },
  webFrame: { getZoomFactor: () => 1 },
  // Files picked on Android have no path; the preload then stages their bytes.
  webUtils: { getPathForFile: () => '' },
};
const preloadProcess = { platform: 'android', type: 'renderer', argv: [], env: {}, versions: {} };

window.localBot = Object.freeze({
  locale,
  platform: 'android',
  openManagement: () => { void native('open-external', { url: `${server}/admin` }).catch(() => {}); },
  updateProfile: async (id, fields) => {
    if (typeof id !== 'string' || !fields || Object.entries(fields).some(([key, value]) => !['title', 'description'].includes(key) || typeof value !== 'string'))
      throw new Error('Invalid Bot profile');
    const agents = await gateway.command('listAgents');
    const current = agents.find(agent => agent.id === id);
    if (!current) throw new Error(grokText('Bot 不存在', 'Bot not found'));
    return gateway.command('updateAgent', { id, profile: { name: current.name, title: current.title ?? '', description: current.description ?? '', ...fields } });
  },
  connectionStatus: async () => {
    await profile.refresh().catch(() => {});
    const latest = await native('status').catch(() => null);
    if (latest) { connection = latest; server = latest.server ?? server; }
    return connectionStatus();
  },
  mintVoiceCredential: async agentId => {
    try {
      if (settings.realtimeVoice !== true) throw new Error(grokText('请启用实时语音。', 'Enable realtime voice.'));
      return { ok: true, credential: await mintVoiceCredential({ request: gateway.request }, agentId) };
    // 1.1.0 reads a missing usage refusal as a usage limit; this failure is never one.
    } catch (error) { return { ok: false, fault: { reason: 'unavailable' }, usageRefusal: null, detail: error.message }; }
  },
  getVoicePreference: () => services.call('getRealtimeVoiceEnabled'),
  setVoicePreference: enabled => services.call('setRealtimeVoiceEnabled', { enabled }),
  onVoicePreferenceChanged: callback => { voiceListeners.add(callback); return () => voiceListeners.delete(callback); },
  pair: async args => {
    try {
      const result = await native('pair', {
        server: args?.server ?? '',
        key: args?.key ?? '',
        edit: args?.edit === true,
        ...(args?.tailcat === true ? { tailcat: true } : {}),
      });
      if (result?.ok && result.connection) {
        connection = result.connection;
        server = connection.server ?? server;
        reportConnection();
      }
      return result;
    } catch (error) { return { ok: false, error: error.message }; }
  },
  disconnect: async () => { await native('disconnect'); return { ok: true }; },
  onConnectionChanged: callback => { connectionListeners.add(callback); return () => connectionListeners.delete(callback); },
  pushState: () => native('push-state'),
  configurePush: config => native('push-config', config),
  testPush: agentId => native('push-test', { agentId: agentId ?? '' }),
  updateStatus: () => native('update-status'),
  checkForUpdates: () => native('update-check'),
  installUpdate: expectedVersion => native('update-install', { expectedVersion: expectedVersion ?? '' }),
});

officialPreload(name => {
  if (name === 'electron') return electron;
  throw new Error(`Cannot find module '${name}'`);
}, preloadProcess);

installWebviewFrames({ hostOrigin: () => server, vncOrigin: androidBoot.vncOrigin, tailcat: () => connection.tailcat === true, desktopTicket: gateway.desktopTicket });
installLayoutFixes();
if (anchorFallback) log(`[webview] CSS anchor positioning fallback active (${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'unknown'})`);

// ---- Android shell events and the back gesture --------------------------------------------

function visible(element) {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
}
function back() {
  const overlay = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], [data-radix-popper-content-wrapper]')]
    .filter(visible).pop();
  if (overlay) {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : overlay;
    for (const type of ['keydown', 'keyup'])
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    return 'handled';
  }
  // Neither the large computer view nor the details pane closes on Escape; use their buttons.
  const button = computerStageOpen()
    ? document.querySelector('.sand-computer-fullscreen .sand-computer-top-bar__actions button')
    : paneBackButton() ?? [...document.querySelectorAll('[data-grokbot-back]')].filter(visible).pop();
  if (button) { button.click(); return 'handled'; }
  // On a phone a conversation is a screen of its own; back returns to the Bot list.
  return phoneBack() ? 'handled' : 'exit';
}

/** In a details sub-page (such as Bot settings) back returns to the details; otherwise it closes the pane. */
function paneBackButton() {
  const pane = document.querySelector('.sand-info-pane[data-open="true"]');
  if (!pane || !visible(pane)) return null;
  return [...pane.querySelectorAll('.sand-info-pane__back button')].find(visible)
    ?? [...pane.querySelectorAll('.sand-info-pane__actions button')].filter(visible).pop() ?? null;
}

let resumeInFlight = null;
let lastReconnectAt = 0;

function runResumeRecovery({ reason = '', awayMs = 0, staleMs = Infinity, force = false } = {}) {
  if (resumeInFlight && !force) return resumeInFlight;
  const previous = resumeInFlight;
  const task = (async () => {
    if (previous) await previous.catch(() => {});
    const resumeResult = await native('resume', {
      ...(reason ? { reason } : {}),
      awayMs,
      staleMs: Number.isFinite(staleMs) ? staleMs : -1,
      ...(force ? { force: true } : {}),
    }, { signal: timeout(4500) }).catch(() => null);
    if (!focused) return;
    const forceStreams = Boolean(resumeResult?.reconnected || force || reason === 'online' || awayMs >= 5000 || staleMs >= 12000);
    if (gateway.reconnectStreams({ onlyIfStaleMs: forceStreams ? 0 : 12000 })) {
      lastReconnectAt = Date.now();
    }
    reportFocus();
    void voice.refresh();
  })().finally(() => {
    if (resumeInFlight === task) resumeInFlight = null;
  });
  resumeInFlight = task;
  return task;
}

window.__grokbotAndroid = Object.freeze({
  event({ type, payload } = {}) {
    if (type === 'focus') {
      const wasFocused = focused;
      focused = payload?.focused === true;
      if (!focused) {
        blurredAt = blurredAt || Date.now();
        reportFocus();
        // 1.1.0 tracks whether the workspace is on screen; 0.71.2 ignores these events.
        emit('window-visibility', { visible: false });
        return;
      }
      emit('window-visibility', { visible: true });
      const hostAwayMs = Number.isFinite(payload?.awayMs) && payload.awayMs >= 0 ? payload.awayMs : 0;
      const awayMs = Math.max(hostAwayMs, blurredAt ? Date.now() - blurredAt : 0);
      blurredAt = 0;
      const lastActivityAt = gateway.getLastActivityAt();
      const staleMs = lastActivityAt ? Date.now() - lastActivityAt : Infinity;
      if (!wasFocused || payload?.forceReconnect === true || staleMs >= 12000 || awayMs >= 5000) {
        void runResumeRecovery({ awayMs, staleMs, force: payload?.forceReconnect === true });
      } else {
        reportFocus();
      }
    } else if (type === 'reconnect-streams') {
      if (Date.now() - lastReconnectAt >= 300) {
        lastReconnectAt = Date.now();
        gateway.reconnectStreams();
        if (focused) emit('window-focus', {});
      }
    } else if (type === 'push-state' && payload) {
      androidBoot.push = payload;
      emit('push-state', payload);
    } else if (type === 'update-status' && payload?.state) {
      androidBoot.updateStatus = payload;
      emit('update-status', payload);
    } else if (type === 'focus-agent' && typeof payload?.id === 'string') {
      openAgent(payload.id);
    } else if (type === 'system-theme') {
      systemDark = payload?.dark === true;
      if (settings.theme === 'system') services.updateTheme(systemDark);
    }
  },
  back,
});

// ---- start --------------------------------------------------------------------------------

addEventListener('pagehide', () => { clearTimeout(chromeTimer); for (const dispose of ports) dispose(); ports.clear(); gateway.close(); });
if (typeof addEventListener === 'function') {
  addEventListener('online', () => {
    if (focused) {
      void runResumeRecovery({ reason: 'online', force: true });
    }
  });
}
if (typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !focused) {
      window.__grokbotAndroid.event({ type: 'focus', payload: { focused: true } });
    }
  });
}
// The Host lists unnamed desktop clients as Macs; report this device once per session.
void gateway.request('/local/device', {
  kind: 'desktop', clientKind: 'android', appVersion: androidBoot.appVersion,
  ...(androidBoot.bundleId ? { bundleId: androidBoot.bundleId } : {}),
  foreground: focused,
}, undefined, 'PUT').catch(() => {});
void profile.refresh().catch(() => {});
void voice.refresh();
applyChrome();
addEventListener('load', applyChrome, { once: true });
new MutationObserver(applyChrome).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
