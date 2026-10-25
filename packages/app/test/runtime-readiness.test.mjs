import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  assertRuntimeReady,
  RuntimeUnavailableError,
} from "../lib/session/runtime-readiness.ts";
test("Stellar startup requires a healthy isolated runtime and preserves EVM startup", async () => {
  await assertRuntimeReady({ ORLOJ_PRODUCT: "evm" });
  await assert.rejects(
    assertRuntimeReady({ ORLOJ_PRODUCT: "stellar" }),
    RuntimeUnavailableError,
  );
  const server = createServer((_req, res) => res.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = {
    ORLOJ_PRODUCT: "stellar",
    RUNTIME_BROKER_URL: `http://127.0.0.1:${server.address().port}`,
    RUNTIME_TOKEN_FILE: "test-only-private-config",
  };
  try {
    await assertRuntimeReady(env);
  } finally {
    await new Promise((r) => server.close(r));
  }
  await assert.rejects(assertRuntimeReady(env), RuntimeUnavailableError);
});
