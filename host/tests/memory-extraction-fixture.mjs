import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createModelSession } from '../runtime/model-session.mjs';
import { constructRecoveredHostFlow, installRecoveredHostFlow } from '../runtime/recovered-host-flow.mjs';

// A project-owned factory and text-only consumer so CI needs no generated Host files.
export function createRecoveredModule({ runTurnMemory }) { return { finishMemory: runTurnMemory }; }

async function textOnlyTurn(store, _progress, session, ctx, _time, exchange) {
  if (store.recordMemoryEvidence) return store.recordMemoryEvidence(exchange);
  try {
    const executor = session.getExecutor();
    executor.appendMessages({ role: 'user', content: exchange.user });
    const parts = await Array.fromAsync(executor.stream(ctx).fullStream);
    store.addMemory(parts.filter(part => part.type === 'text-delta').map(part => part.textDelta).join(''));
  } catch { /* The upstream collector treats extraction as best effort. */ }
}

// Like the Host usage middleware, expose new promises *after* the adapter guarded its own.
const derived = ['response', 'usage', 'extendedUsage'];
function withDerivedResults(session) {
  return { getExecutor() {
    const executor = session.getExecutor();
    return {
      appendMessages: messages => executor.appendMessages(messages),
      stream(...args) {
        const result = executor.stream(...args);
        return { ...result, ...Object.fromEntries(derived.map(key => [key, result[key].then(value => value)])) };
      },
    };
  } };
}

const chunk = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const completion = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function resetReply() {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk('incomplete fact'))); },
    pull(controller) {
      const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      controller.error(new TypeError('private provider detail', { cause }));
    },
  }, { highWaterMark: 0 }));
}

export async function exerciseMemory(finishTurn, sanitize, mode) {
  let requests = 0;
  const saved = [];
  const store = { recall: () => ({ profile: [], recent: [] }), listMemories: () => [],
    addMemory: content => saved.push(content) };
  const session = sanitize(createModelSession({ model: 'memory-test', baseUrl: 'https://model.invalid/v1',
    async fetchImpl() {
      requests++;
      if (mode === 'unrelated') {
        void Promise.reject(new Error('unrelated rejection during memory extraction'));
        await tick();
      }
      return requests === 2 ? new Response(chunk('fact from next turn') + completion) : resetReply();
    },
  }));
  await finishTurn(store, session);
  await tick(); // Allow Node to detect any unread, rejected completion promises.
  assert.deepEqual(saved, []);
  assert.equal(requests, 1);
  await finishTurn(store, session);
  await tick();
  assert.deepEqual(saved, ['fact from next turn']);
  assert.equal(requests, 2);

  // The shared session must still deliver a foreground failure to every consumer.
  const foreground = session.getExecutor().stream({});
  const outcomes = Promise.allSettled(derived.map(key => foreground[key]));
  let foregroundError;
  await assert.rejects(Array.fromAsync(foreground.fullStream), error => {
    foregroundError = error;
    return error.cause?.code === 'ECONNRESET';
  });
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.reason, foregroundError);
  }
  const evidenceError = new Error('evidence store failed');
  await assert.rejects(finishTurn({ recordMemoryEvidence() { throw evidenceError; } }, session),
    error => error === evidenceError);
  assert.equal(requests, 3);
  console.log('next memory saved; foreground and evidence errors preserved');
}

export async function run(mode, seed) {
  if (seed) {
    // Optional read-only check with the user's generated bindings, factory and native dependencies.
    const library = createRequire(import.meta.url)(resolve(seed, 'host-library.cjs'));
    await installRecoveredHostFlow(library, join(seed, 'release-reliability'));
    const { createTurnSettle, sanitizePromptSessionUsage } = library.getHarnessRecoveryBindings();
    return exerciseMemory(async (memoryStore, session) => {
      const settle = createTurnSettle({ latestPromptMessages: () => [], isRunSuperseded: () => false }, { memoryStore });
      settle.collectors.collectText('completed chat reply');
      await settle.settleCompletedTurn({ session, baseCtx: library.createContext(), finalState: { turnTimings: [] },
        turnStartedAtMs: Date.now(), trimmedPrompt: 'Please remember my preference.', skipLabeling: true });
      assert.equal(settle.buildResult({ aborted: false }).text, 'completed chat reply');
    }, sanitizePromptSessionUsage, mode);
  }
  const filename = fileURLToPath(import.meta.url);
  const dependencies = ['runTurnMemory'];
  const library = {
    getHostFlowRecoveryBindings: () => ({ runTurnMemory: textOnlyTurn }),
    hostFlowRecoveryPlan: { modules: [{ name: basename(filename), exports: ['finishMemory'],
      dependencies, originalDependencies: dependencies, recoveredDependencies: [] }] },
  };
  const { bindings } = await constructRecoveredHostFlow(library, dirname(filename));
  await exerciseMemory((store, session) => bindings.finishMemory(store, null, session, {}, Date.now(),
    { user: 'Please remember my preference.', agent: 'Noted.' }), withDerivedResults, mode);
}
