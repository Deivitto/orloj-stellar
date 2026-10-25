import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../dist/src/config.js";
import { Store } from "../dist/src/store.js";
import { ingest } from "../dist/src/ingestion.js";
import { Executor } from "../dist/src/executor.js";
import { BrowserSigner } from "../dist/src/browser-signer.js";
import { httpServer } from "../dist/src/gateway.js";
import { envelope } from "../dist/src/errors.js";
async function main() {
  const wallet = process.argv[2],
    port = Number(process.env.WALLET_TEST_PORT ?? 3003);
  if (!wallet || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid test options");
  const local = await readFile(
    new URL("../.env.demo", import.meta.url),
    "utf8",
  );
  const databaseUrl =
    process.env.DATABASE_URL ?? /^DATABASE_URL=(.+)$/m.exec(local)?.[1];
  const deployment = JSON.parse(
    await readFile(
      new URL("../demo-contract/deployment.json", import.meta.url),
      "utf8",
    ),
  );
  const principal = "freighter-test:" + wallet;
  const config = parseConfig({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    databaseUrl,
    simulationSource: wallet,
    writeMode: true,
    externalSignerAddress: wallet,
    maxFee: "2000000",
    policies: ["count", "increment", "echo_address", "authorized"].map(
      (fn) => ({
        contractId: deployment.contractId,
        function: fn,
        mode: fn === "increment" ? "WRITE" : "READ",
        principals: [principal],
      }),
    ),
  });
  const store = new Store(config.databaseUrl),
    server = new rpc.Server(config.rpcUrl, { timeout: 10000 }),
    signer = new BrowserSigner(wallet);
  const executor = new Executor(config, server, store, signer),
    client = new Client({ name: "orloj-freighter-test", version: "1.0.0" });
  const token = randomBytes(32).toString("base64url"),
    session = randomBytes(32).toString("hex"),
    origin = `http://127.0.0.1:${port}`;
  const state = {
    wallet,
    connected: false,
    started: false,
    done: false,
    ok: false,
    results: [],
  };
  const evidence = {
    network: "testnet",
    wallet,
    contractId: deployment.contractId,
    testedAt: new Date().toISOString(),
    checks: state.results,
  };
  function record(check, result) {
    state.results.push({ check, ...result });
    console.log(JSON.stringify({ check, ...result }));
  }
  const assert = (x) => {
    if (!x) throw new Error("Test failed");
  };
  let mcpHttp, ui;
  async function cleanup() {
    signer.close();
    await client.close();
    if (ui) await new Promise((r) => ui.close(r));
    if (mcpHttp) await new Promise((r) => mcpHttp.close(r));
    await store.revoke(token);
    await store.close();
  }
  try {
    assert((await server.getNetwork()).passphrase === config.networkPassphrase);
    await server.getAccount(wallet);
    await store.migrate();
    const i = await ingest(server, config, deployment.contractId);
    await store.save(i);
    await store.credential(token, principal);
    mcpHttp = httpServer(executor);
    mcpHttp.listen(0, "127.0.0.1");
    await once(mcpHttp, "listening");
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${mcpHttp.address().port}/contracts/${i.contractId}/mcp`,
        ),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } },
      ),
    );
    async function call(name, args) {
      const response = await client.callTool({ name, arguments: args });
      return response.structuredContent ?? JSON.parse(response.content[0].text);
    }
    async function run() {
      evidence.testedAt = new Date().toISOString();
      try {
        const tools = await client.listTools();
        assert(tools.tools.some((t) => t.name === "increment"));
        record("mcp_discovery", {
          ok: true,
          tools: tools.tools.map((t) => t.name),
        });
        const before = await call("count", {});
        record("read_before", before);
        assert(before.ok);
        const echo = await call("echo_address", { v: wallet });
        record("wallet_address", echo);
        assert(echo.ok && echo.data === wallet);
        const auth = await call("authorized", { user: wallet });
        record("authorization_guard", auth);
        assert(auth.error_code === "AUTHORIZATION_REQUIRED");
        const key = randomUUID();
        const write = await call("increment", { idempotency_key: key });
        record("confirmed_write", write);
        assert(write.ok && write.result_status === "SUBMITTED_AND_CONFIRMED");
        const chain = await server.getTransaction(write.transaction_hash);
        assert(chain.status === "SUCCESS");
        const submitted = TransactionBuilder.fromXdr(
          chain.envelopeXdr.toXdr("base64"),
          config.networkPassphrase,
        );
        assert(submitted.source === wallet);
        record("wallet_signature_proof", {
          ok: true,
          source_account: submitted.source,
          transaction_hash: write.transaction_hash,
          freighter_signatures: signer.signatures,
        });
        const duplicate = await call("increment", { idempotency_key: key });
        record("duplicate_reconciled", duplicate);
        assert(
          duplicate.ok &&
            duplicate.transaction_hash === write.transaction_hash &&
            signer.signatures === 1,
        );
        const after = await call("count", {});
        record("read_after", after);
        assert(after.ok && after.data === before.data + 1);
        state.ok = true;
      } catch (e) {
        record("test_error", envelope(e));
      } finally {
        state.done = true;
        await writeFile(
          new URL("../demo-contract/freighter-evidence.json", import.meta.url),
          JSON.stringify(evidence, null, 2) + "\n",
        );
      }
    }
    const assets = {
      "/": [
        await readFile(new URL("../wallet-test/index.html", import.meta.url)),
        "text/html",
      ],
      "/client.js": [
        await readFile(new URL("../wallet-test/client.js", import.meta.url)),
        "text/javascript",
      ],
      "/vendor/freighter.js": [
        await readFile(
          new URL(
            "../node_modules/@stellar/freighter-api/build/index.min.js",
            import.meta.url,
          ),
        ),
        "text/javascript",
      ],
    };
    function json(res, status, value) {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(value));
    }
    ui = createServer(async (req, res) => {
      try {
        if (
          req.headers.host !== `127.0.0.1:${port}` ||
          (req.headers.origin && req.headers.origin !== origin)
        ) {
          json(res, 403, { error_code: "UNAUTHORIZED" });
          return;
        }
        const path = new URL(req.url ?? "/", origin).pathname;
        res.setHeader(
          "content-security-policy",
          "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
        );
        res.setHeader("x-content-type-options", "nosniff");
        if (req.method === "GET" && assets[path]) {
          if (path === "/")
            res.setHeader(
              "set-cookie",
              `orloj_test=${session}; HttpOnly; SameSite=Strict; Path=/`,
            );
          res.writeHead(200, {
            "content-type": assets[path][1],
            "cache-control": "no-store",
          });
          res.end(assets[path][0]);
          return;
        }
        const cookie = /(?:^|; )orloj_test=([a-f0-9]+)/.exec(
          req.headers.cookie ?? "",
        )?.[1];
        if (
          req.headers["x-orloj-local-test"] !== "1" ||
          !cookie ||
          cookie.length !== session.length ||
          !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))
        ) {
          json(res, 401, { error_code: "UNAUTHORIZED" });
          return;
        }
        let body = {};
        if (req.method === "POST") {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) throw new Error();
            chunks.push(chunk);
          }
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        }
        if (path === "/api/state" && req.method === "GET") {
          json(res, 200, state);
          return;
        }
        if (path === "/api/connect" && req.method === "POST") {
          if (
            body.address !== wallet ||
            body.networkPassphrase !== config.networkPassphrase
          ) {
            json(res, 400, { error_code: "INVALID_ARGUMENT" });
            return;
          }
          state.connected = true;
          json(res, 200, { ok: true });
          return;
        }
        if (path === "/api/run" && req.method === "POST") {
          if (!state.connected) {
            json(res, 403, { error_code: "UNAUTHORIZED" });
            return;
          }
          if (!state.started) {
            state.started = true;
            void run();
          }
          json(res, 202, { ok: true });
          return;
        }
        if (
          path === "/api/signing" &&
          req.method === "GET" &&
          state.connected
        ) {
          json(res, 200, { request: signer.take() ?? null });
          return;
        }
        if (
          path === "/api/signed" &&
          req.method === "POST" &&
          state.connected
        ) {
          signer.complete(body.id, body.result);
          json(res, 200, { ok: true });
          return;
        }
        json(res, 404, { error_code: "INVALID_ARGUMENT" });
      } catch (e) {
        json(res, 400, envelope(e));
      }
    });
    ui.listen(port, "127.0.0.1");
    await once(ui, "listening");
    console.log(
      JSON.stringify({
        event: "freighter_test_ready",
        url: origin,
        wallet,
        network: "testnet",
      }),
    );
    await new Promise((resolve) => {
      for (const s of ["SIGINT", "SIGTERM"]) process.once(s, resolve);
    });
  } finally {
    await cleanup();
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({ ok: false, error_code: "FREIGHTER_TEST_FAILED" }),
  );
  process.exitCode = 1;
});
