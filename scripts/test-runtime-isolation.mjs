// Real pinned-runtime lifecycle smoke. Never sends a model prompt.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  writeFile,
  copyFile,
  appendFile,
  readFile,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { request } from "node:http";
import assert from "node:assert/strict";
await mkdir(resolve(".local"), { recursive: true, mode: 0o700 });
const run = promisify(execFile),
  dir = await mkdtemp(resolve(".local/runtime-smoke-"));
const id = randomUUID(),
  instance = randomUUID(),
  volume = "orloj-smoke-" + randomUUID(),
  network = "orloj-smoke-" + randomUUID(),
  token = randomBytes(32).toString("hex");
let broker;
const docker = async (...args) =>
  (await run("docker", args, { timeout: 180000 })).stdout.trim();
const call = (action, input, hold = false) =>
  new Promise((resolve, reject) => {
    const req = request(
      "http://127.0.0.1:3010/run",
      {
        method: "POST",
        headers: {
          "x-orloj-runtime": token,
          "x-orloj-agent": id,
          "x-orloj-instance": instance,
          "x-orloj-action": action,
        },
      },
      (res) => {
        let output = "";
        res.on("data", (c) => {
          output += c;
          if (hold && output.includes('"id":1')) resolve({ req, res, output });
        });
        res.on("end", () => {
          if (!hold)
            resolve({
              status: res.statusCode,
              output,
              exit: res.trailers["x-runtime-exit"],
            });
          else if (!output.includes('"id":1'))
            reject(new Error("ACP initialization failed"));
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("Runtime timeout")));
    req.write(input);
    if (!hold) req.end();
  });
try {
  await writeFile(join(dir, "token"), token, { mode: 0o600 });
  await copyFile(
    "packages/zeroclaw-agents/default/config.toml",
    join(dir, "config.toml"),
  );
  await appendFile(
    join(dir, "config.toml"),
    "\n[mcp_bundles.remote]\nservers = []\n",
  );
  await docker("volume", "create", volume);
  await docker("network", "create", network);
  await docker(
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    `${volume}:/agents`,
    "-v",
    `${dir}:/seed:ro`,
    "--entrypoint",
    "/bin/sh",
    "node:24.15.0-bookworm-slim",
    "-c",
    `set -e; mkdir /agents/${id}; cp /seed/config.toml /agents/${id}/config.toml; chown -R 1000:1000 /agents/${id}; chmod 755 /agents/${id}`,
  );
  await writeFile(
    join(dir, "broker.mjs"),
    (await readFile("infra/local/runtime-broker.mjs", "utf8")).replace(
      'child.stderr.on("data", () => {});',
      'child.stderr.on("data", c => process.stderr.write(c));',
    ),
  );
  broker = spawn(process.execPath, [join(dir, "broker.mjs")], {
    env: {
      ...process.env,
      RUNTIME_TOKEN_FILE: join(dir, "token"),
      AGENT_VOLUME: volume,
      AGENT_NETWORK: network,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch("http://127.0.0.1:3010/healthz")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  let patch = await call("patch", "[]");
  assert.equal(patch.status, 200);
  assert.equal(patch.exit, "0");
  const acp = await call(
    "acp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "orloj-isolation-smoke", version: "1" },
      },
    }) + "\n",
    true,
  );
  const cid = await docker(
    "ps",
    "-q",
    "--filter",
    `label=orloj.runtime=${volume}`,
  );
  assert(cid);
  const info = JSON.parse(await docker("inspect", cid))[0];
  assert.equal(info.Config.User, "1000:1000");
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
  assert.equal(info.HostConfig.NetworkMode, network);
  assert.equal(info.Mounts.length, 1);
  assert.equal(info.Mounts[0].Name, volume);
  assert.equal(info.Mounts[0].Destination, `/agents/${id}`);
  assert(
    !JSON.stringify(info.Config.Env).match(
      /DATABASE_URL|SIGNER_|CONTROL_TOKEN|MASTER_KEY/,
    ),
  );
  acp.req.destroy();
  acp.res.destroy();
  // Patch must await ACP container removal; immediate subsequent ACP must survive old cleanup.
  patch = await call("patch", "[]");
  assert.equal(patch.exit, "0");
  const again = await call(
    "acp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + "\n",
    true,
  );
  again.req.destroy();
  again.res.destroy();
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "real_runtime_patch",
        "acp_initialize",
        "nonroot_readonly_capabilities",
        "per_agent_volume",
        "no_application_secrets",
        "disconnect_patch_restart",
      ],
      runtime: "0.8.6",
    }),
  );
} finally {
  broker?.kill("SIGTERM");
  const ids = await docker(
    "ps",
    "-aq",
    "--filter",
    `label=orloj.runtime=${volume}`,
  ).catch(() => "");
  if (ids) await docker("rm", "-f", ...ids.split(/\s+/));
  await docker("volume", "rm", volume).catch(() => {});
  await docker("network", "rm", network).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
