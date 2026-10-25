import { createServer } from "node:http";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
const execute = promisify(execFile),
  token = readFileSync(process.env.RUNTIME_TOKEN_FILE, "utf8").trim();
if (token.length < 32) throw new Error("Runtime credential unavailable");
const equal = (s) =>
  typeof s === "string" &&
  s.length === token.length &&
  timingSafeEqual(Buffer.from(s), Buffer.from(token));
const project = process.env.AGENT_VOLUME ?? "orloj-agent-state",
  image = process.env.RUNTIME_IMAGE ?? "orloj-zeroclaw:0.8.6";
const orphans = execFileSync(
  "docker",
  ["ps", "-aq", "--filter", `label=orloj.runtime=${project}`],
  { encoding: "utf8" },
)
  .trim()
  .split(/\s+/)
  .filter(Boolean);
if (orphans.length)
  execFileSync("docker", ["rm", "-f", ...orphans], { stdio: "ignore" });
const running = new Map();
const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.end("ok");
    return;
  }
  const id = req.headers["x-orloj-agent"],
    action = req.headers["x-orloj-action"],
    instance = req.headers["x-orloj-instance"];
  const uuid = (s) =>
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
  if (
    req.method !== "POST" ||
    req.url !== "/run" ||
    !equal(req.headers["x-orloj-runtime"]) ||
    !uuid(id) ||
    !uuid(instance) ||
    !["patch", "acp"].includes(action)
  ) {
    res.writeHead(403);
    res.end();
    return;
  }
  while (running.has(id)) {
    const previous = running.get(id);
    if (action !== "patch") {
      res.writeHead(409);
      res.end();
      return;
    }
    previous.cancel();
    await previous.done;
  }
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let child,
    cid,
    aborted = false,
    finished = false,
    deadline;
  const job = {
    done,
    cancel: () => {
      aborted = true;
      child?.kill("SIGTERM");
    },
  };
  running.set(id, job);
  const cleanup = async (code = 1) => {
    if (finished) return;
    finished = true;
    if (deadline) clearTimeout(deadline);
    req.unpipe();
    child?.stdin.destroy();
    if (cid) await execute("docker", ["rm", "-f", cid]).catch(() => {});
    if (running.get(id) === job) running.delete(id);
    resolveDone();
    if (!res.destroyed) {
      if (!res.headersSent)
        res.writeHead(code === 0 ? 200 : 503, {
          "content-type": "application/octet-stream",
        });
      else res.addTrailers({ "x-runtime-exit": String(code) });
      res.end();
    }
  };
  req.on("aborted", () => job.cancel());
  res.on("close", () => {
    if (!finished) job.cancel();
  });
  try {
    // Remove only this broker's stale agent container. No container is cleaned by a reusable name.
    const stale = (
      await execute("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=orloj.runtime=${project}`,
        "--filter",
        `label=orloj.agent=${id}`,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (stale.length) await execute("docker", ["rm", "-f", ...stale]);
    const args = [
      "create",
      "--name",
      `orloj-runtime-${id}`,
      "--label",
      `orloj.runtime=${project}`,
      "--label",
      `orloj.agent=${id}`,
      "--label",
      `orloj.instance=${instance}`,
      "-i",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=1g",
      "--cpus=1",
      "--user=1000:1000",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs=/home/agent:rw,nosuid,size=16m,uid=1000,gid=1000",
      `--network=${action === "acp" ? (process.env.AGENT_NETWORK ?? "orloj-agents") : "none"}`,
      "--mount",
      `type=volume,src=${project},dst=/agents/${id},volume-subpath=${id}`,
      "--workdir",
      `/agents/${id}`,
      image,
      ...(action === "patch"
        ? ["config", "patch", "--config-dir", `/agents/${id}`, "-"]
        : [
            "acp",
            "--config-dir",
            `/agents/${id}`,
            "--max-sessions",
            "1",
            "--session-timeout",
            "3600",
          ]),
    ];
    cid = (await execute("docker", args)).stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(cid)) throw new Error("Runtime creation failed");
    if (aborted) {
      await cleanup();
      return;
    }
    child = spawn("docker", ["start", "-ai", cid], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST },
    });
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      trailer: "x-runtime-exit",
    });
    req.pipe(child.stdin);
    child.stdout.pipe(res, { end: false });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.once("error", () => void cleanup());
    child.once("exit", (code) => void cleanup(code ?? 1));
    deadline = setTimeout(() => job.cancel(), 3600000);
    deadline.unref();
  } catch {
    await cleanup();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 10000;
server.listen(3010, "0.0.0.0");
