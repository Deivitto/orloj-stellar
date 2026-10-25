import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyManagedConfig } from "../lib/session/zeroclaw-config.ts";
test("native tool wire mode preserves the exact permission boundary and rejects invalid configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orloj-patch-")),
    bin = join(dir, "patch.mjs"),
    file = join(dir, "patch.json"),
    keys = [
      "ZEROCLAW_BIN",
      "ZEROCLAW_CONTEXT_TOKENS",
      "ORLOJ_PRODUCT",
      "ZEROCLAW_NATIVE_TOOLS",
      "ZEROCLAW_REPLAY_REASONING",
      "ZEROCLAW_MODEL_API_KEY",
      "ZEROCLAW_MODEL_URL",
      "ZEROCLAW_MODEL",
    ],
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    await writeFile(
      bin,
      `#!/usr/bin/env node\nimport{writeFile}from'node:fs/promises';let s='';for await(const c of process.stdin)s+=c;await writeFile(${JSON.stringify(file)},s);`,
    );
    await chmod(bin, 0o700);
    Object.assign(process.env, {
      ZEROCLAW_BIN: bin,
      ORLOJ_PRODUCT: "stellar",
      ZEROCLAW_NATIVE_TOOLS: "true",
      ZEROCLAW_REPLAY_REASONING: "false",
    });
    delete process.env.ZEROCLAW_CONTEXT_TOKENS;
    delete process.env.ZEROCLAW_MODEL_API_KEY;
    delete process.env.ZEROCLAW_MODEL_URL;
    delete process.env.ZEROCLAW_MODEL;
    await applyManagedConfig(dir, ["XLM__balance"]);
    const ops = JSON.parse(await readFile(file, "utf8")),
      at = (path) => ops.find((o) => o.path === path)?.value;
    assert.equal(at("/providers/models/custom/default/native_tools"), true);
    assert.equal(at("/providers/models/custom/default/max_tokens"), 2048);
    assert.equal(at("/agents/default/runtime_profile"), "orloj_stellar");
    assert.equal(at("/runtime_profiles/orloj_stellar/max_context_tokens"), 4000);
    assert.equal(at("/runtime_profiles/orloj_stellar/compact_context"), true);
    assert.equal(at("/runtime_profiles/orloj_stellar/single_tool_rounds"), false);
    process.env.ZEROCLAW_CONTEXT_TOKENS = "0";
    await assert.rejects(applyManagedConfig(dir, []), /ZEROCLAW_CONTEXT_TOKENS/);
    delete process.env.ZEROCLAW_CONTEXT_TOKENS;
    assert.equal(
      at("/providers/models/custom/default/replay_assistant_reasoning"),
      false,
    );
    assert.equal(at("/risk_profiles/yolo/level"), "supervised");
    assert.deepEqual(at("/risk_profiles/yolo/allowed_tools"), ["XLM__balance"]);
    assert.deepEqual(at("/risk_profiles/yolo/allowed_commands"), []);
    assert.ok(at("/risk_profiles/yolo/excluded_tools").includes("file_read"));
    process.env.ZEROCLAW_NATIVE_TOOLS = "invalid";
    await assert.rejects(applyManagedConfig(dir, []), /must be true or false/);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
});
