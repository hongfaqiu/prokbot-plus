import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { internalCredential } from "./credentials.mjs";

export async function checkDeploymentHealth(env = process.env) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${env.GROKBOT_PORT || 8000}/healthz`,
      {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      },
    );
    if (!response.ok || !(await response.json()).ok) return false;
    const data = env.GROKBOT_DATA_DIR ?? "/data";
    const model = await readFile(
      env.GROKBOT_MODEL_ENV ?? join(data, "model.env"),
      "utf8",
    ).catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    // An unconfigured installation is healthy when its setup page is available.
    if (
      !/^OPENAI_BASE_URL=.+$/m.test(model) ||
      !/^OPENAI_API_KEY=.+$/m.test(model) ||
      !/^OPENAI_MODEL=.+$/m.test(model)
    )
      return true;
    // HostSupervisor intentionally waits for the execution node on split installations.
    if (env.GROKBOT_REQUIRE_EXECUTION_NODE === '1') {
      const state = await readFile(join(data, 'execution-node.json'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (state === null) return true;
      const saved = JSON.parse(state);
      if (saved?.version !== 1 || typeof saved.config?.enabled !== 'boolean') return false;
      if (!saved.config.enabled) return true;
    }
    const token = await internalCredential(
      env.GROKBOT_INTERNAL_HOST_TOKEN_FILE ?? join(data, "internal-host-token"),
    );
    const host = await fetch(
      new URL(
        "/health",
        env.GROKBOT_INTERNAL_HOST_URL ?? "http://127.0.0.1:1340",
      ),
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      },
    );
    return host.ok && (await host.json()).ok === true;
  } catch {
    return false;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = (await checkDeploymentHealth()) ? 0 : 1;
}
