import { createPrivateKey, X509Certificate } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) blockedIpv4.addSubnet(address, prefix, 'ipv4');

const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blockedIpv6.addSubnet(address, prefix, 'ipv6');

export function isPublicPushHost(rawHostname) {
  if (typeof rawHostname !== 'string') return false;
  const trimmed = rawHostname.trim();
  if (!trimmed || /[\s/?#@\\%\u0000-\u001f]/.test(trimmed)) return false;
  const formatted = !trimmed.startsWith('[') && trimmed.includes(':') ? `[${trimmed}]` : trimmed;
  let parsed;
  try { parsed = new URL(`http://${formatted}`); } catch { return false; }
  if (parsed.port || parsed.username || parsed.password || parsed.pathname !== '/') return false;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!hostname || hostname.includes('%')) return false;
  const family = isIP(hostname);
  if (family === 4) return !blockedIpv4.check(hostname, 'ipv4');
  if (family === 6) return !blockedIpv6.check(hostname, 'ipv6');
  if (!hostname.includes('.')) return false;
  if (
    hostname === 'localhost' ||
    hostname === 'metadata.goog' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localdomain') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.arpa')
  ) return false;
  return true;
}

function assertPublicPushUrl(url, label) {
  check(['http:', 'https:'].includes(url.protocol) && isPublicPushHost(url.hostname),
    400, `${label}不能使用本机、内网或保留地址`);
}

export const validTopic = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(value);
const validId = value => typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value);
// Grok Bot 1.16.0 artwork from Apple's public lookup API, verified 2026-10-21.
// Store the URL only; release packages do not redistribute the original image.
export const DEFAULT_BARK_ICON_URL = 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/15/7d/6d/157d6dc5-51be-d2d1-488b-df875e436c3e/app-0-0-1x_U007epad-0-0-0-1-0-0-P3-85-220.png/512x512bb.jpg';
export class PushConfig {
  constructor(dataDir) {
    this.store = new JsonStore(join(dataDir, 'push-provider.json'), {
      version: 1, enabled: false, mode: 'token', topic: '', teamId: '', keyId: '',
    });
  }
  async load() { await this.store.load(); return this; }
  publicConfig() {
    const {
      enabled, mode, topic, teamId, keyId, privateKey, certificate, certificateExpiresAt,
      barkIconUrl = '', ntfyServerUrl = '', fcm = {},
    } = this.store.value;
    const fcmPublic = {
      enabled: Boolean(fcm?.enabled),
      projectId: fcm?.projectId ?? '',
      clientEmail: fcm?.clientEmail ?? '',
      hasPrivateKey: Boolean(fcm?.privateKey),
      ready: Boolean(fcm?.enabled && fcm?.projectId && fcm?.clientEmail && fcm?.privateKey),
    };
    return { enabled, mode, topic, teamId, keyId, barkIconUrl, ntfyServerUrl, fcm: fcmPublic,
      hasPrivateKey: Boolean(privateKey), hasCertificate: Boolean(certificate),
      certificateExpiresAt: certificateExpiresAt ?? null,
      ready: Boolean(enabled && privateKey && validTopic(topic) &&
        (mode === 'token' ? validId(teamId) && validId(keyId) : certificate && Date.parse(certificateExpiresAt) > Date.now())) };
  }
  async save(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '推送配置无效');
    await this.store.mutate(current => {
      const next = { ...current };
      for (const key of ['enabled', 'mode', 'topic', 'teamId', 'keyId'])
        if (input[key] !== undefined) next[key] = input[key];
      if (input.barkIconUrl !== undefined) next.barkIconUrl = normalizeBarkIconUrl(input.barkIconUrl);
      if (input.ntfyServerUrl !== undefined) next.ntfyServerUrl = normalizeOptionalHttpUrl(input.ntfyServerUrl, 'ntfy 服务地址');
      if (input.clearCredentials || next.mode !== current.mode) {
        delete next.privateKey; delete next.certificate; delete next.certificateExpiresAt;
      }
      for (const key of ['privateKey', 'certificate']) {
        if (input[key] === undefined || input[key] === '') continue;
        check(typeof input[key] === 'string' && input[key].length <= 32768, 400, '推送凭证文件过大');
        next[key] = input[key].trim();
      }
      check(typeof next.enabled === 'boolean' && ['token', 'certificate'].includes(next.mode), 400, '推送认证方式无效');
      check(!next.topic || validTopic(next.topic), 400, 'App Bundle ID 无效');
      check(!next.teamId || validId(next.teamId), 400, 'Team ID 应为 10 位字母或数字');
      check(!next.keyId || validId(next.keyId), 400, 'Key ID 应为 10 位字母或数字');
      let key;
      if (next.privateKey) {
        try { key = createPrivateKey(next.privateKey); }
        catch { check(false, 400, '无法读取私钥，请上传未加密的 PEM 或 APNs .p8 文件'); }
      }
      if (next.mode === 'token' && key) {
        check(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1', 400, 'APNs .p8 必须是 P-256 私钥');
      }
      if (next.mode === 'certificate' && next.certificate) {
        let cert;
        try { cert = new X509Certificate(next.certificate); }
        catch { check(false, 400, '无法读取 PEM 推送证书'); }
        check(Date.parse(cert.validTo) > Date.now(), 400, '推送证书已过期');
        if (key) check(cert.checkPrivateKey(key), 400, '推送证书与私钥不匹配');
        next.certificateExpiresAt = new Date(cert.validTo).toISOString();
      }
      if (next.enabled) {
        check(key && validTopic(next.topic), 400, '启用 APNs 需要私钥和 App Bundle ID');
        check(next.mode === 'token' ? validId(next.keyId) && validId(next.teamId) : next.certificate, 400, '请填写完整的 APNs 凭证');
      }

      if (input.fcm !== undefined || input.clearFcmCredentials) {
        const currentFcm = { ...(current.fcm ?? {}) };
        if (input.clearFcmCredentials) {
          delete next.fcm;
        } else {
          check(input.fcm && typeof input.fcm === 'object' && !Array.isArray(input.fcm), 400, 'FCM 配置无效');
          if (input.fcm.enabled !== undefined) {
            check(typeof input.fcm.enabled === 'boolean', 400, 'FCM 开关无效');
            currentFcm.enabled = input.fcm.enabled;
          }
          if (input.fcm.serviceAccount !== undefined && input.fcm.serviceAccount !== '') {
            const parsed = parseFcmServiceAccount(input.fcm.serviceAccount);
            Object.assign(currentFcm, parsed);
          }
          if (currentFcm.enabled) {
            check(currentFcm.projectId && currentFcm.clientEmail && currentFcm.privateKey, 400, '启用 FCM 需要完整的 Firebase 服务账号 JSON');
          }
          next.fcm = currentFcm;
        }
      }

      Object.keys(current).forEach(key => delete current[key]);
      Object.assign(current, next);
    });
    return this.publicConfig();
  }
}

export function normalizeOptionalHttpUrl(input, label = 'URL') {
  check(typeof input === 'string' && input.length <= 2048, 400, `${label}无效`);
  const trimmed = input.trim();
  if (!trimmed) return '';
  let url;
  try { url = new URL(trimmed); } catch { check(false, 400, `${label}无效`); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search,
    400, `${label}需要不含凭据的 HTTP(S) 地址`);
  return url.href.replace(/\/$/, '');
}

export function normalizeBarkIconUrl(input) {
  check(typeof input === 'string' && input.length <= 2048, 400, 'Bark 图标地址无效');
  if (!input.trim()) return '';
  let url;
  try { url = new URL(input.trim()); } catch { check(false, 400, 'Bark 图标地址无效'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash,
    400, 'Bark 图标需要不含凭据的 HTTP(S) 地址');
  return url.href;
}

/** Accept the complete command copied from Bark, or its URL. Never execute it. */
export function parseBarkLink(input) {
  check(typeof input === 'string' && input.length <= 4096, 400, '请输入 Bark 推送链接');
  const match = input.trim().match(/https?:\/\/[^\s"'<>`]+/i);
  check(match, 400, '未找到 Bark 的 HTTP(S) 链接');
  let url;
  try { url = new URL(match[0]); } catch { check(false, 400, 'Bark 链接无效'); }
  check(!url.username && !url.password && !url.hash, 400, 'Bark 链接不能包含登录信息或片段');
  assertPublicPushUrl(url, 'Bark 链接');
  let segments;
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { check(false, 400, 'Bark 链接路径无效'); }
  const queryKey = url.searchParams.get('device_key');
  const key = queryKey || segments[0];
  check(typeof key === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(key), 400, '无法识别 Bark Key，请复制应用提供的完整推送链接');
  const prefix = queryKey ? url.pathname.replace(/\/push\/?$/, '').replace(/\/$/, '') : '';
  return { endpoint: `${url.origin}${prefix}/push`, key, host: url.host };
}

export function parseNtfyUrl(input) {
  check(typeof input === 'string' && input.length <= 2048, 400, '请输入有效的 ntfy 主题地址');
  let url;
  try { url = new URL(input.trim()); } catch { check(false, 400, 'ntfy 地址无效'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash,
    400, 'ntfy 地址必须是 HTTP(S) 且不含用户名或片段');
  assertPublicPushUrl(url, 'ntfy 地址');
  const cleanPath = url.pathname.replace(/\/+$/, '');
  const slash = cleanPath.lastIndexOf('/');
  const topic = slash >= 0 ? cleanPath.slice(slash + 1) : '';
  check(/^[A-Za-z0-9_.-]{1,128}$/.test(topic), 400, 'ntfy 地址末尾需要包含有效的主题名');
  const basePath = slash > 0 ? cleanPath.slice(0, slash) : '';
  return {
    url: `${url.origin}${cleanPath}`,
    baseUrl: `${url.origin}${basePath || '/'}`,
    topic,
    host: url.host,
  };
}

export function parsePushEndpoint(input, label = '推送端点') {
  check(typeof input === 'string' && input.length <= 2048, 400, `${label}无效`);
  let url;
  try { url = new URL(input.trim()); } catch { check(false, 400, `${label}无效`); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash,
    400, `${label}必须是 HTTP(S) 地址`);
  assertPublicPushUrl(url, label);
  return { endpoint: url.href, host: url.host };
}

export function parseFcmServiceAccount(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    check(raw.length <= 32768, 400, 'Firebase 服务账号文件过大');
    try { obj = JSON.parse(raw); } catch { check(false, 400, '无法解析 Firebase 服务账号 JSON'); }
  }
  check(obj && typeof obj === 'object' && !Array.isArray(obj), 400, 'Firebase 服务账号格式无效');
  const projectId = obj.projectId ?? obj.project_id;
  const clientEmail = obj.clientEmail ?? obj.client_email;
  const privateKey = obj.privateKey ?? obj.private_key;
  check(typeof projectId === 'string' && /^[A-Za-z0-9-]{4,128}$/.test(projectId), 400, 'Firebase project_id 无效');
  check(typeof clientEmail === 'string' && /^[^@\s]+@[^@\s]+$/.test(clientEmail), 400, 'Firebase client_email 无效');
  check(typeof privateKey === 'string' && privateKey.length <= 16384, 400, 'Firebase private_key 无效');
  let key;
  try { key = createPrivateKey(privateKey.trim()); } catch { check(false, 400, '无法读取 Firebase RSA 私钥'); }
  check(key.asymmetricKeyType === 'rsa', 400, 'Firebase 服务账号私钥必须是 RSA 密钥');
  return { projectId, clientEmail, privateKey: privateKey.trim() };
}
