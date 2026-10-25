import { classicIds, classicInterface } from "./classic.js";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { rpc } from "@stellar/stellar-sdk";
import { loadConfig } from "./config.js";
import { ingestAsset, parseAmount, formatAmount } from "./assets.js";
import { Product } from "./product.js";
import { Store } from "./store.js";
import { inspectUpload, ingest } from "./ingestion.js";
import { envelope, fail } from "./errors.js";
import { Executor } from "./executor.js";
import { environmentSigner } from "./signer.js";
import { httpServer } from "./gateway.js";
export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(
      "Orloj Stellar: migrate | inspect <wasm> | register <contractId> [wasm] | register-asset <native|code> [issuer] | amount <parse|format> <value> <decimals> | inventory <contractId> | credential <principal> <new-token-file> | revoke <token-file> | list <contractId> | call <contractId> <tool> <args-json-file> [idempotency-key] | status <idempotency-key> | recover-operation <operation-id> [--prove-expired] | serve",
    );
    return;
  }
  if (command === "migrate") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl))
      fail("INVALID_ARGUMENT");
    const store = new Store(databaseUrl);
    try {
      await store.migrate();
      console.log(JSON.stringify({ ok: true }));
    } finally {
      await store.close();
    }
    return;
  }
  const c = loadConfig();
  const store = new Store(c.databaseUrl);
  const server = new rpc.Server(c.rpcUrl, {
    allowHttp: new URL(c.rpcUrl).protocol === "http:",
    timeout: 10000,
  });
  const executor = new Executor(
    c,
    server,
    store,
    c.writeMode && c.signerSecret
      ? environmentSigner(c.signerSecret, c.networkPassphrase)
      : undefined,
  );
  let serving = false;
  try {
    if (
      [
        "register",
        "register-asset",
        "call",
        "status",
        "recover-operation",
      ].includes(command)
    ) {
      const network = await server.getNetwork();
      if (network.passphrase !== c.networkPassphrase) fail("INVALID_ARGUMENT");
    }
    let result: unknown;
    switch (command) {
      case "recover-operation": {
        if (c.network !== "testnet") fail("WRITE_NOT_PERMITTED");
        const o = (
          await store.pool.query(
            "SELECT * FROM stellar_operations WHERE id=$1",
            [args[0]],
          )
        ).rows[0];
        if (!o) fail("INVALID_ARGUMENT");
        const product = new Product(c, server, store, {
          serviceToken: "operator-recovery-only-never-served",
          signerToken: "operator-recovery-only-never-served",
          signerUrl: "http://127.0.0.1:3005",
          origin: process.env.APP_ORIGIN ?? "http://localhost:3000",
        });
        result = await product.reconcile(
          {
            agentId: o.agent_id,
            instanceId: o.instance_id,
            ownerId: o.owner_id,
            credentialId: o.credential_id,
          },
          o.id,
          args[1] === "--prove-expired",
        );
        break;
      }
      case "migrate":
        await store.migrate();
        result = { ok: true };
        break;
      case "credential": {
        const [principal, file] = args;
        if (!principal || !file) fail("INVALID_ARGUMENT");
        const token = randomBytes(32).toString("base64url");
        await writeFile(file, token, { mode: 0o600, flag: "wx" });
        await store.credential(token, principal);
        result = { ok: true, credential_file: file };
        break;
      }
      case "revoke":
        if (!args[0]) fail("INVALID_ARGUMENT");
        await store.revoke((await readFile(args[0], "utf8")).trim());
        result = { ok: true };
        break;
      case "inspect":
        if (!args[0]) fail("INVALID_ARGUMENT");
        result = inspectUpload(await readFile(args[0]), c);
        break;
      case "amount":
        if (!["parse", "format"].includes(args[0]) || args.length !== 3)
          fail("INVALID_ARGUMENT");
        result = {
          value: (args[0] === "parse" ? parseAmount : formatAmount)(
            args[1],
            Number(args[2]),
          ),
        };
        break;
      case "register-asset": {
        if (!args[0]) fail("INVALID_ARGUMENT");
        const i = await ingestAsset(
          server,
          c,
          args[0] === "native"
            ? { kind: "native" }
            : { kind: "issued", code: args[0], issuer: args[1] },
        );
        await store.save(i);
        result = i;
        break;
      }
      case "inventory": {
        const i = await store.get(c.network, args[0]);
        if (!i) fail("INVALID_CONTRACT_ID");
        result = {
          network: i.network,
          contract_id: i.contractId,
          source_kind: i.sourceKind ?? "wasm",
          interface_hash: i.interfaceHash ?? i.wasmHash,
          inventory: i.inventory ?? [],
          excluded: i.excluded,
        };
        break;
      }
      case "register": {
        if (!args[0]) fail("INVALID_ARGUMENT");
        const i = classicIds.includes(args[0] as (typeof classicIds)[number])
          ? classicInterface(c, args[0])
          : await ingest(
              server,
              c,
              args[0],
              args[1] ? await readFile(args[1]) : undefined,
            );
        await store.save(i);
        result = i;
        break;
      }
      case "list":
      case "call":
      case "status": {
        const tokenFile = process.env.STELLAR_TOKEN_FILE;
        if (!tokenFile) fail("UNAUTHORIZED");
        const principal = await store.authenticate(
          (await readFile(tokenFile, "utf8")).trim(),
        );
        if (!principal) fail("UNAUTHORIZED");
        if (command === "status") {
          const a = await store.find(principal, c.network, args[0]);
          if (!a) fail("INVALID_ARGUMENT");
          const f = { returns: a.request.returns } as Parameters<
            Executor["reconcile"]
          >[1];
          const { returns: _, ...context } = a.request;
          result = await executor.reconcile(a, f, context);
          break;
        }
        const i = await store.get(c.network, args[0]);
        if (!i) fail("INVALID_CONTRACT_ID");
        const functions = i.functions.filter((f) =>
          c.policies.some(
            (p) =>
              p.contractId === i.contractId &&
              p.function === f.sorobanName &&
              p.principals.includes(principal),
          ),
        );
        if (command === "list") {
          result = {
            ...i,
            functions: functions.filter(
              (f) => f.mode === "READ" || (c.writeMode && !!executor.signer),
            ),
          };
          break;
        }
        const f = functions.find((f) => f.mcpToolName === args[1]);
        if (!f) fail("WRITE_NOT_PERMITTED");
        let input: unknown;
        try {
          input = JSON.parse(await readFile(args[2], "utf8"));
        } catch {
          fail("INVALID_ARGUMENT");
        }
        result = await executor.call(i, f, input, principal, args[3]);
        break;
      }
      case "serve": {
        const net = await server.getNetwork();
        if (net.passphrase !== c.networkPassphrase) fail("INVALID_ARGUMENT");
        if (
          !(
            await store.pool.query(
              "SELECT version FROM stellar_migrations WHERE version=8",
            )
          ).rowCount
        )
          fail("INTERNAL_ERROR");
        const product = c.productMode
          ? new Product(c, server, store, {
              serviceToken: (
                await readFile(process.env.CONTROL_TOKEN_FILE!, "utf8")
              ).trim(),
              signerToken: (
                await readFile(process.env.SIGNER_TOKEN_FILE!, "utf8")
              ).trim(),
              signerUrl: process.env.SIGNER_URL ?? "http://127.0.0.1:3005",
              origin: process.env.APP_ORIGIN ?? "http://localhost:3000",
            })
          : undefined;
        product?.start();
        const http = httpServer(executor, product);
        http.listen(c.port, c.host);
        await once(http, "listening");
        serving = true;
        console.error(
          JSON.stringify({ event: "listening", host: c.host, port: c.port }),
        );
        http.on("error", () => {
          console.error(JSON.stringify(envelope(new Error())));
          http.close();
          void store.close();
        });
        for (const signal of ["SIGINT", "SIGTERM"] as const)
          process.once(signal, () =>
            http.close(() => {
              void product?.stop().then(() => store.close());
              if (!product) void store.close();
            }),
          );
        return;
      }
      default:
        fail("INVALID_ARGUMENT");
    }
    console.log(JSON.stringify(result));
    if (
      result &&
      typeof result === "object" &&
      "ok" in result &&
      result.ok === false
    )
      process.exitCode = 1;
  } finally {
    if (!serving) await store.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
)
  main().catch((e) => {
    console.log(JSON.stringify(envelope(e)));
    process.exitCode = 1;
  });
