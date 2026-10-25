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
