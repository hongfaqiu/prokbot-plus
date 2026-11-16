import assert from 'node:assert/strict';
import test from 'node:test';
import { Auth } from '../server/auth.mjs';

test('concurrent requests share the last-seen write, retry I/O failure, and respect revocation', async () => {
  const auth = new Auth('.');
  auth.store.value = { devices: [{ id: 'device', lastSeenAt: new Date(0).toISOString() }] };
  let writes = 0, permit, failure = true;
  auth.store.mutate = async f => {
    writes++;
    await new Promise(r => { permit = r; });
    if (failure) throw new Error('I/O failure');
    f(auth.store.value);
  };
  const batch = Promise.allSettled(Array.from({ length: 100 }, () => auth.touch('device')));
  assert.equal(writes, 1);
  permit(); assert.ok((await batch).every(s => s.status === 'rejected'));
  failure = false;
  const retry = auth.touch('device'); permit(); await retry;
  await auth.touch('device'); assert.equal(writes, 2);
  auth.store.value.devices[0].lastSeenAt = new Date(0).toISOString();
  const pending = auth.touch('device'); auth.store.value.devices[0].revokedAt = 'revoked';
  permit(); await pending;
  assert.equal(auth.store.value.devices[0].lastSeenAt, new Date(0).toISOString());
});
