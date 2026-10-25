// Optional host-side app/MCP development. Agent execution still requires the isolated broker.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(".local"),
  read = async (file) =>
    (await readFile(resolve(root, "secrets", file), "utf8")).trim();
const vars = Object.fromEntries(
  (await readFile(resolve(root, "product.env"), "utf8"))
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const n = l.indexOf("=");
      return [l.slice(0, n), l.slice(n + 1)];
    }),
);
const database =
  process.env.LOCAL_PRODUCT_DATABASE_URL ??
  "postgres://joker@127.0.0.1:55432/orloj_local_product";
const shared = { DATABASE_URL: database, DATABASE_SSL: "false" };
const app = {
  ...shared,
  BETTER_AUTH_SECRET: await read("auth"),
  BETTER_AUTH_URL: "http://localhost:3000",
  LOCAL_MAILBOX_URL: "http://127.0.0.1:8025",
  ORLOJ_PRODUCT: "stellar",
  AGENT_PROVIDER: "local",
  STELLAR_REGISTRY_URL: "http://127.0.0.1:3002",
  PUBLIC_STELLAR_REGISTRY_URL: "http://localhost:3002",
  CONTROL_TOKEN_FILE: resolve(root, "secrets/control"),
  ZEROCLAW_BIN: resolve("infra/local/runtime-launcher.mjs"),
  ZEROCLAW_AGENTS_DIR: resolve(root, "agents"),
  ZEROCLAW_MODEL_API_KEY: vars.ZEROCLAW_MODEL_API_KEY ?? "",
  ZEROCLAW_MODEL_URL: vars.ZEROCLAW_MODEL_URL,
  ZEROCLAW_MODEL: vars.ZEROCLAW_MODEL,
  RUNTIME_BROKER_URL: "http://127.0.0.1:3010",
  RUNTIME_TOKEN_FILE: resolve(root, "secrets/runtime"),
};
const registry = {
  ...shared,
  SIMULATION_SOURCE: vars.SIMULATION_SOURCE,
  PRODUCT_MODE: "true",
  WRITE_MODE: "true",
  MAX_FEE: "2000000",
  CONTROL_TOKEN_FILE: resolve(root, "secrets/control"),
  SIGNER_TOKEN_FILE: resolve(root, "secrets/signer"),
  SIGNER_URL: "http://127.0.0.1:3005",
  APP_ORIGIN: "http://localhost:3000",
  PORT: "3002",
};
const signer = {
  ...shared,
  SIGNER_MASTER_KEY_FILE: resolve(root, "secrets/master"),
  SIGNER_TOKEN_FILE: resolve(root, "secrets/signer"),
  PORT: "3005",
};
for (const [name, env] of Object.entries({ app, registry, signer }))
  await writeFile(
    resolve(root, `${name}.env`),
    Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
console.log(
  "Native app/MCP environment files prepared in .local/. Chat execution remains broker-isolated.",
);
