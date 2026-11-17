import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client/compat.js', import.meta.url), 'utf8');

// The built-ins the interface calls without checking, as an older WebView lacks them.
const REMOVE = `
  for (const name of ['at', 'findLast', 'findLastIndex', 'toReversed', 'toSorted', 'toSpliced', 'with']) delete Array.prototype[name];
  delete String.prototype.at;
  const typed = Object.getPrototypeOf(Int8Array.prototype);
  for (const name of ['at', 'findLast', 'findLastIndex', 'toReversed', 'toSorted', 'with']) delete typed[name];
  delete Object.hasOwn; delete Promise.withResolvers; delete Promise.try; delete Error.isError; delete globalThis.structuredClone;
`;

function oldWebView({ userAgent = 'Mozilla/5.0 (Linux; Android 12) Chrome/95.0.4638.74 Mobile Safari/537.36', boot } = {}) {
  const context = vm.createContext({});
  vm.runInContext(REMOVE, context);
  // URL without the static helpers; crypto with getRandomValues only.
  context.NodeURL = URL;
  context.getRandomValues = array => crypto.getRandomValues(array);
  vm.runInContext(`
    globalThis.URL = function URL(url, base) { return arguments.length > 1 ? new NodeURL(url, base) : new NodeURL(url); };
    class Crypto { getRandomValues(array) { return getRandomValues(array); } }
    globalThis.crypto = new Crypto();
  `, context);
  context.navigator = { userAgent, language: 'en-US' };
  if (boot) context.__grokbotAndroidBoot = boot;
  vm.runInContext(source, context, { filename: 'compat.js' });
  return context;
}

test('an older WebView receives the built-ins the interface calls, with native results', () => {
  const context = oldWebView();
  const run = code => vm.runInContext(code, context);
  assert.deepEqual(run('JSON.stringify([[1, 2, 3].at(-1), [1, 2, 3].at(5), "abc".at(-1), new Uint8Array([4, 5]).at(-2)])'), '[3,null,"c",4]');
  assert.equal(run('[1, 2, 3, 4].findLast(n => n % 2)'), 3);
  assert.equal(run('[1, 2, 3, 4].findLastIndex(n => n > 9)'), -1);
  assert.equal(run('new Int16Array([1, 8, 3]).findLast(n => n > 2)'), 3);
  assert.equal(run('const a = [3, 1, 2]; JSON.stringify([a.toSorted(), a.toReversed(), a.toSpliced(1, 1, 9, 9), a.with(-1, 0), a])'),
    '[[1,2,3],[2,1,3],[3,9,9,2],[3,1,0],[3,1,2]]');
  assert.equal(run('JSON.stringify([, 1].toSorted())'), '[1,null]');
  assert.throws(() => run('[1].with(1, 0)'), /Invalid index/);
  assert.throws(() => run('[1].toSorted(1)'), /comparison function/);
  assert.equal(run('Array.from(new Uint8Array([3, 1, 2]).toSorted()).join()'), '1,2,3');
  assert.equal(run('Object.hasOwn({ a: 1 }, "a") && !Object.hasOwn(Object.create({ a: 1 }), "a")'), true);
  assert.throws(() => run('Object.hasOwn(null, "a")'), { name: 'TypeError' });
  assert.equal(run('JSON.stringify([URL.canParse("https://a.example/x"), URL.canParse("nope"), URL.canParse("x", "https://a.example/"), URL.parse("nope")])'),
    '[true,false,true,null]');
  assert.equal(run('URL.parse("/p", "https://a.example/").href'), 'https://a.example/p');
  assert.equal(run('Error.isError(new TypeError("x")) && !Error.isError({ message: "x" })'), true);
  assert.match(run('crypto.randomUUID()'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(run('crypto.randomUUID()'), run('crypto.randomUUID()'));
  // Enumerable properties would show up in for-in loops over arrays.
  assert.equal(run('Object.keys(Array.prototype).length + Object.keys(Object).length'), 0);
});

test('promise helpers and structured cloning behave like the native versions', async () => {
  const context = oldWebView();
  const run = code => vm.runInContext(code, context);
  assert.equal(await run('(() => { const { promise, resolve } = Promise.withResolvers(); resolve(7); return promise; })()'), 7);
  assert.equal(await run('Promise.try((a, b) => a + b, 2, 3)'), 5);
  await assert.rejects(run('Promise.try(() => { throw new RangeError("sync") })'), /sync/);
  const cloned = run(`(() => {
    const shared = { n: 1 };
    const value = { shared, again: shared, list: [1, , 'x'], when: new Date(5), re: /a/gi, map: new Map([[shared, 'v']]),
      set: new Set([shared]), bytes: new Uint8Array([1, 2]), error: new TypeError('bad', { cause: 'c' }) };
    value.self = value;
    const copy = structuredClone(value);
    return { copy, ok: [copy !== value, copy.self === copy, copy.shared === copy.again, copy.shared !== shared,
      copy.map.keys().next().value === copy.shared, copy.set.has(copy.shared), copy.when.getTime() === 5,
      copy.re.flags === 'gi', copy.bytes[1] === 2, copy.bytes.buffer !== value.bytes.buffer,
      copy.error instanceof TypeError, copy.error.message === 'bad', copy.error.cause === 'c', !(1 in copy.list)] };
  })()`);
  assert.deepEqual([...cloned.ok], Array(14).fill(true));
  assert.throws(() => run('structuredClone({ f() {} })'), /could not be cloned/);
  assert.throws(() => run('structuredClone(Symbol())'), /could not be cloned/);
});

test('moveBefore falls back to insertBefore, and a native one stays', () => {
  const dom = `
    globalThis.Element = class Element { insertBefore(node, child) { this.moved = [node, child]; return node; } };
    globalThis.DocumentFragment = class DocumentFragment { insertBefore(node) { return node; } };
    globalThis.Document = class Document { insertBefore(node) { return node; } };`;
  const context = vm.createContext({ navigator: { userAgent: 'Chrome/124.0.0.0', language: 'en' }, URL, crypto, structuredClone });
  vm.runInContext(dom, context);
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('const parent = new Element(), node = {}; parent.moveBefore(node, null) === node && parent.moved[0] === node && parent.moved[1] === null', context), true);
  assert.deepEqual([...vm.runInContext('__grokbotCompat.added', context)],
    ['Element.prototype.moveBefore', 'DocumentFragment.prototype.moveBefore', 'Document.prototype.moveBefore']);

  const current = vm.createContext({ navigator: { userAgent: 'Chrome/134.0.0.0', language: 'en' }, URL, crypto, structuredClone });
  vm.runInContext(dom + 'globalThis.native = Element.prototype.moveBefore = function moveBefore() {};', current);
  vm.runInContext(source, current);
  assert.equal(vm.runInContext('Element.prototype.moveBefore === native && __grokbotCompat.added.length', current), 0);
});

test('a current WebView keeps every native built-in', () => {
  const context = vm.createContext({ navigator: { userAgent: 'Chrome/134.0.0.0', language: 'en' },
    URL, crypto, structuredClone });
  const natives = vm.runInContext('[Array.prototype.at, Object.hasOwn, Promise.withResolvers, Error.isError]', context);
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('__grokbotCompat.added.length', context), 0);
  const after = vm.runInContext('[Array.prototype.at, Object.hasOwn, Promise.withResolvers, Error.isError]', context);
  assert.ok(natives.every((value, index) => value === after[index]));
  assert.equal(vm.runInContext('URL.canParse', context), URL.canParse);
});

test('the startup explanation names the WebView version and what to update', () => {
  const tooOld = oldWebView({ userAgent: 'Mozilla/5.0 (Linux; Android 11) Chrome/83.0.4103.106 Mobile', boot: { locale: 'zh-CN', appVersion: '1.1.0', sdk: 30 } });
  const compat = tooOld.__grokbotCompat;
  assert.equal(compat.chromium, 83);
  assert.match(compat.explanation()[0], /Chromium 83，太旧.*WebView 89 或更高版本/);
  assert.match(compat.explanation()[1], /卓易通/);
  assert.match(compat.details()[0], /Android 1\.1\.0 · Android SDK 30 · WebView Chromium 83/);
  const older = oldWebView({ boot: { locale: 'en' } }).__grokbotCompat;
  assert.equal(older.chromium, 95);
  assert.deepEqual([...older.explanation()], ['The interface failed while starting, so the page stayed blank.',
    'This device\'s WebView is Chromium 95; updating to 111 or later is recommended.']);
});

test('compat overlay triggers even when root becomes blank after initial mount', () => {
  const listeners = new Map();
  let overlayShown = null;
  let rootNode;
  const fakeElement = (id = '') => ({
    id,
    tagName: 'DIV',
    style: { cssText: '' },
    children: [],
    childElementCount: 0,
    firstChild: null,
    firstElementChild: null,
    parentNode: null,
    textContent: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      this.firstChild = this.children[0] ?? null;
      this.firstElementChild = this.children[0] ?? null;
      this.childElementCount = this.children.length;
      if (child.id === 'grokbot-compat-message') overlayShown = child;
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      child.parentNode = null;
      this.firstChild = this.children[0] ?? null;
      this.firstElementChild = this.children[0] ?? null;
      this.childElementCount = this.children.length;
      if (child === overlayShown) overlayShown = null;
    },
    addEventListener() {},
  });
  rootNode = fakeElement('root');
  const inner = fakeElement();
  inner.appendChild(fakeElement());
  rootNode.appendChild(inner);
  const body = fakeElement('body');
  const timers = [];
  const context = vm.createContext({
    navigator: { userAgent: 'Chrome/134.0.0.0', language: 'zh-CN' },
    __grokbotAndroidBoot: { locale: 'zh-CN' },
    setTimeout(fn, delay) { const h = { fn, delay, cleared: false }; timers.push(h); return h; },
    clearTimeout(h) { if (h) h.cleared = true; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {},
    document: {
      readyState: 'complete',
      body,
      getElementById: id => id === 'root' ? rootNode : null,
      createElement: () => fakeElement(),
    },
  });
  context.window = context;
  vm.runInContext(source, context, { filename: 'compat.js' });

  // Initial check sees mounted #root (non-empty) and clears any overlay.
  const initialTimer = timers.find(t => !t.cleared);
  assert.ok(initialTimer && initialTimer.delay <= 10000);
  initialTimer.fn();
  assert.equal(overlayShown, null);

  // Later #root becomes empty with a silent crash (no recent error within 10s).
  rootNode.children.length = 0;
  rootNode.firstChild = null;
  rootNode.firstElementChild = null;
  listeners.get('securitypolicyviolation')?.({ violatedDirective: 'script-src', blockedURI: 'inline' });
  const pending = timers.filter(t => !t.cleared).pop();
  assert.ok(pending);
  pending.fn();
  assert.ok(overlayShown);
  assert.match(context.__grokbotCompat.errors[0], /CSP blocked script-src inline/);
});

test('a slow start shows a quiet connecting note, reports failure only after a long wait, and clears itself when content appears', () => {
  function environment() {
    let now = 1_000_000;
    const fakeElement = (id = '') => ({
      id, tagName: 'DIV', style: { cssText: '' }, children: [], firstChild: null, firstElementChild: null, parentNode: null,
      textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(child) {
        child.parentNode = this; this.children.push(child);
        this.firstChild = this.firstElementChild = this.children[0];
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        this.firstChild = this.firstElementChild = this.children[0] ?? null;
      },
      addEventListener() {},
    });
    const rootNode = fakeElement('root'), inner = fakeElement(), body = fakeElement('body');
    rootNode.appendChild(inner);
    const timers = [];
    let poll = null;
    const context = vm.createContext({
      navigator: { userAgent: 'Chrome/157.0.0.0', language: 'zh-CN' },
      __grokbotAndroidBoot: { locale: 'zh-CN' },
      Date: { now: () => now },
      setTimeout(fn, delay) { const h = { fn, delay, cleared: false }; timers.push(h); return h; },
      clearTimeout(h) { if (h) h.cleared = true; },
      setInterval(fn) { poll = fn; return 1; },
      addEventListener() {}, removeEventListener() {},
      document: { readyState: 'complete', body, getElementById: id => (id === 'root' ? rootNode : null), createElement: () => fakeElement() },
    });
    context.window = context;
    vm.runInContext(source, context, { filename: 'compat.js' });
    const tick = () => {
      const pending = timers.filter(h => !h.cleared).pop();
      if (pending) { pending.cleared = true; pending.fn(); } else poll();
    };
    const shown = () => body.children.map(child => child.id);
    return { inner, fakeElement, tick, shown, advance: ms => { now += ms; } };
  }

  const slow = environment();
  slow.advance(1000); slow.tick();
  assert.deepEqual(slow.shown(), []);
  slow.advance(3000); slow.tick();
  assert.deepEqual(slow.shown(), ['grokbot-compat-splash']);
  slow.advance(12000); slow.tick();
  assert.deepEqual(slow.shown(), ['grokbot-compat-splash']);
  // The interface paints inside the single child of #root: nothing about #root itself changes.
  slow.inner.appendChild(slow.fakeElement());
  slow.advance(1000); slow.tick();
  assert.deepEqual(slow.shown(), []);

  const stuck = environment();
  stuck.advance(4000); stuck.tick();
  assert.deepEqual(stuck.shown(), ['grokbot-compat-splash']);
  stuck.advance(30000); stuck.tick();
  assert.deepEqual(stuck.shown(), ['grokbot-compat-message']);
  stuck.inner.appendChild(stuck.fakeElement());
  stuck.advance(1000); stuck.tick();
  assert.deepEqual(stuck.shown(), []);
});
