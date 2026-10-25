import { beforeAll, afterAll, it, expect } from "vitest";
import { Store, digest } from "../src/store.js";
import { randomUUID } from "node:crypto";
const url = process.env.TEST_DATABASE_URL;
const store = url ? new Store(url) : undefined;
beforeAll(async () => {
  if (store) await store.migrate();
});
afterAll(async () => {
  await store?.close();
});
it.skipIf(!url)(
  "persists scoped idempotency and account reservation across connections",
  async () => {
    const principal = randomUUID(),
      account = randomUUID();
    const s = store!;
    const input = {
      principal,
      network: "testnet",
      idempotency_key: "same",
      fingerprint: "request",
      source_account: account,
      request: {},
    };
    let id = "";
    await s.lock("testnet", account, async (client) => {
      const a = await s.begin(client, input);
      id = a.id;
      await s.update(id, "INTENT", undefined, "abc");
    });
    expect((await s.find(principal, "testnet", "same"))?.transaction_hash).toBe(
      "abc",
    );
    await s.lock("testnet", account, async (client) => {
      expect((await s.begin(client, input)).id).toBe(id);
      await expect(
        s.begin(client, { ...input, idempotency_key: "new" }),
      ).rejects.toThrow("policy");
    });
    await s.update(id, "SUCCESS", { ok: true });
    await s.lock("testnet", account, async (client) => {
      const a = await s.begin(client, { ...input, idempotency_key: "new" });
      await s.update(a.id, "REJECTED");
    });
  },
);
it.skipIf(!url)(
  "serializes independent workers and isolates credentials",
  async () => {
    const principal = randomUUID(),
      token = randomUUID(),
      s = store!;
    await s.credential(token, principal);
    expect(await s.authenticate(token)).toBe(principal);
    expect(await s.authenticate("wrong")).toBeUndefined();
    await s.revoke(token);
    expect(await s.authenticate(token)).toBeUndefined();
    const account = randomUUID();
    const events: string[] = [];
    await Promise.all([
      s.lock("testnet", account, async () => {
        events.push("a");
        await new Promise((r) => setTimeout(r, 50));
        events.push("b");
      }),
      s.lock("testnet", account, async () => {
        events.push("c");
      }),
    ]);
    expect(events).toContain("c");
    expect(events.indexOf("b")).toBe(events.indexOf("a") + 1);
  },
);
it.skipIf(!url)(
  "enforces shared rate limits and prevents terminal state regression",
  async () => {
    const s = store!,
      principal = randomUUID();
    await s.rate(principal, "contract", 1);
    await expect(s.rate(principal, "contract", 1)).rejects.toThrow(
      "rate limit",
    );
    await s.lock("testnet", principal, async (c) => {
      const a = await s.begin(c, {
        principal,
        network: "testnet",
        idempotency_key: "key",
        fingerprint: "f",
        source_account: principal,
        request: {},
      });
      await s.update(a.id, "SUCCESS", { ok: true });
      expect(await s.update(a.id, "TIMEOUT", { ok: false })).toEqual({
        ok: true,
      });
      expect((await s.find(principal, "testnet", "key"))?.state).toBe(
        "SUCCESS",
      );
    });
  },
);
it.skipIf(!url)(
  "migrates legacy WASM identities without changing durable write records",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const schema = "migration_" + randomUUID().replaceAll("-", "");
    await store!.pool.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const s = new Store(scoped.toString());
    try {
      await s.pool.query(
        "CREATE TABLE stellar_migrations(version integer PRIMARY KEY); INSERT INTO stellar_migrations VALUES(1),(2)",
      );
      for (const file of ["001_initial.sql", "002_rate_limits.sql"])
        await s.pool.query(
          await readFile(
            new URL("../migrations/" + file, import.meta.url),
            "utf8",
          ),
        );
      const old = {
        network: "testnet",
        contractId: "old",
        wasmHash: "realhash",
        functions: [],
        excluded: [],
        generatedAt: new Date().toISOString(),
      };
      await s.pool.query(
        "INSERT INTO stellar_interfaces(network,contract_id,wasm_hash,interface) VALUES('testnet','old','realhash',$1)",
        [old],
      );
      await s.lock("testnet", "migration-account", async (client) => {
        const a = await s.begin(client, {
          network: "testnet",
          principal: "legacy",
          idempotency_key: "key",
          fingerprint: "original",
          source_account: "migration-account",
          request: { wasm_hash: "realhash" },
        });
        await s.update(a.id, "INTENT", undefined, "retainedhash");
      });
      await s.migrate();
      expect(await s.get("testnet", "old")).toMatchObject({
        wasmHash: "realhash",
        interfaceHash: "realhash",
        sourceKind: "wasm",
      });
      expect(await s.find("legacy", "testnet", "key")).toMatchObject({
        fingerprint: "original",
        state: "INTENT",
        transaction_hash: "retainedhash",
      });
      await s.save({
        network: "testnet",
        contractId: "asset",
        sourceKind: "stellar_asset",
        interfaceHash: "spechash",
        functions: [],
        excluded: [],
        generatedAt: new Date().toISOString(),
      });
      expect((await s.get("testnet", "asset"))?.wasmHash).toBeUndefined();
    } finally {
      await s.close();
      await store!.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  },
);
