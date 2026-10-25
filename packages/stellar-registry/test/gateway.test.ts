import { it, expect, vi } from "vitest";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { Keypair, StrKey, rpc } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { model } from "../src/codec.js";
import { Executor } from "../src/executor.js";
import { httpServer } from "../src/gateway.js";
import type { ContractInterface } from "../src/model.js";
const database = process.env.TEST_DATABASE_URL;
it.skipIf(!database)(
  "serves authenticated MCP, isolates principals, enforces origin checks and revocation",
  async () => {
    const principal = randomUUID(),
      id = StrKey.encodeContract(randomBytes(32)),
      token = randomBytes(32).toString("base64url");
    const c = parseConfig({
      rpcUrl: "https://soroban-testnet.stellar.org",
      databaseUrl: database,
      simulationSource: Keypair.random().publicKey(),
      policies: [
        {
          contractId: id,
          function: "read",
          mode: "READ",
          principals: [principal],
        },
      ],
    });
    const store = new Store(database!);
    await store.migrate();
    await store.credential(token, principal);
    const i: ContractInterface = {
      network: "testnet",
      contractId: id,
      wasmHash: "abc",
      generatedAt: new Date().toISOString(),
      excluded: [],
      functions: [
        {
          sorobanName: "read",
          mcpToolName: "read",
          description: "",
          mode: "READ",
          params: [],
          returns: model({ kind: "u32" }),
          simulationSafe: false,
          writeAllowed: false,
        },
      ],
    };
    await store.save(i);
    const executor = new Executor(c, new rpc.Server(c.rpcUrl), store);
    const call = vi
      .spyOn(executor, "call")
      .mockResolvedValue({ ok: true, result_status: "SIMULATED", data: 7 });
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const http = httpServer(executor);
    const client = new Client({ name: "test", version: "1.0.0" });
    try {
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const address = http.address();
      if (!address || typeof address === "string")
        throw new Error("No listener");
      const url = new URL(
        `http://127.0.0.1:${address.port}/contracts/${id}/mcp`,
      );
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(
        401,
      );
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              origin: "https://hostile.example",
            },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "read",
      ]);
      const r = await client.callTool({ name: "read", arguments: {} });
      expect(r.structuredContent).toEqual({
        ok: true,
        result_status: "SIMULATED",
        data: 7,
      });
      call.mockRejectedValueOnce(
        new Error("SECRET_CREDENTIAL raw RPC exception stack"),
      );
      const failure = await client.callTool({ name: "read", arguments: {} });
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure)).not.toContain("SECRET_CREDENTIAL");
      expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
      const other = randomBytes(32).toString("base64url");
      await store.credential(other, randomUUID());
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${other}` },
            body: "{}",
          })
        ).status,
      ).toBe(404);
      await store.revoke(token);
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    } finally {
      await client.close();
      await new Promise<void>((r) => http.close(() => r()));
      await store.close();
      vi.restoreAllMocks();
    }
  },
);
