import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fail } from "./errors.js";
import type { ContractInterface } from "./model.js";
export type Attempt = {
  id: string;
  principal: string;
  network: string;
  idempotency_key: string;
  fingerprint: string;
  source_account: string;
  request: Record<string, unknown>;
  state: string;
  transaction_hash: string | null;
  response: Record<string, unknown> | null;
};
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((v as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export class Store {
  pool: pg.Pool;
  private lockPool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    });
    this.pool.on("error", () => {});
    // Waiting for an account lock must not exhaust connections used to persist its owner.
    this.lockPool = new pg.Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 5000,
      query_timeout: 120000,
    });
    this.lockPool.on("error", () => {});
  }
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('stellar_migrations',0))",
      );
      await client.query(
        "CREATE TABLE IF NOT EXISTS stellar_migrations(version integer PRIMARY KEY)",
      );
      for (const [version, file] of [
        [1, "001_initial.sql"],
        [2, "002_rate_limits.sql"],
        [3, "003_interface_identity.sql"],
        [4, "004_local_product.sql"],
        [5, "005_app_identity.sql"],
        [6, "006_signer_epoch.sql"],
        [7, "007_classic_adapters.sql"],
        [8, "008_exact_grants.sql"],
      ] as const) {
        const seen = await client.query(
          "SELECT version FROM stellar_migrations WHERE version=$1",
          [version],
        );
        if (!seen.rowCount) {
          await client.query(
            await readFile(
              new URL(
                (import.meta.url.includes("/dist/")
                  ? "../../migrations/"
                  : "../migrations/") + file,
                import.meta.url,
              ),
              "utf8",
            ),
          );
          await client.query("INSERT INTO stellar_migrations VALUES($1)", [
            version,
          ]);
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async intent(
    client: pg.PoolClient,
    id: string,
    hash: string,
    sequence: string,
    maxTime: string,
    guard?: (client: pg.PoolClient) => Promise<void>,
  ) {
    await client.query("BEGIN");
    try {
      if (guard) await guard(client);
      const r = await client.query(
        "UPDATE stellar_write_attempts SET state='INTENT',transaction_hash=$2,signed_sequence=$3,signed_max_time=$4,updated_at=now() WHERE id=$1 AND state='PREPARING' RETURNING id",
        [id, hash, sequence, maxTime],
      );
      if (!r.rowCount) fail("WRITE_NOT_PERMITTED");
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
  async rate(principal: string, contract: string, limit: number) {
    const minute = Math.floor(Date.now() / 60000);
    const result = await this.pool.query(
      "INSERT INTO stellar_rate_limits(principal,contract_id,minute,count) VALUES($1,$2,$3,1) ON CONFLICT(principal,contract_id,minute) DO UPDATE SET count=stellar_rate_limits.count+1 RETURNING count",
      [principal, contract, minute],
    );
    if (Number(result.rows[0].count) > limit) fail("RATE_LIMITED");
    await this.pool.query("DELETE FROM stellar_rate_limits WHERE minute<$1", [
      minute - 2,
    ]);
  }
  async save(i: ContractInterface) {
    await this.pool.query(
      "INSERT INTO stellar_interfaces(network,contract_id,wasm_hash,interface,source_kind,interface_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(network,contract_id,interface_hash) DO UPDATE SET interface=EXCLUDED.interface,created_at=now()",
      [
        i.network,
        i.contractId,
        i.wasmHash ?? null,
        i,
        i.sourceKind ?? "wasm",
        i.interfaceHash ?? i.wasmHash,
      ],
    );
  }
  async get(
    network: string,
    id: string,
  ): Promise<ContractInterface | undefined> {
    const r = await this.pool.query(
      "SELECT interface FROM stellar_interfaces WHERE network=$1 AND contract_id=$2 ORDER BY created_at DESC LIMIT 1",
      [network, id],
    );
    return r.rows[0]?.interface;
  }
  async credential(token: string, principal: string) {
    await this.pool.query(
      "INSERT INTO stellar_credentials(token_hash,principal) VALUES($1,$2) ON CONFLICT(token_hash) DO UPDATE SET principal=EXCLUDED.principal,revoked=false",
      [digest(token), principal],
    );
  }
  async authenticate(token: string) {
    return (
      await this.pool.query(
        "SELECT principal FROM stellar_credentials WHERE token_hash=$1 AND NOT revoked",
        [digest(token)],
      )
    ).rows[0]?.principal as string | undefined;
  }
  async revoke(token: string) {
    await this.pool.query(
      "UPDATE stellar_credentials SET revoked=true WHERE token_hash=$1",
      [digest(token)],
    );
  }
  async lock<T>(
    network: string,
    account: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await this.lockPool.connect();
    const key = network + ":" + account;
    try {
      await c.query("SET statement_timeout='120s'");
      await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      return await fn(c);
    } finally {
      try {
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          key,
        ]);
        c.release();
      } catch {
        c.release(true);
      }
    }
  }
  async find(
    principal: string,
    network: string,
    key: string,
  ): Promise<Attempt | undefined> {
    return (
      await this.pool.query(
        "SELECT * FROM stellar_write_attempts WHERE principal=$1 AND network=$2 AND idempotency_key=$3",
        [principal, network, key],
      )
    ).rows[0];
  }
  async begin(
    client: pg.PoolClient,
    input: Omit<Attempt, "id" | "state" | "transaction_hash" | "response">,
  ): Promise<Attempt> {
    const id = randomUUID();
    try {
      await client.query(
        "UPDATE stellar_write_attempts SET state='ABANDONED' WHERE network=$1 AND source_account=$2 AND state='PREPARING'",
        [input.network, input.source_account],
      );
      const r = await client.query(
        "INSERT INTO stellar_write_attempts(id,principal,network,idempotency_key,fingerprint,source_account,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,'PREPARING') ON CONFLICT(principal,network,idempotency_key) DO NOTHING RETURNING *",
        [
          id,
          input.principal,
          input.network,
          input.idempotency_key,
          input.fingerprint,
          input.source_account,
          input.request,
        ],
      );
      if (r.rows[0]) return r.rows[0];
      const prior = await this.find(
        input.principal,
        input.network,
        input.idempotency_key,
      );
      if (!prior || prior.fingerprint !== input.fingerprint)
        fail("IDEMPOTENCY_CONFLICT");
      return prior;
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        fail("WRITE_NOT_PERMITTED");
      throw e;
    }
  }
  async update(
    id: string,
    state: string,
    response?: Record<string, unknown>,
    hash?: string,
  ) {
    const r = await this.pool.query(
      "UPDATE stellar_write_attempts SET state=$2,response=COALESCE($3,response),transaction_hash=COALESCE($4,transaction_hash),updated_at=now() WHERE id=$1 AND state NOT IN ('SUCCESS','FAILED','REJECTED','ABANDONED') AND ($2<>'INTENT' OR state='PREPARING') RETURNING response",
      [id, state, response ?? null, hash ?? null],
    );
    if (!r.rowCount && state === "INTENT") fail("WRITE_NOT_PERMITTED");
    if (r.rowCount) return r.rows[0].response as Record<string, unknown> | null;
    return (
      await this.pool.query(
        "SELECT response FROM stellar_write_attempts WHERE id=$1",
        [id],
      )
    ).rows[0]?.response as Record<string, unknown> | null;
  }
  async close() {
    await Promise.all([this.pool.end(), this.lockPool.end()]);
  }
}
