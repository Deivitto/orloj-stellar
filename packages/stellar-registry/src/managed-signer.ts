import { checkedGrant, checkExactGrant, MAX_EXACT_FEE } from "./exact-grant.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { encode } from "./codec.js";
import { fail, envelope } from "./errors.js";
import { Store } from "./store.js";
import { environmentSigner, type Signer } from "./signer.js";
export function encryptKey(secret: string, key: Buffer, aad: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const value = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: value.toString("base64"),
  };
}
export function decryptKey(
  record: { iv: string; tag: string; value: string },
  key: Buffer,
  aad: string,
) {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.value, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return fail("SIGNING_FAILED");
  }
}
const fingerprint = (key: Buffer) =>
  createHash("sha256").update(key).digest("hex");
export async function initializeEpoch(store: Store, key: Buffer) {
  if (key.length !== 32) fail("SIGNER_NOT_CONFIGURED");
  const client = await store.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('stellar_master_key',0))",
    );
    const epoch = (
      await client.query(
        "SELECT * FROM stellar_signer_epoch WHERE singleton FOR UPDATE",
      )
    ).rows[0];
    if (epoch) {
      if (epoch.fingerprint !== fingerprint(key)) fail("SIGNER_NOT_CONFIGURED");
      await client.query("COMMIT");
      return Number(epoch.version);
    }
    const rows = (
      await client.query(
        "SELECT * FROM stellar_wallets WHERE mode='managed' AND encrypted_key IS NOT NULL FOR UPDATE",
      )
    ).rows;
    for (const row of rows) {
      const secret = decryptKey(
        row.encrypted_key,
        key,
        `${row.agent_id}:${row.instance_id}:testnet:${row.key_version}`,
      );
      if (Keypair.fromSecret(secret).publicKey() !== row.address)
        fail("SIGNER_NOT_CONFIGURED");
    }
    const version = Math.max(1, ...rows.map((r) => Number(r.key_version)));
    await client.query(
      "INSERT INTO stellar_signer_epoch(singleton,fingerprint,version) VALUES(true,$1,$2)",
      [fingerprint(key), version],
    );
    await client.query("COMMIT");
    return version;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function rotateMasterKey(
  store: Store,
  oldKey: Buffer,
  newKey: Buffer,
) {
  if (
    oldKey.length !== 32 ||
    newKey.length !== 32 ||
    fingerprint(oldKey) === fingerprint(newKey)
  )
    fail("INVALID_ARGUMENT");
  await initializeEpoch(store, oldKey);
  const client = await store.pool.connect();
  try {
    await client.query("BEGIN");
    const epoch = (
      await client.query(
        "SELECT * FROM stellar_signer_epoch WHERE singleton FOR UPDATE",
      )
    ).rows[0];
    if (epoch.fingerprint !== fingerprint(oldKey))
      fail("SIGNER_NOT_CONFIGURED");
    const version = Number(epoch.version) + 1,
      rows = (
        await client.query(
          "SELECT * FROM stellar_wallets WHERE mode='managed' AND encrypted_key IS NOT NULL FOR UPDATE",
        )
      ).rows;
    for (const row of rows) {
      const secret = decryptKey(
        row.encrypted_key,
        oldKey,
        `${row.agent_id}:${row.instance_id}:testnet:${row.key_version}`,
      );
      const encrypted = encryptKey(
        secret,
        newKey,
        `${row.agent_id}:${row.instance_id}:testnet:${version}`,
      );
      await client.query(
        "UPDATE stellar_wallets SET encrypted_key=$2,key_version=$3 WHERE id=$1",
        [row.id, encrypted, version],
      );
    }
    await client.query(
      "UPDATE stellar_signer_epoch SET fingerprint=$1,version=$2 WHERE singleton",
      [fingerprint(newKey), version],
    );
    await client.query("COMMIT");
    return { ok: true, wallets: rows.length, key_version: version };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export function serviceAuthorized(actual: unknown, expected: string) {
  return (
    typeof actual === "string" &&
    expected.length >= 32 &&
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
export function managedSigner(
  address: string,
  walletId: string,
  operationId: string,
  url: string,
  token: string,
): Signer {
  return {
    address,
    sign_authorization_entries: async () => fail("AUTHORIZATION_FAILED"),
    sign_transaction_envelope: async (payload, opts) => {
      const r = await fetch(new URL("/sign", url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-orloj-signer": token,
        },
        body: JSON.stringify({ walletId, operationId, payload, opts }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) fail("SIGNING_FAILED");
      return (await r.json()) as { signedTxXdr: string; signerAddress: string };
    },
  };
}
export async function signerService(store: Store, key: Buffer, token: string) {
  if (key.length !== 32 || token.length < 32) fail("SIGNER_NOT_CONFIGURED");
  await initializeEpoch(store, key);
  const epoch = async (client: Pick<Store["pool"], "query"> = store.pool) => {
    const row = (
      await client.query(
        "SELECT * FROM stellar_signer_epoch WHERE singleton FOR SHARE",
      )
    ).rows[0];
    if (!row || row.fingerprint !== fingerprint(key))
      fail("SIGNER_NOT_CONFIGURED");
    return Number(row.version);
  };
  return createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.url === "/healthz" && req.method === "GET") {
        await epoch();
        send(200, { ok: true });
        return;
      }
      if (!serviceAuthorized(req.headers["x-orloj-signer"], token))
        fail("UNAUTHORIZED");
      let text = "";
      for await (const c of req) {
        text += c;
        if (Buffer.byteLength(text) > 1024 * 1024) fail("INVALID_ARGUMENT");
      }
      const b = JSON.parse(text);
      if (req.url === "/wallet" && req.method === "POST") {
        const client = await store.pool.connect();
        try {
          await client.query("BEGIN");
          const version = await epoch(client);
          const owner = await client.query(
            "SELECT instance_id FROM agent_ownership WHERE agent_id=$1 AND user_id=$2 AND instance_id=$3 FOR SHARE",
            [b.agentId, b.ownerId, b.instanceId],
          );
          if (!owner.rowCount) fail("UNAUTHORIZED");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            ["wallet:" + b.instanceId],
          );
          const old = await client.query(
            "SELECT id,address FROM stellar_wallets WHERE agent_id=$1 AND instance_id=$2 AND mode='managed'",
            [b.agentId, b.instanceId],
          );
          if (old.rowCount) {
            await client.query("COMMIT");
            send(200, old.rows[0]);
            return;
          }
          const kp = Keypair.random(),
            id = randomUUID();
          const encrypted = encryptKey(
            kp.secret(),
            key,
            `${b.agentId}:${b.instanceId}:testnet:${version}`,
          );
          await client.query(
            "INSERT INTO stellar_wallets(id,agent_id,instance_id,owner_id,network,mode,address,encrypted_key,key_version) VALUES($1,$2,$3,$4,'testnet','managed',$5,$6,$7)",
            [
              id,
              b.agentId,
              b.instanceId,
              b.ownerId,
              kp.publicKey(),
              encrypted,
              version,
            ],
          );
          await client.query("COMMIT");
          send(201, { id, address: kp.publicKey() });
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
        return;
      }
      if (req.url === "/sign" && req.method === "POST") {
        await epoch();
        const r = await store.pool.query(
          "SELECT w.*,o.arguments,o.contract_id,o.function_name,o.function_model,o.interface_hash,p.exact_grant,p.limits,s.fee AS reserved_fee FROM stellar_wallets w JOIN stellar_operations o ON o.wallet_id=w.id AND o.agent_id=w.agent_id AND o.instance_id=w.instance_id JOIN agent_ownership a ON a.agent_id=w.agent_id AND a.instance_id=w.instance_id AND a.user_id=w.owner_id JOIN mcp_api_key k ON k.id=o.credential_id AND k.agent_id=w.agent_id AND k.owner_id=w.owner_id AND k.instance_id=w.instance_id AND k.revoked_at IS NULL JOIN stellar_tool_policies p ON p.agent_id=o.agent_id AND p.instance_id=o.instance_id AND p.owner_id=o.owner_id AND p.contract_id=o.contract_id AND p.function_name=o.function_name AND p.revision=o.policy_revision AND p.mode='WRITE' JOIN stellar_spending s ON s.operation_id=o.id AND s.state='RESERVED' WHERE w.id=$1 AND o.id=$2 AND o.owner_id=w.owner_id AND o.wallet_revision=w.revision AND w.active AND w.mode='managed' AND o.state='PREPARING' AND o.lease_until>now()",
          [b.walletId, b.operationId],
        );
        const w = r.rows[0];
        if (
          !w ||
          b.opts?.networkPassphrase !== Networks.TESTNET ||
          (b.opts?.address !== undefined && b.opts.address !== w.address) ||
          b.opts?.submit
        )
          fail("SIGNING_FAILED");
        const i = await store.get("testnet", w.contract_id);
        if (!i || i.interfaceHash !== w.interface_hash) fail("STALE_INTERFACE");
        const grant = w.exact_grant ? checkedGrant(w.exact_grant) : undefined;
        if (grant) checkExactGrant(i, w.function_model, w.arguments, grant);
        else if (
          i.sourceKind !== "stellar_asset" ||
          w.function_name !== "transfer" ||
          !w.limits ||
          w.arguments.from !== w.address ||
          !w.limits.recipients.includes(w.arguments.to_mux) ||
          BigInt(w.arguments.amount) > BigInt(w.limits.perTransfer)
        )
          fail("SIGNING_FAILED");
        const maxFee = grant
          ? BigInt(grant.maxFee)
          : BigInt(process.env.MAX_FEE ?? "2000000");
        if (grant && maxFee > MAX_EXACT_FEE) fail("SIGNING_FAILED");
        const tx = TransactionBuilder.fromXdr(b.payload, Networks.TESTNET);
        if (
          !("source" in tx) ||
          tx.source !== w.address ||
          tx.operations.length !== 1 ||
          !tx.timeBounds ||
          BigInt(tx.timeBounds.maxTime) * 1000n <= BigInt(Date.now()) ||
          BigInt(tx.timeBounds.maxTime) * 1000n > BigInt(Date.now() + 90000) ||
          (tx.operations[0].source !== undefined &&
            tx.operations[0].source !== w.address) ||
          BigInt(tx.fee) > maxFee ||
          BigInt(tx.fee) > BigInt(w.reserved_fee)
        )
          fail("SIGNING_FAILED");
        const op = tx.operations[0];
        if (
          op.type !== "invokeHostFunction" ||
          op.func.type !== "hostFunctionTypeInvokeContract"
        )
          fail("SIGNING_FAILED");
        const invoke = op.func.invokeContract;
        if (
          Address.fromScAddress(invoke.contractAddress).toString() !==
            w.contract_id ||
          invoke.functionName.toString() !== w.function_name
        )
          fail("SIGNING_FAILED");
        const expected = w.function_model.params.map(
          (p: { name: string; type: { node: Parameters<typeof encode>[0] } }) =>
            encode(p.type.node, w.arguments[p.name]),
        );
        if (
          invoke.args.length !== expected.length ||
          invoke.args.some(
            (v, n) => v.toXdr("base64") !== expected[n].toXdr("base64"),
          )
        )
          fail("SIGNING_FAILED");
        const secret = decryptKey(
          w.encrypted_key,
          key,
          `${w.agent_id}:${w.instance_id}:testnet:${w.key_version}`,
        );
        const signer = environmentSigner(secret, Networks.TESTNET);
        if (signer.address !== w.address) fail("SIGNING_FAILED");
        send(200, await signer.sign_transaction_envelope(b.payload, b.opts));
        return;
      }
      send(404, { ok: false });
    } catch (e) {
      send(403, envelope(e));
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  const main = async () => {
    const key = Buffer.from(
        readFileSync(process.env.SIGNER_MASTER_KEY_FILE!, "utf8").trim(),
        "base64",
      ),
      store = new Store(process.env.DATABASE_URL!);
    if (process.argv[2] === "rekey" || process.argv[2] === "check-key") {
      try {
        const next = Buffer.from(
          readFileSync(process.argv[3], "utf8").trim(),
          "base64",
        );
        const result =
          process.argv[2] === "rekey"
            ? await rotateMasterKey(store, key, next)
            : { ok: true, key_version: await initializeEpoch(store, next) };
        console.log(JSON.stringify(result));
      } finally {
        await store.close();
      }
      return;
    }
    const token = readFileSync(process.env.SIGNER_TOKEN_FILE!, "utf8").trim();
    const server = await signerService(store, key, token);
    server.listen(
      Number(process.env.PORT ?? 3005),
      process.env.HOST ?? "127.0.0.1",
    );
  };
  main().catch(() => {
    console.error('{"ok":false,"error_code":"SIGNER_NOT_CONFIGURED"}');
    process.exitCode = 1;
  });
}
