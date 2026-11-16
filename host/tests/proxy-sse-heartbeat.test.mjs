import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { proxyHttp } from '../server/proxy.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve(new URL(`http://127.0.0.1:${addr.port}`));
  }));
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('proxyHttp injects SSE keepalive comments on idle /events streams and passes upstream pings/rewrites', async t => {
  let upstreamRes = null;
  let upstreamClosed = false;

  const upstream = http.createServer((req, res) => {
    if (req.url === '/events') {
      upstreamRes = res;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'content-length': '9999',
        'etag': '"should-strip"',
      });
      res.write('retry: 1000\n\n');
      res.on('close', () => { upstreamClosed = true; });
    }
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxy = http.createServer((req, res) => {
    proxyHttp(req, res, {
      target: upstreamUrl,
      path: req.url,
      sseKeepaliveMs: 40,
      rewrite: value => ({ ...value, rewritten: true }),
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(() => closeServer(proxy));

  const controller = new AbortController();
  const response = await fetch(new URL('/events', proxyUrl), { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('etag'), null);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';

  const readUntil = async (predicate, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(received)) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, `timed out waiting for SSE chunk; received so far:\n${received}`);
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), remaining)),
      ]);
      assert.equal(done, false);
      received += decoder.decode(value, { stream: true });
    }
  };

  await readUntil(text => text.includes('retry: 1000\n\n') && text.includes(': heartbeat\n\n'));
  upstreamRes.write(':ping\n\n');
  upstreamRes.write('data: {"hello":"world"}\n\n');
  await readUntil(text => text.includes(':ping\n\n') && text.includes('data: {"hello":"world","rewritten":true}\n\n'));

  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 20 && !upstreamClosed; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(upstreamClosed, true);
});

test('proxyHttp does not inject keepalive inside an incomplete SSE frame when rewrite is omitted', async t => {
  let upstreamRes = null;

  const upstream = http.createServer((_req, res) => {
    upstreamRes = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"partial":');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxy = http.createServer((req, res) => {
    proxyHttp(req, res, {
      target: upstreamUrl,
      path: req.url,
      sseKeepaliveMs: 35,
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(() => closeServer(proxy));

  const controller = new AbortController();
  const response = await fetch(new URL('/events', proxyUrl), { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';

  // Wait longer than sseKeepaliveMs (35ms) while frame is incomplete.
  const first = await reader.read();
  received += decoder.decode(first.value, { stream: true });
  await new Promise(r => setTimeout(r, 80));

  upstreamRes.write('true}\n\n');

  const deadline = Date.now() + 1500;
  while (!received.includes(': heartbeat\n\n')) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, `expected heartbeat after frame completed; got:\n${received}`);
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), remaining)),
    ]);
    assert.equal(done, false);
    received += decoder.decode(value, { stream: true });
  }

  assert.ok(received.startsWith('data: {"partial":true}\n\n'));
  assert.ok(!received.slice(0, received.indexOf('true}\n\n')).includes(': heartbeat'));

  controller.abort();
  await reader.cancel().catch(() => {});
});

test('proxyHttp resets sseKeepalive idle timer on upstream pings without emitting redundant heartbeats', async t => {
  let pingTimer = null;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('retry: 1000\n\n');
    pingTimer = setInterval(() => res.write(':ping\n\n'), 25);
    res.on('close', () => {
      clearInterval(pingTimer);
      pingTimer = null;
    });
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => {
    clearInterval(pingTimer);
    return closeServer(upstream);
  });

  const proxy = http.createServer((req, res) => {
    proxyHttp(req, res, {
      target: upstreamUrl,
      path: req.url,
      sseKeepaliveMs: 70,
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(() => closeServer(proxy));

  const controller = new AbortController();
  const response = await fetch(new URL('/events', proxyUrl), { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';

  const deadline = Date.now() + 1500;
  while ((received.match(/:ping\n\n/g) ?? []).length < 3) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, `timed out waiting for 3 upstream pings; got:\n${received}`);
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), remaining)),
    ]);
    assert.equal(done, false);
    received += decoder.decode(value, { stream: true });
  }

  assert.equal(received.includes(': heartbeat\n\n'), false);

  controller.abort();
  await reader.cancel().catch(() => {});
});

test('proxyHttp skips SSE keepalive on HEAD, non-2xx, gzip-encoded streams, and invalid Infinity intervals', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/head') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
    } else if (req.url === '/error') {
      res.writeHead(502, { 'content-type': 'text/event-stream' });
      res.write('data: {"error":true}\n\n');
    } else if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
      res.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    } else if (req.url === '/infinity') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('retry: 1000\n\n');
    }
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxy = http.createServer((req, res) => {
    proxyHttp(req, res, {
      target: upstreamUrl,
      path: req.url,
      sseKeepaliveMs: req.url === '/infinity' ? Infinity : 25,
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(() => closeServer(proxy));

  const headRes = await fetch(new URL('/head', proxyUrl), { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(await headRes.text(), '');

  for (const [route, expectedHeader] of [
    ['/error', null],
    ['/gzip', 'gzip'],
    ['/infinity', null],
  ]) {
    const controller = new AbortController();
    const res = await fetch(new URL(route, proxyUrl), { signal: controller.signal });
    if (expectedHeader) assert.equal(res.headers.get('content-encoding'), expectedHeader);
    const reader = res.body.getReader();
    let collected = Buffer.alloc(0);
    const deadline = Date.now() + 65;
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise(r => setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now()))),
      ]);
      if (result.timeout || result.done) break;
      collected = Buffer.concat([collected, Buffer.from(result.value)]);
    }
    assert.equal(collected.toString('utf8').includes(': heartbeat\n\n'), false, `unexpected heartbeat on ${route}`);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test('proxyHttp handles split multi-byte UTF-8 SSE frames without premature keepalive', async t => {
  let upstreamRes = null;
  const upstream = http.createServer((_req, res) => {
    upstreamRes = res;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const full = Buffer.from('data: {"msg":"你好世界"}\r\n\r\n', 'utf8');
    // Split right in the middle of the 3-byte UTF-8 character '好'
    const splitAt = full.indexOf(Buffer.from('好', 'utf8')) + 1;
    res.write(full.subarray(0, splitAt));
    setTimeout(() => {
      upstreamRes.write(full.subarray(splitAt));
    }, 60);
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => closeServer(upstream));

  const proxy = http.createServer((req, res) => {
    proxyHttp(req, res, {
      target: upstreamUrl,
      path: req.url,
      sseKeepaliveMs: 25,
    });
  });
  const proxyUrl = await listen(proxy);
  t.after(() => closeServer(proxy));

  const controller = new AbortController();
  const res = await fetch(new URL('/events', proxyUrl), { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = '';

  const deadline = Date.now() + 1500;
  while (!received.includes(': heartbeat\n\n')) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, `timed out waiting for UTF-8 frame + heartbeat; got:\n${received}`);
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('read timeout')), remaining)),
    ]);
    assert.equal(done, false);
    received += decoder.decode(value, { stream: true });
  }

  assert.ok(received.startsWith('data: {"msg":"你好世界"}\r\n\r\n: heartbeat\n\n'));

  controller.abort();
  await reader.cancel().catch(() => {});
});

