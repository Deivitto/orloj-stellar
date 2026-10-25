import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerFailure, chatFailureMessage } from "../lib/session/chat-errors.ts";
import { resetConversation } from "../lib/session/reset-conversation.ts";
import { changedOperations, operationReceipt, formatStroops } from "../lib/session/operation-receipts.ts";

test("provider errors ignore stale events and never disclose provider bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orloj-chat-"));
  try {
    await mkdir(join(dir, "data/state"), { recursive: true });
    const since = Date.now();
    const row = (time, status) => JSON.stringify({ "@timestamp": new Date(time).toISOString(), attributes: { status, body: "sensitive-provider-body" } });
    const file = join(dir, "data/state/runtime-trace.jsonl");
    await writeFile(file, row(since - 5000, 413) + "\n" + row(since, 429));
    assert.equal(await providerFailure(dir, since), "rate_limit");
    await writeFile(file, row(since, 413));
    assert.equal(await providerFailure(dir, since), "context_limit");
    assert.doesNotMatch(chatFailureMessage(await providerFailure(dir, since)), /sensitive-provider-body/);
    assert.match(chatFailureMessage("context_limit"), /does not cancel or resend/);
    assert.equal(await providerFailure(dir, since + 1000), "provider");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("registry receipts preserve large exact fees and cannot include signing payloads", () => {
  assert.equal(formatStroops("7228"), "0.0007228");
  assert.equal(formatStroops("9007199254740993"), "900719925.4740993");
  assert.throws(() => formatStroops("1e7"));
  const pending = { operation_id: "5af6f9ce-19ef-4bdb-8e1f-32db81b29c44", result_status: "PENDING" };
  const confirmed = { ...pending, result_status: "SUBMITTED_AND_CONFIRMED", transaction_hash: "a".repeat(64), fee_charged: "7228", unsigned_xdr: "sensitive-signing-payload" };
  assert.deepEqual(changedOperations([pending], [confirmed]), [confirmed]);
  assert.deepEqual(changedOperations([confirmed], [confirmed]), []);
  const receipt = operationReceipt([confirmed]);
  assert.match(receipt, /registry data/);
  assert.match(receipt, /0\.0007228 XLM/);
  assert.doesNotMatch(receipt, /sensitive-signing-payload/);
});

test("dead runtime reset recreates context once and propagates authorization failure", async () => {
  let restarts = 0;
  const failedReset = async () => { throw new Error("dead child"); };
  assert.deepEqual(await resetConversation("old", async () => "new-context", async () => { throw new Error("must not restart healthy child"); }), { sessionId: "old", acpSessionId: "new-context" });
  assert.deepEqual(await resetConversation("old", failedReset, async () => { restarts++; return { sessionId: "fresh", acpSessionId: "empty-context" }; }), { sessionId: "fresh", acpSessionId: "empty-context" });
  assert.equal(restarts, 1);
  await assert.rejects(resetConversation("old", failedReset, async () => { throw new Error("ownership revoked"); }), /ownership revoked/);
});
