import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMcpServers } from "../lib/session/mcp-servers.ts";
test("runtime routing preserves control discovery and does not redirect EVM", async () => {
  const saved = {
      REGISTRY_URL: process.env.REGISTRY_URL,
      STELLAR_REGISTRY_URL: process.env.STELLAR_REGISTRY_URL,
      STELLAR_RUNTIME_REGISTRY_URL: process.env.STELLAR_RUNTIME_REGISTRY_URL,
    },
    original = globalThis.fetch,
    called = [];
  try {
    Object.assign(process.env, {
      REGISTRY_URL: "http://evm.local",
      STELLAR_REGISTRY_URL: "http://stellar.local",
      STELLAR_RUNTIME_REGISTRY_URL: "http://container-host.local:3002",
    });
    globalThis.fetch = async (url) => {
      called.push(url);
      return Response.json(
        url.startsWith("http://stellar.local")
          ? [
              {
                name: "stellar_testnet_xlm",
                url: "/contracts/CEXAMPLE/mcp",
                contractName: "XLM",
                toolNames: ["balance"],
              },
            ]
          : [
              {
                name: "1_0x123",
                url: "/interface/1_0x123/mcp",
                contractName: "EVM",
              },
            ],
      );
    };
    const r = await resolveMcpServers(
      ["stellar_testnet_xlm", "1_0x123"],
      "test-only",
    );
    assert.deepEqual(called, [
      "http://evm.local/mcp",
      "http://stellar.local/mcp",
    ]);
    assert.equal(
      r.entries.find((e) => e.mcpName.startsWith("stellar")).url,
      "http://container-host.local:3002/contracts/CEXAMPLE/mcp?client=zeroclaw",
    );
    assert.equal(
      r.entries.find((e) => e.mcpName === "1_0x123").url,
      "http://evm.local/interface/1_0x123/mcp",
    );
  } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
