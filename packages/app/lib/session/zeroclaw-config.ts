import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

// Captured once at module load rather than read per call: `next dev`, `next start`, a
// standalone build and a process manager do not all agree on cwd, and a template path that
// silently misses is a 503 on every first session. Prefer absolute paths in production.
const APP_ROOT = process.cwd();

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_ALIAS = "default";

export class InvalidAgentIdError extends Error {
  constructor(agentId: string) {
    super(`Invalid agent id: ${JSON.stringify(agentId)}`);
    this.name = "InvalidAgentIdError";
  }
}

export class TemplateUnavailableError extends Error {
  constructor(templatePath: string, cause?: unknown) {
    super(`zeroclaw template config unreadable at ${templatePath}`);
    this.name = "TemplateUnavailableError";
    this.cause = cause;
  }
}

export class ZeroclawBinaryMissingError extends Error {
  constructor(bin: string) {
    super(`zeroclaw binary not found: ${bin}`);
    this.name = "ZeroclawBinaryMissingError";
  }
}

const resolveFromAppRoot = (p: string): string =>
  path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p);

export const runtimeEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    [
      "PATH",
      "LANG",
      "TMPDIR",
      "NODE_ENV",
      "RUNTIME_BROKER_URL",
      "RUNTIME_TOKEN_FILE",
    ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
  ) as NodeJS.ProcessEnv;
export const zeroclawBin = (): string => process.env.ZEROCLAW_BIN || "zeroclaw";

const agentsRoot = (): string =>
  resolveFromAppRoot(process.env.ZEROCLAW_AGENTS_DIR || ".zeroclaw/agents");

const templateConfigPath = (): string =>
  path.join(
    resolveFromAppRoot(
      process.env.ZEROCLAW_TEMPLATE_DIR || "../zeroclaw-agents/default",
    ),
    "config.toml",
  );

// The model provider key. Never in the template — that file is tracked in a public repo — so
// it is patched into each provisioned config instead.
const modelApiKey = (): string | undefined =>
  process.env.ZEROCLAW_MODEL_API_KEY || undefined;

const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const sessionTimeoutSecs = (): number =>
  intEnv("ZEROCLAW_SESSION_TIMEOUT_SECS", 3600);

export const idleTimeoutMs = (): number =>
  intEnv("ZEROCLAW_IDLE_TIMEOUT_MS", 1_800_000);

// The single place an agent id is validated before it becomes a path segment or an argv
// slot. Pure — it creates nothing, because `GET /api/agents/[id]/mcps` and `killByAgent`
// both need the path without provisioning.
export const agentDir = (agentId: string): string => {
  if (!AGENT_ID_RE.test(agentId)) throw new InvalidAgentIdError(agentId);
  return path.join(agentsRoot(), agentId);
};

// The agent's working dir. Never the config dir: that holds the provider key, the agent's
// bearer token, and the managed block the agent could otherwise rewrite with its own tools.
export const agentWorkspaceDir = (agentId: string): string =>
  path.join(agentDir(agentId), "agents", AGENT_ALIAS, "workspace");

// zeroclaw creates data/, agents/<alias>/workspace/ and shared/ itself — but only after a
// session exists, and `session/new` rejects a cwd that is not already a directory
// (`-32602 cwd is not a usable directory`). So we create the workspace ourselves before
// every spawn: idempotent, and it also repairs a dir provisioned by an older build.
export const ensureWorkspaceDir = async (agentId: string): Promise<string> => {
  const dir = agentWorkspaceDir(agentId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
};

// The bundle every orloj-installed skill lives in.
export const SKILL_BUNDLE = "orloj";

// Where an agent's skills are installed. NOT `<workspace>/skills`, which is the obvious
// choice and is wrong: when no skill bundle is configured, `zeroclaw skills list` silently
// MOVES `agents/<alias>/workspace/skills/<name>` out to `shared/skills/<name>` and then does
// not load it. Probed against the real binary — a skill installed into the workspace vanished
// from under us between two commands.
//
// A configured bundle is the only arrangement that both loads the skill and leaves it where
// it was put. `zeroclaw skills bundle add` requires the directory to resolve inside
// `<install>/shared/`, so that is where it goes.
export const skillsDir = (agentId: string): string =>
  path.join(agentDir(agentId), "shared", "skills", SKILL_BUNDLE);

// Content-addressed and shared by every agent: the key IS the 0G Merkle root, so two agents
// installing the same skill cannot collide and a hit needs no re-verification.
export const skillsCacheDir = (): string =>
  resolveFromAppRoot(
    process.env.ZG_SKILLS_CACHE_DIR ||
      path.join(agentsRoot(), "..", "skills-cache"),
  );

export const configDirExists = async (agentId: string): Promise<boolean> => {
  try {
    await access(agentDir(agentId));
    return true;
  } catch {
    return false;
  }
};

// The directory's existence is the create flag. Built in a temp sibling and renamed so an
// interrupted setup cannot leave a dir the existence check would read as provisioned.
export const provisionConfigDir = async (
  agentId: string,
  ownership?: { userId: string; instanceId: string },
): Promise<{ dir: string; created: boolean }> => {
  const dir = agentDir(agentId);
  if (await configDirExists(agentId)) {
    if (!ownership) return { dir, created: false };
    let matches = false;
    try {
      const stamp = JSON.parse(
        await readFile(path.join(dir, ".orloj-owner.json"), "utf8"),
      );
      matches =
        stamp.userId === ownership.userId &&
        stamp.instanceId === ownership.instanceId;
    } catch {}
    if (matches) return { dir, created: false };
    await rename(dir, `${dir}.retired-${Date.now()}`);
  }

  const template = templateConfigPath();
  try {
    await access(template);
  } catch (err) {
    throw new TemplateUnavailableError(template, err);
  }

  const root = agentsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(root, `.tmp-${agentId}-`));
  try {
    // Only config.toml. A recursive copy would clone the template's accumulated state —
    // memory, cost logs, an open SQLite session DB with live -wal/-shm — into every agent.
    // zeroclaw creates data/, agents/<alias>/workspace/ and shared/ itself on first run.
    await copyFile(template, path.join(staging, "config.toml"));
    await chmod(path.join(staging, "config.toml"), 0o600);
    if (ownership)
      await writeFile(
        path.join(staging, ".orloj-owner.json"),
        JSON.stringify(ownership),
        { mode: 0o600 },
      );
    await chmod(staging, 0o700);
    await rename(staging, dir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    // A racing provisioner won: treat the dir as pre-existing rather than failing.
    if (
      (err as NodeJS.ErrnoException).code === "ENOTEMPTY" &&
      (await configDirExists(agentId))
    ) {
      return { dir, created: false };
    }
    throw err;
  }
  return { dir, created: true };
};

export const removeConfigDir = async (agentId: string): Promise<void> => {
  await rm(agentDir(agentId), { recursive: true, force: true });
};

const runZeroclaw = (args: string[], stdin?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(zeroclawBin(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: runtimeEnvironment(),
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (err += c));
    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(
        e.code === "ENOENT" ? new ZeroclawBinaryMissingError(zeroclawBin()) : e,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `zeroclaw ${args[0]} exited ${code}: ${err.trim() || out.trim()}`,
          ),
        );
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

// Called AFTER the managed block is written: `config patch` re-validates the whole config, and
// the `mcp_bundles = ["remote"]` grant in the template is dangling until the block defines the
// bundle. Run on every start, not just on create, so rotating ZEROCLAW_MODEL_API_KEY reaches
// agents that already have a config dir — the key lives above the managed marker, so
// writeMcpSelection alone would never refresh it.
//
// It doubles as the config's only parse check, which is why it is not conditional. zeroclaw
// does not fail a malformed config — `acp` resets the WHOLE config to defaults for the run,
// warns on stderr, and then rejects session/new with `Unknown agent default — no
// [agents.default] entry configured`, naming a symptom three steps from the typo. `config
// patch` refuses to write an unparseable config and exits non-zero with the TOML error and
// line number, so the same defect surfaces here instead, before anything spawns.
export const applyManagedConfig = async (
  dir: string,
  approvedTools: string[] = [],
): Promise<void> => {
  const ops: Array<{ op: string; path: string; value: unknown }> = [
    { op: "add", path: "/agents/default/acp_enable_mcp", value: true },
    // Registers the skills bundle. Written on every start, not just on create, so agents
    // provisioned before skills existed repair themselves. `add` is idempotent here.
    //
    // Skills cannot simply be dropped in the workspace: with no bundle configured, zeroclaw
    // relocates `<workspace>/skills/<name>` to `shared/skills/<name>` and stops loading it.
    // The directory is relative to the install root and must resolve inside `shared/`.
    {
      op: "add",
      path: `/skill_bundles/${SKILL_BUNDLE}/directory`,
      value: `shared/skills/${SKILL_BUNDLE}`,
    },
    { op: "add", path: "/agents/default/skill_bundles", value: [SKILL_BUNDLE] },
  ];
  if (process.env.ORLOJ_PRODUCT === "stellar") {
    ops.push(
      { op: "add", path: "/risk_profiles/yolo/level", value: "supervised" },
      {
        op: "add",
        path: "/risk_profiles/yolo/allowed_tools",
        value: approvedTools,
      },
      {
        op: "add",
        path: "/risk_profiles/yolo/deny_all_tools",
        value: approvedTools.length === 0,
      },
      { op: "add", path: "/risk_profiles/yolo/always_ask", value: [] },
      { op: "add", path: "/agents/default/skill_bundles", value: [] },
    );
    ops.push(
      { op: "add", path: "/risk_profiles/yolo/allowed_commands", value: [] },
      {
        op: "add",
        path: "/risk_profiles/yolo/auto_approve",
        value: approvedTools,
      },
      { op: "add", path: "/risk_profiles/yolo/workspace_only", value: true },
      { op: "add", path: "/risk_profiles/yolo/sandbox_enabled", value: true },
      {
        op: "add",
        path: "/risk_profiles/yolo/block_high_risk_commands",
        value: true,
      },
      {
        op: "add",
        path: "/risk_profiles/yolo/excluded_tools",
        value: [
          "shell",
          "file_read",
          "file_write",
          "file_edit",
          "browser_open",
          "http_request",
          "spawn_subagent",
        ],
      },
    );
  }
  if (process.env.ZEROCLAW_MODEL_URL)
    ops.push({
      op: "add",
      path: "/providers/models/custom/default/uri",
      value: process.env.ZEROCLAW_MODEL_URL,
    });
  if (process.env.ZEROCLAW_MODEL)
    ops.push({
      op: "add",
      path: "/providers/models/custom/default/model",
      value: process.env.ZEROCLAW_MODEL,
    });
  for (const [setting, field] of [
    ["ZEROCLAW_NATIVE_TOOLS", "native_tools"],
    ["ZEROCLAW_REPLAY_REASONING", "replay_assistant_reasoning"],
  ]) {
    const value = process.env[setting];
    if (value) {
      if (!["true", "false"].includes(value))
        throw new Error(`${setting} must be true or false`);
      ops.push({
        op: "add",
        path: `/providers/models/custom/default/${field}`,
        value: value === "true",
      });
    }
  }
  const key = modelApiKey();
  // Omitted rather than written as "" when unset: an empty patch value would overwrite a key
  // an operator had set by hand in the config dir.
  if (key) {
    ops.push({
      op: "add",
      path: "/providers/models/custom/default/api_key",
      value: key,
    });
  }
  await runZeroclaw(
    ["config", "patch", "--config-dir", dir, "-"],
    JSON.stringify(ops),
  );
};
