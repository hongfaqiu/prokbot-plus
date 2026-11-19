import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';
import { PushConfig, parseBarkLink, parseNtfyUrl, parsePushEndpoint, validTopic, DEFAULT_BARK_ICON_URL } from './push-config.mjs';
import { PushError, PushTransports } from './push-transports.mjs';

const authorizationValues = ['notDetermined', 'denied', 'authorized', 'provisional', 'ephemeral', 'granted', 'not_determined', 'unknown'];
const authorizedStates = ['authorized', 'provisional', 'ephemeral', 'granted'];
const iso = () => new Date().toISOString();
const fingerprint = device => createHash('sha256').update(JSON.stringify([
  device.provider, device.token, device.bark, device.ntfy, device.unifiedpush, device.webhook, device.fcmToken, device.environment, device.bundleId,
])).digest('hex');
function clearProviders(target, keep) {
  if (keep !== 'apns') delete target.token;
  if (keep !== 'bark') delete target.bark;
  if (keep !== 'ntfy') delete target.ntfy;
  if (keep !== 'unifiedpush') delete target.unifiedpush;
  if (keep !== 'webhook') delete target.webhook;
  if (keep !== 'fcm') delete target.fcmToken;
}
export class PushService {
  constructor(dataDir, auth, { transports = new PushTransports(), retryMs = 5000, enabled = () => true } = {}) {
    this.enabled = enabled; this.auth = auth; this.transports = transports; this.retryMs = retryMs;
    this.config = new PushConfig(dataDir);
    this.store = new JsonStore(join(dataDir, 'device-push.json'), { version: 1, devices: {}, jobs: [] });
    this.closed = false; this.timer = null; this.running = null;
    this.foreground = new Map(); this.foregroundStreams = new Map();
  }
  async load() { await Promise.all([this.config.load(), this.store.load()]); this.schedule(); return this; }
  publicDevice(device) {
    const value = this.store.value.devices[device.id] ?? {};
    const { provider = 'none', capable = false, authorization = 'notDetermined', environment = null,
      enabled = true, lastAttemptAt = null, lastDeliveredAt = null, lastError = null, registrationError = null } = value;
    const pushHost = value.bark?.host ?? value.ntfy?.host ?? value.unifiedpush?.host ?? value.webhook?.host ?? null;
    const configured =
      provider === 'bark' ? Boolean(value.bark) :
      provider === 'ntfy' ? Boolean(value.ntfy) :
      provider === 'unifiedpush' ? Boolean(value.unifiedpush) :
      provider === 'webhook' ? Boolean(value.webhook) :
      provider === 'fcm' ? Boolean(value.fcmToken) :
      provider === 'apns' && Boolean(value.token);
    return { ...device, deviceId: device.id, name: value.displayName || value.name || device.name,
      kind: ['android', 'web'].includes(device.platform) ? device.platform : value.kind ?? (device.platform === 'ios' ? 'iphone' : 'mac'),
      bundleId: value.bundleId ?? null, appVersion: value.appVersion ?? null,
      push: { provider, capable, authorization, environment, foreground: this.isForeground(device.id), enabled: enabled && !device.revokedAt,
        barkHost: value.bark?.host ?? null,
        ntfyHost: value.ntfy?.host ?? null,
        unifiedPushHost: value.unifiedpush?.host ?? null,
        webhookHost: value.webhook?.host ?? null,
        pushHost,
        hasFcmToken: Boolean(value.fcmToken),
        configured,
        lastAttemptAt, lastDeliveredAt, lastError, registrationError } };
  }
  devices() { return this.auth.devices().map(device => this.publicDevice(device)); }
  get(deviceId) {
    const device = this.auth.devices().find(value => value.id === deviceId);
    check(device, 404, '设备不存在'); return this.publicDevice(device);
  }
  isForeground(deviceId) {
    const presence = this.foreground.get(deviceId);
    return Boolean(presence?.active && Date.now() - presence.receivedAt < 60000 &&
      this.foregroundStreams.get(deviceId)?.size);
  }
  setForeground(deviceId, active) {
    check(typeof active === 'boolean', 400, '应用前台状态无效');
    this.foreground.set(deviceId, { active, receivedAt: Date.now() });
  }
  trackForegroundStream(deviceId, response) {
    const streams = this.foregroundStreams.get(deviceId) ?? new Set();
    streams.add(response); this.foregroundStreams.set(deviceId, streams);
    this.setForeground(deviceId, true);
    response.once('close', () => {
      streams.delete(response);
      if (!streams.size) this.foregroundStreams.delete(deviceId);
    });
  }
  async register(deviceId, input) {
    check(this.auth.device(deviceId), 401, '设备凭证无效');
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '设备配置无效');
    if (input.foreground !== undefined) check(typeof input.foreground === 'boolean', 400, '应用前台状态无效');
    // Presence is process-local and expires; it must not survive a Host restart.
    if (Object.keys(input).length === 1 && input.foreground !== undefined) {
      this.setForeground(deviceId, input.foreground); return this.get(deviceId);
    }
    await this.store.mutate(state => {
      const previous = state.devices[deviceId] ?? { provider: 'none', enabled: true };
      const next = { ...previous };
      delete next.iconUrl;
      if (input.name !== undefined) {
        check(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 80, 400, '设备名称需要 1–80 个字符');
        next.name = input.name.trim();
      }
      if (input.kind !== undefined) {
        check(['iphone', 'ipad', 'mac', 'desktop', 'android'].includes(input.kind), 400, '设备类型无效');
        next.kind = input.kind === 'desktop' && ['windows', 'android', 'web'].includes(input.clientKind) ? input.clientKind : input.kind;
      }
      if (input.bundleId !== undefined) {
        check(validTopic(input.bundleId), 400, '设备 Bundle ID 无效'); next.bundleId = input.bundleId;
      }
      if (input.appVersion !== undefined) {
        check(typeof input.appVersion === 'string' && input.appVersion.length <= 80, 400, '应用版本无效'); next.appVersion = input.appVersion;
      }
      if (input.apnsCapable !== undefined) {
        check(typeof input.apnsCapable === 'boolean', 400, '推送能力值无效'); next.capable = input.apnsCapable;
      }
      if (input.pushCapable !== undefined) {
        check(typeof input.pushCapable === 'boolean', 400, '推送能力值无效'); next.capable = input.pushCapable;
      }
      if (input.apnsEnvironment !== undefined) {
        check([null, 'development', 'production'].includes(input.apnsEnvironment), 400, 'APNs 环境无效'); next.environment = input.apnsEnvironment;
      }
      if (input.authorization !== undefined) {
        check(authorizationValues.includes(input.authorization), 400, '通知授权状态无效'); next.authorization = input.authorization;
      }
      if (input.push !== undefined) {
        const push = input.push;
        check(push && typeof push === 'object' && !Array.isArray(push), 400, '推送配置无效');
        if (push.registrationError !== undefined) {
          check(push.registrationError === null || typeof push.registrationError === 'string' && push.registrationError.length <= 300, 400, '注册状态无效');
          next.registrationError = push.registrationError;
        }
        if (push.provider !== undefined) {
          check(['apns', 'bark', 'ntfy', 'unifiedpush', 'webhook', 'fcm', 'none'].includes(push.provider), 400, '推送方式无效');
          next.provider = push.provider;
          if (push.provider === 'apns') {
            check(next.capable && ['development', 'production'].includes(next.environment) && validTopic(next.bundleId), 400, '此安装包尚未报告 APNs 签名权限');
            if (push.token !== undefined) {
              check(typeof push.token === 'string' && /^(?:[a-fA-F0-9]{2}){16,256}$/.test(push.token), 400, 'APNs 设备令牌无效');
              next.token = push.token.toLowerCase(); next.registrationError = null;
            }
            check(next.token, 400, 'APNs 设备令牌尚未生成');
            clearProviders(next, 'apns');
          } else if (push.provider === 'bark') {
            if (push.barkUrl !== undefined && push.barkUrl !== '') next.bark = parseBarkLink(push.barkUrl);
            check(next.bark, 400, '请填写 Bark 推送链接');
            clearProviders(next, 'bark');
          } else if (push.provider === 'ntfy') {
            const serverDefault = this.config.publicConfig().ntfyServerUrl;
            const rawUrl = push.ntfyUrl && push.ntfyUrl !== ''
              ? push.ntfyUrl
              : push.topic && serverDefault ? `${serverDefault}/${encodeURIComponent(push.topic)}` : '';
            if (rawUrl) {
              const prevToken = next.ntfy?.token;
              next.ntfy = parseNtfyUrl(rawUrl);
              if (prevToken && push.ntfyToken === undefined) next.ntfy.token = prevToken;
              next.registrationError = null;
            }
            if (push.ntfyToken !== undefined && next.ntfy) {
              check(typeof push.ntfyToken === 'string' && push.ntfyToken.length <= 1024, 400, 'ntfy 访问令牌无效');
              if (push.ntfyToken.trim()) next.ntfy = { ...next.ntfy, token: push.ntfyToken.trim() };
              else delete next.ntfy.token;
            }
            check(next.ntfy, 400, '请填写 ntfy 主题地址');
            clearProviders(next, 'ntfy');
          } else if (push.provider === 'unifiedpush') {
            if (push.endpoint !== undefined && push.endpoint !== '') {
              next.unifiedpush = parsePushEndpoint(push.endpoint, 'UnifiedPush 端点');
              next.registrationError = null;
            }
            check(next.unifiedpush, 400, 'UnifiedPush 端点尚未注册');
            clearProviders(next, 'unifiedpush');
          } else if (push.provider === 'webhook') {
            const rawEndpoint = push.webhookUrl ?? push.endpoint;
            if (rawEndpoint !== undefined && rawEndpoint !== '') {
              const prevSecret = next.webhook?.secret;
              next.webhook = parsePushEndpoint(rawEndpoint, 'Webhook 地址');
              if (prevSecret && push.webhookSecret === undefined) next.webhook.secret = prevSecret;
              next.registrationError = null;
            }
            if (push.webhookSecret !== undefined && next.webhook) {
              check(typeof push.webhookSecret === 'string' && push.webhookSecret.length <= 512, 400, 'Webhook 密钥无效');
              if (push.webhookSecret.trim()) next.webhook = { ...next.webhook, secret: push.webhookSecret.trim() };
              else delete next.webhook.secret;
            }
            check(next.webhook, 400, '请填写 Webhook 推送地址');
            clearProviders(next, 'webhook');
          } else if (push.provider === 'fcm') {
            if (push.fcmToken !== undefined) {
              check(typeof push.fcmToken === 'string' && push.fcmToken.length >= 16 && push.fcmToken.length <= 4096 && !/\s/.test(push.fcmToken), 400, 'FCM 设备令牌无效');
              next.fcmToken = push.fcmToken;
              next.registrationError = null;
            }
            check(next.fcmToken, 400, 'FCM 设备令牌尚未生成');
            clearProviders(next, 'fcm');
          } else {
            clearProviders(next, 'none');
          }
        }
      }
      if (fingerprint(next) !== fingerprint(previous)) {
        next.lastError = null; next.enabled = true;
        for (const job of state.jobs) if (job.deviceId === deviceId && job.status === 'queued') job.status = 'cancelled';
      }
      if (input.push?.enabled !== undefined) {
        check(typeof input.push.enabled === 'boolean', 400, '通知开关无效');
        next.enabled = input.push.enabled;
        if (!next.enabled) for (const job of state.jobs)
          if (job.deviceId === deviceId && job.status === 'queued') job.status = 'cancelled';
      }
      state.devices[deviceId] = next;
    });
    if (input.foreground !== undefined) this.setForeground(deviceId, input.foreground);
    return this.get(deviceId);
  }
  async rename(deviceId, name) {
    check(this.auth.device(deviceId), 404, '设备不存在');
    check(typeof name === 'string' && name.trim().length > 0 && name.length <= 80, 400, '设备名称需要 1–80 个字符');
    await this.store.mutate(state => {
      state.devices[deviceId] ??= { provider: 'none', enabled: true };
      state.devices[deviceId].displayName = name.trim();
    });
    return this.get(deviceId);
  }
  async setEnabled(deviceId, enabled) {
    check(this.auth.device(deviceId), 404, '设备不存在');
    check(typeof enabled === 'boolean', 400, '通知开关无效');
    await this.store.mutate(state => {
      state.devices[deviceId] ??= { provider: 'none' };
      state.devices[deviceId].enabled = enabled;
      if (!enabled) for (const job of state.jobs)
        if (job.deviceId === deviceId && job.status === 'queued') job.status = 'cancelled';
    });
    return this.get(deviceId);
  }
  async revoke(deviceId) {
    this.foreground.delete(deviceId); this.foregroundStreams.delete(deviceId);
    await this.store.mutate(state => {
      delete state.devices[deviceId];
      state.jobs = state.jobs.filter(job => job.deviceId !== deviceId);
    });
  }
  unavailable(device) {
    if (!device || device.enabled === false || device.provider === 'none') return '此设备未启用推送';
    if (device.provider === 'bark') return device.bark ? null : 'Bark 尚未配置';
    if (device.provider === 'ntfy') return device.ntfy ? null : 'ntfy 尚未配置';
    if (device.provider === 'webhook') return device.webhook ? null : 'Webhook 尚未配置';
    if (device.provider === 'unifiedpush') {
      if (!device.unifiedpush) return 'UnifiedPush 尚未注册';
      if (!authorizedStates.includes(device.authorization)) return '此设备尚未允许通知';
      return null;
    }
    if (device.provider === 'fcm') {
      if (!device.fcmToken) return 'FCM 设备尚未注册';
      if (!authorizedStates.includes(device.authorization)) return '此设备尚未允许通知';
      if (!this.config.publicConfig().fcm?.ready) return 'Host 尚未配置 FCM';
      return null;
    }
    if (!device.capable || !device.token) return 'APNs 设备尚未注册';
    if (!authorizedStates.includes(device.authorization)) return '此设备尚未允许通知';
    if (!this.config.publicConfig().ready) return 'Host 尚未配置 APNs';
    if (device.bundleId !== this.config.store.value.topic) return '设备 Bundle ID 与 APNs 配置不一致';
    return null;
  }
  async enqueue(item, onlyDeviceId, { bypassForeground = false } = {}) {
    if (!this.enabled()) return [];
    const authDevices = this.auth.devices().filter(device => !device.revokedAt && (!onlyDeviceId || device.id === onlyDeviceId));
    const ids = [];
    await this.store.mutate(state => {
      for (const device of authDevices) {
        const target = state.devices[device.id];
        if (this.unavailable(target)) continue;
        if (!onlyDeviceId && Date.parse(device.createdAt) > Date.parse(item.createdAt)) continue;
        const id = `${device.id}:${item.id}`;
        const suppressed = !bypassForeground && this.isForeground(device.id);
        if (!state.jobs.some(job => job.id === id)) state.jobs.push({
          id, deviceId: device.id, item, fingerprint: fingerprint(target), status: suppressed ? 'suppressed' : 'queued',
          reason: suppressed ? '应用正在前台接收通知' : undefined, bypassForeground, attempts: 0, nextAt: Date.now(),
        });
        ids.push(id);
      }
      // Keep all pending deliveries and a bounded deduplication history.
      const completed = state.jobs.filter(job => job.status !== 'queued').slice(-2000);
      state.jobs = [...completed, ...state.jobs.filter(job => job.status === 'queued')];
    });
    this.schedule(0); return ids;
  }
  schedule(delay = this.retryMs) {
    if (this.closed || this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => this.schedule()); }, delay);
    this.timer.unref();
  }
  async flush() {
    if (this.running) return this.running;
    if (this.closed) return;
    this.running = (async () => {
      await this.store.tail;
      for (const job of this.store.value.jobs.filter(job => job.status === 'queued' && job.nextAt <= Date.now())) {
        if (this.closed) break;
        const device = this.store.value.devices[job.deviceId];
        const reason = !this.enabled() ? '由主 Host 发送通知' : !this.auth.device(job.deviceId) ? '设备已撤销' : this.unavailable(device);
        if (reason || fingerprint(device) !== job.fingerprint || Date.now() - Date.parse(job.item.createdAt) > 86400000) {
          await this.settle(job, 'cancelled', reason ?? '推送配置已更换或通知已过期'); continue;
        }
        if (!job.bypassForeground && this.isForeground(job.deviceId)) {
          await this.store.mutate(state => {
            const current = state.jobs.find(value => value.id === job.id);
            if (current?.status === 'queued') Object.assign(current, { status: 'suppressed', reason: '应用正在前台接收通知' });
          });
          continue;
        }
        try {
          const iconUrl = this.config.store.value.barkIconUrl || DEFAULT_BARK_ICON_URL;
          if (device.provider === 'bark') await this.transports.bark({ ...device, iconUrl }, job.item);
          else if (device.provider === 'ntfy') await this.transports.ntfy({ ...device, iconUrl }, job.item);
          else if (device.provider === 'unifiedpush') await this.transports.unifiedpush(device, job.item);
          else if (device.provider === 'webhook') await this.transports.webhook(device, job.item);
          else if (device.provider === 'fcm') await this.transports.fcm(device, job.item, this.config.store.value);
          else await this.transports.apns(device, job.item, this.config.store.value);
          await this.settle(job, 'sent', null);
        } catch (error) {
          const retry = error instanceof PushError && error.retryable && job.attempts < 4;
          await this.settle(job, retry ? 'queued' : 'failed', error instanceof PushError ? error.message : '推送发送失败', error.invalidToken);
        }
      }
    })();
    try { await this.running; } finally {
      this.running = null;
      if (this.store.value.jobs.some(job => job.status === 'queued')) this.schedule();
    }
  }
  async settle(job, status, error, invalidToken = false) {
    await this.store.mutate(state => {
      const current = state.jobs.find(value => value.id === job.id);
      if (!current || current.status !== 'queued') return;
      Object.assign(current, { status, error, attempts: current.attempts + 1,
        nextAt: Date.now() + Math.min(300000, this.retryMs * 2 ** current.attempts) });
      const device = state.devices[job.deviceId];
      if (!device || fingerprint(device) !== job.fingerprint) return;
      device.lastAttemptAt = iso(); device.lastError = error;
      if (status === 'sent') device.lastDeliveredAt = iso();
      if (invalidToken) {
        if (device.provider === 'unifiedpush') {
          delete device.unifiedpush;
          device.registrationError = 'UnifiedPush 端点已失效，请重新打开应用';
        } else if (device.provider === 'fcm') {
          delete device.fcmToken;
          device.registrationError = 'FCM 设备令牌失效，请重新打开应用';
        } else {
          delete device.token;
          device.registrationError = 'APNs 设备令牌失效，请重新打开应用';
        }
      }
    });
  }
  async test(deviceId, agentId, { bypassForeground = false } = {}) {
    check(this.auth.device(deviceId), 404, '设备不存在');
    const reason = !bypassForeground && this.isForeground(deviceId) ? '应用正在前台接收通知' : this.unavailable(this.store.value.devices[deviceId]);
    if (reason) return { ok: false, status: 'skipped', reason };
    const safeAgentId = typeof agentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(agentId) ? agentId : 'grokbot-test';
    const item = { id: randomUUID(), type: 'test', agentId: safeAgentId, title: 'Grok Bot 通知测试',
      body: '点击此通知打开对应会话。', createdAt: iso(), deepLink: `grokbot-local://agent/${safeAgentId}` };
    const ids = await this.enqueue(item, deviceId, { bypassForeground });
    await this.flush();
    const job = this.store.value.jobs.find(job => ids.includes(job.id));
    return { ok: job?.status === 'sent', status: job?.status ?? 'skipped', reason: job?.error ?? undefined };
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.transports.close(); await this.running; await this.store.tail; await this.config.store.tail; }
}
