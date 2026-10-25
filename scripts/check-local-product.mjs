// Run in the app environment; never prints credentials or configuration values.
import { readFile } from "node:fs/promises";
const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch {
    checks.push({ name, ok: false });
  }
};
await check("app_secret", async () => {
  if ((process.env.BETTER_AUTH_SECRET ?? "").length < 32) throw Error();
});
await check("freighter_origin", async () => {
  const url = new URL(process.env.BETTER_AUTH_URL);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw Error();
});
await check("control_credential", async () => {
  if (
    (await readFile(process.env.CONTROL_TOKEN_FILE, "utf8")).trim().length < 32
  )
    throw Error();
});
await check("registry_migrations_network_protocol_signer", async () => {
  const r = await fetch(new URL("/readyz", process.env.STELLAR_REGISTRY_URL), {
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error();
});
await check("development_mailbox", async () => {
  const r = await fetch(
    new URL("/api/v1/info", process.env.LOCAL_MAILBOX_URL),
    { signal: AbortSignal.timeout(5000) },
  );
  if (!r.ok) throw Error();
});
if (process.env.REQUIRE_CHAT === "true") {
  await check("model_configuration", async () => {
    if (!process.env.ZEROCLAW_MODEL_API_KEY || !process.env.ZEROCLAW_MODEL)
      throw Error();
    new URL(process.env.ZEROCLAW_MODEL_URL);
  });
  await check("isolated_runtime_broker", async () => {
    if (
      (await readFile(process.env.RUNTIME_TOKEN_FILE, "utf8")).trim().length <
      32
    )
      throw Error();
    const r = await fetch(new URL("/healthz", process.env.RUNTIME_BROKER_URL), {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw Error();
  });
}
console.log(
  JSON.stringify(
    {
      ok: checks.every((c) => c.ok),
      checks,
      chat:
        process.env.REQUIRE_CHAT === "true"
          ? "configuration_checked_live_prompt_still_required"
          : "deferred",
    },
    null,
    2,
  ),
);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
