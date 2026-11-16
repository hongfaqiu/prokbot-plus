import assert from 'node:assert/strict';
import test from 'node:test';
import { Auth } from '../server/auth.mjs';
import { PushService } from '../server/push-service.mjs';
import { PushTransports } from '../server/push-transports.mjs';
import {
  isPublicPushHost,
  parseBarkLink,
  parseNtfyUrl,
  parsePushEndpoint,
} from '../server/push-config.mjs';

const BLOCKED_HOSTS = [
  'http://127.0.0.1',
  'http://127.0.1.1:8080',
  'http://127.1',
  'http://0177.0.0.1',
  'http://2130706433',
  'http://0x7f000001',
  'http://127.0.0.1.',
  'http://0.0.0.0',
  'http://0',
  'http://[::1]:8080',
  'http://[0:0:0:0:0:0:0:1]',
  'http://[::]',
  'http://169.254.169.254',
  'http://169.254.0.1',
  'http://[fe80::1]',
  'http://10.0.0.1',
  'http://172.16.0.1',
  'http://172.31.255.254',
  'http://192.168.1.1',
  'http://100.64.0.1',
  'http://100.127.255.254',
  'http://[fc00::1]',
  'http://[fd00::1]',
  'http://[fd7a:115c:a1e0::1]',
  'http://[::ffff:127.0.0.1]',
  'http://[::ffff:169.254.169.254]',
  'http://[64:ff9b::127.0.0.1]',
  'http://[2002:7f00:1::1]',
  'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]',
  'http://[2001:2::1]',
  'http://[2001:10::1]',
  'http://[::ffff:0:127.0.0.1]',
  'http://[3fff::1]',
  'http://[5f00::1]',
  'http://224.0.0.1',
  'http://255.255.255.255',
  'http://[ff02::1]',
  'http://localhost',
  'http://localhost.:3000',
  'http://api.localhost',
  'http://nas.local',
  'http://metadata.google.internal',
  'http://host.docker.internal',
  'http://metadata.goog',
  'http://home.arpa',
  'http://metadata',
  'http://redis:6379',
];

function assertRejectsSsrf(fn) {
  assert.throws(fn, err => err?.status === 400);
}

test('isPublicPushHost blocks loopback, link-local, private, and internal hostnames while allowing public targets', () => {
  for (const origin of BLOCKED_HOSTS) {
    const hostname = new URL(origin).hostname;
    assert.equal(isPublicPushHost(hostname), false, `expected blocked host: ${origin}`);
  }
  for (const rawHost of [
    '127.1',
    '0177.0.0.1',
    '0x7f.0.0.1',
    '169.254.43518',
    '192.168.1',
    '10.1',
    'ｌｏｃａｌｈｏｓｔ',
    '127.0.0.1:8080',
    'api.day.app/path',
    'user@api.day.app',
    '[fe80::1%eth0]',
    '2001:0::1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPublicPushHost(rawHost), false, `expected direct isPublicPushHost block: ${rawHost}`);
  }
  for (const allowed of [
    'api.day.app',
    'ntfy.sh',
    'push.example.com',
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '[2606:4700:4700::1111]',
    '2606:4700:4700::1111',
  ]) {
    assert.equal(isPublicPushHost(allowed), true, `expected allowed host: ${allowed}`);
  }
});

test('parseBarkLink, parseNtfyUrl, and parsePushEndpoint reject SSRF hosts with HTTP 400', () => {
  for (const origin of BLOCKED_HOSTS) {
    assertRejectsSsrf(() => parseBarkLink(`${origin}/barkkey12345/title/body`));
    assertRejectsSsrf(() => parseBarkLink(`curl -X POST "${origin}/push?device_key=barkkey12345"`));
    assertRejectsSsrf(() => parseNtfyUrl(`${origin}/grokbot-topic`));
    assertRejectsSsrf(() => parsePushEndpoint(`${origin}/up/endpoint-1`, 'UnifiedPush 端点'));
    assertRejectsSsrf(() => parsePushEndpoint(`${origin}/webhook`, 'Webhook 地址'));
  }

  assert.deepEqual(parseBarkLink('https://api.day.app/barkkey12345/Hello'), {
    endpoint: 'https://api.day.app/push',
    key: 'barkkey12345',
    host: 'api.day.app',
  });
  assert.deepEqual(parseNtfyUrl('https://ntfy.sh/grokbot-topic'), {
    url: 'https://ntfy.sh/grokbot-topic',
    baseUrl: 'https://ntfy.sh/',
    topic: 'grokbot-topic',
    host: 'ntfy.sh',
  });
  assert.deepEqual(parsePushEndpoint('https://[2606:4700:4700::1111]:8443/hook', 'Webhook 地址'), {
    endpoint: 'https://[2606:4700:4700::1111]:8443/hook',
    host: '[2606:4700:4700::1111]:8443',
  });
});

test('PushService.register rejects SSRF push endpoints submitted by paired devices', async () => {
  const auth = new Auth('.');
  auth.store.value = structuredClone(auth.store.initial);
  auth.store.mutate = async update => update(auth.store.value);

  const push = new PushService('.', auth, { transports: new PushTransports() });
  push.store.value = structuredClone(push.store.initial);
  push.store.mutate = async update => update(push.store.value);
  push.config.store.value = structuredClone(push.config.store.initial);
  push.config.store.mutate = async update => update(push.config.store.value);

  const { pairingKey } = await auth.createPairing();
  const { deviceId } = await auth.pair({ platform: 'ios', deviceName: 'Test Phone', pairingKey });

  await assert.rejects(
    () => push.register(deviceId, { push: { provider: 'bark', barkUrl: 'http://169.254.169.254/latest/meta-data/barkkey1234' } }),
    err => err?.status === 400,
  );
  await assert.rejects(
    () => push.register(deviceId, { push: { provider: 'ntfy', ntfyUrl: 'http://127.0.0.1:8080/secret-topic' } }),
    err => err?.status === 400,
  );
  await assert.rejects(
    () => push.register(deviceId, { push: { provider: 'unifiedpush', endpoint: 'http://[::1]:9000/up' } }),
    err => err?.status === 400,
  );
  await assert.rejects(
    () => push.register(deviceId, { push: { provider: 'webhook', webhookUrl: 'http://10.0.0.5/internal-hook' } }),
    err => err?.status === 400,
  );
});
