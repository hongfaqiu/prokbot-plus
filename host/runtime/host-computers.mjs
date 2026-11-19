const patchedRawBridges = new WeakSet();

function patchRawLocalExecBridge(bridge, defaultMachineId) {
  if (!bridge || typeof bridge.resolveProvider !== 'function' || typeof bridge.requireProvider !== 'function') {
    return false;
  }
  if (patchedRawBridges.has(bridge)) return true;
  patchedRawBridges.add(bridge);

  const origResolveProvider = bridge.resolveProvider.bind(bridge);
  const origRequireProvider = bridge.requireProvider.bind(bridge);
  const origRouteLabel = typeof bridge.routeLabel === 'function' ? bridge.routeLabel.bind(bridge) : undefined;
  const origGetProviderInfo = typeof bridge.getProviderInfo === 'function' ? bridge.getProviderInfo.bind(bridge) : undefined;

  bridge.resolveProvider = function resolveProvider(computerId, live) {
    if (computerId === undefined && defaultMachineId !== undefined) {
      const preferred = origResolveProvider(defaultMachineId, live);
      if (preferred !== undefined) return preferred;
    }
    return origResolveProvider(computerId, live);
  };

  bridge.requireProvider = function requireProvider(computerId, gate, allowImplicitSelection = false) {
    if (computerId === undefined) {
      if (defaultMachineId !== undefined) {
        const live = gate?.site === 'messages-op'
          ? bridge.liveProviders().filter(provider => provider.messagesOp === true)
          : bridge.liveProviders();
        const preferred = origResolveProvider(defaultMachineId, live);
        if (preferred !== undefined) return preferred;
        return origRequireProvider(undefined, gate, true);
      }
      return origRequireProvider(undefined, gate, false);
    }
    return origRequireProvider(computerId, gate, allowImplicitSelection);
  };

  if (origRouteLabel) {
    bridge.routeLabel = function routeLabel(computerId) {
      if (computerId === undefined && defaultMachineId !== undefined && bridge.hasComputerId?.(defaultMachineId)) {
        return origRouteLabel(defaultMachineId);
      }
      return origRouteLabel(computerId);
    };
  }

  if (origGetProviderInfo) {
    bridge.getProviderInfo = function getProviderInfo(computerId) {
      if (computerId === undefined && defaultMachineId !== undefined && bridge.hasComputerId?.(defaultMachineId)) {
        return origGetProviderInfo(defaultMachineId);
      }
      return origGetProviderInfo(computerId);
    };
  }

  return true;
}

/**
 * Pin implicit (unspecified machineId) local-exec routing to a configured default machine,
 * and disallow silent random selection when multiple machines exist without a default.
 * Works with both the SandLocalExecBridge instance and the local-exec extension facade
 * returned by host.getLocalExecBridge().
 */
export function installDefaultMachineRouting(localExec, rawDefaultMachineId) {
  const defaultMachineId = typeof rawDefaultMachineId === 'string' && rawDefaultMachineId.trim().length > 0
    ? rawDefaultMachineId.trim()
    : undefined;
  if (!localExec) return defaultMachineId;

  if (patchRawLocalExecBridge(localExec, defaultMachineId)) {
    return defaultMachineId;
  }

  let rawPatched = false;
  const origResolve = localExec.userComputers?.resolve?.bind(localExec.userComputers);
  const ensureRawBridgePatched = () => {
    if (rawPatched) return true;
    try {
      const list = localExec.userComputers?.list?.() ?? [];
      for (const computer of list) {
        const resolved = origResolve?.(computer.id);
        const rawBridge = resolved?.box?.bridge;
        if (rawBridge && patchRawLocalExecBridge(rawBridge, defaultMachineId)) {
          rawPatched = true;
          return true;
        }
      }
    } catch {
      // Ignore until a provider registers.
    }
    return false;
  };

  if (localExec.userComputers && typeof origResolve === 'function') {
    localExec.userComputers.resolve = function resolve(id, scope) {
      ensureRawBridgePatched();
      if (id === undefined && defaultMachineId !== undefined) {
        const preferred = origResolve(defaultMachineId, scope);
        if (preferred !== undefined) return preferred;
      }
      return origResolve(id, scope);
    };
  }

  if (typeof localExec.registerProvider === 'function') {
    const origRegister = localExec.registerProvider.bind(localExec);
    localExec.registerProvider = function registerProvider(sendFrame) {
      const unregister = origRegister(sendFrame);
      ensureRawBridgePatched();
      return unregister;
    };
  }

  if (typeof localExec.submitResponses === 'function') {
    const origSubmit = localExec.submitResponses.bind(localExec);
    localExec.submitResponses = function submitResponses(batch) {
      const result = origSubmit(batch);
      ensureRawBridgePatched();
      return result;
    };
  }

  if (localExec.box && typeof localExec.box.ensureReady === 'function') {
    const origEnsureReady = localExec.box.ensureReady.bind(localExec.box);
    localExec.box.ensureReady = async function ensureReady(ctx, agentId) {
      ensureRawBridgePatched();
      const ready = await origEnsureReady(ctx, agentId);
      const rawBridge = ready?.remoteAccessor?.execManager?.bridge;
      if (rawBridge) {
        rawPatched = patchRawLocalExecBridge(rawBridge, defaultMachineId) || rawPatched;
      }
      return ready;
    };
  }

  ensureRawBridgePatched();
  return defaultMachineId;
}

/** Report the original bridge's registered/live machines to its parent process. */
export function observeHostComputers(bridge, { send, intervalMs = 5000 } = {}) {
  if (!send && !process.send) return { bridge, close() {} };
  send ??= value => {
    if (process.connected) process.send(value, () => {});
  };
  const publish = () => {
    try {
      const computers = bridge.userComputers.list().map(({ id, label, connected }) => ({
        id, label, connected: connected === true,
        platform: id.startsWith('mac-') ? 'darwin' : id.startsWith('win-') ? 'win32' : 'unknown',
        capabilities: ['exec', 'files'],
      }));
      send({ type: 'local-computers', available: true, computers });
    } catch {
      send({ type: 'local-computers', available: false, computers: [] });
    }
  };
  const timer = setInterval(publish, intervalMs);
  timer.unref();
  publish();
  return {
    bridge: {
      ...bridge,
      registerProvider(sendFrame) {
        const unregister = bridge.registerProvider(sendFrame);
        publish();
        return () => { unregister(); publish(); };
      },
      submitResponses(batch) {
        const result = bridge.submitResponses(batch);
        publish();
        return result;
      },
    },
    close() {
      clearInterval(timer);
      send({ type: 'local-computers', available: false, computers: [] });
    },
  };
}
