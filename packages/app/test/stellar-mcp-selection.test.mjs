import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMcpSelection,
  readMcpSelection,
} from "../lib/session/mcp-block.ts";
test("reconstructs both classic Stellar selections after sidecar loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orloj-classic-selection-"));
  try {
    await writeFile(join(dir, "config.toml"), "# human configuration\n");
    const entries = ["stellar-dex", "stellar-amm"].map((name) => ({
      mcpName: "stellar_testnet_classic_" + name,
      serverName: "stellar_" + name,
      url:
        "http://127.0.0.1:3002/contracts/classic:" +
        name +
        "/mcp?client=zeroclaw",
      bearerToken: "test-only-token",
    }));
    await writeMcpSelection(dir, entries);
    await rm(join(dir, "orloj-mcps.json"));
    assert.deepEqual(
      await readMcpSelection(dir),
      entries.map(({ mcpName, serverName }) => ({ mcpName, serverName })),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
