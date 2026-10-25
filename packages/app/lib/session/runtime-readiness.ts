/** A missing isolated runtime must fail before writing or replacing an agent's configuration. */
export class RuntimeUnavailableError extends Error {
  constructor() {
    super("The isolated agent runtime is unavailable.");
  }
}
export async function assertRuntimeReady(env: NodeJS.ProcessEnv = process.env) {
  if (env.ORLOJ_PRODUCT !== "stellar") return;
  if (!env.RUNTIME_BROKER_URL || !env.RUNTIME_TOKEN_FILE)
    throw new RuntimeUnavailableError();
  try {
    const response = await fetch(new URL("/healthz", env.RUNTIME_BROKER_URL), {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.text()) !== "ok")
      throw new RuntimeUnavailableError();
  } catch {
    throw new RuntimeUnavailableError();
  }
}
