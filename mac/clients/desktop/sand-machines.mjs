/**
 * Builds the `getSandMachines` roster from Host `GET /local/computers`, merging the
 * local machine entry (when running on Desktop) with all other connected computers.
 */
export async function fetchSandMachines({ request, signal, currentMachine = null } = {}) {
  const fallback = currentMachine ? [currentMachine] : [];
  if (typeof request !== 'function') {
    return { machines: fallback, currentMachineRemoved: false };
  }
  try {
    const data = await request('/local/computers', null, signal, 'GET');
    const byId = new Map();
    if (currentMachine?.machineId) {
      byId.set(currentMachine.machineId, { ...currentMachine });
    }
    const items = Array.isArray(data?.computers) ? data.computers : [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      const existing = byId.get(item.id);
      const isCurrent = Boolean(existing?.isCurrent || (currentMachine?.machineId && item.id === currentMachine.machineId));
      const connected = item.connected === true;
      const label = (typeof item.label === 'string' && item.label.trim()) || existing?.label || item.id;
      byId.set(item.id, {
        ...(existing ?? {}),
        machineId: item.id,
        name: label,
        label,
        platform: item.platform ?? existing?.platform ?? 'darwin',
        isCurrent,
        connected,
        isOnline: existing?.isOnline ?? connected,
        capabilities: Array.isArray(item.capabilities) ? item.capabilities : existing?.capabilities ?? [],
        localToolPermission: existing?.localToolPermission ?? 'ask',
        ...(connected ? { lastRegisteredAtMs: existing?.lastRegisteredAtMs ?? Date.now() } : {}),
      });
    }
    return { machines: [...byId.values()], currentMachineRemoved: false };
  } catch {
    return { machines: fallback, currentMachineRemoved: false };
  }
}
