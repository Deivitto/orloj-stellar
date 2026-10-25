import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeMcpSelection,
  readMcpSelection,
} from "../lib/session/mcp-block.ts";
test("Stellar and EVM selections survive a missing sidecar and preserve their server names", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "orloj-selection-"));
  const id = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  try {
    await writeFile(path.join(dir, "config.toml"), "schema_version = 3\n");
    const selected = await writeMcpSelection(dir, [
      {
        mcpName: `stellar_testnet_${id}`,
        serverName: "XLM",
        url: `http://registry:3002/contracts/${id}/mcp`,
        bearerToken: "test-token",
      },
      {
        mcpName: "1_0x123",
        serverName: "Legacy",
        url: "http://evm:3001/interface/1_0x123/mcp",
        bearerToken: "test-token",
      },
    ]);
    await rm(path.join(dir, "orloj-mcps.json"));
    assert.deepEqual(await readMcpSelection(dir), selected);
    assert.deepEqual(await readMcpSelection(dir), selected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
