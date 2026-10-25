import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { permitted } from "./config.js";
import { envelope, fail, RegistryError } from "./errors.js";
import { validator } from "./codec.js";
import { z } from "zod";
import { contractId } from "./ingestion.js";
import type { ContractInterface, FunctionModel } from "./model.js";
import { Executor } from "./executor.js";
export function inputSchema(f: FunctionModel) {
  const props: Record<string, z.ZodType> = {};
  for (const p of f.params)
    props[p.name] = p.required
      ? validator(p.type.node)
      : validator(p.type.node).optional();
  if (f.mode === "WRITE")
    props.idempotency_key = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/);
  return z.toJSONSchema(z.strictObject(props));
}
export function mcp(
  executor: Executor,
  i: ContractInterface,
  principal: string,
) {
  const server = new Server(
    { name: "orloj-stellar", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const available = () =>
    i.functions.filter((f) => {
      const p = permitted(
        executor.config,
        i.contractId,
        f.sorobanName,
        principal,
      );
      return (
        p?.mode === f.mode &&
        (f.mode === "READ" ||
          (executor.config.writeMode && !!executor.signer)) &&
        !f.params.some(
          (p) => p.name === "idempotency_key" && f.mode === "WRITE",
        )
      );
    });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: available().map((f) => ({
      name: f.mcpToolName,
      description: f.description,
      inputSchema: inputSchema(f) as {
        type: "object";
        properties: Record<string, unknown>;
      },
      annotations: {
        readOnlyHint: f.mode === "READ",
        destructiveHint: f.mode === "WRITE",
        idempotentHint: f.mode === "READ",
        openWorldHint: true,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    let result: Record<string, unknown>;
    try {
      const f = available().find((f) => f.mcpToolName === req.params.name);
      if (!f) fail("WRITE_NOT_PERMITTED");
      const args = { ...(req.params.arguments ?? {}) };
      let key: string | undefined;
      if (f.mode === "WRITE") {
        key = args.idempotency_key as string;
        delete args.idempotency_key;
      }
      const start = Date.now();
      result = await executor.call(i, f, args, principal, key);
      console.error(
        JSON.stringify({
          event: "tool_call",
          contract_id: i.contractId,
          function_name: f.sorobanName,
          mode: f.mode,
          duration_ms: Date.now() - start,
          ok: result.ok,
          error_code: result.error_code,
          transaction_hash: result.transaction_hash,
        }),
      );
    } catch (e) {
      result = envelope(e);
    }
    return {
      isError: result.ok === false,
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  });
  return server;
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export function httpServer(executor: Executor) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/readyz") {
        if (
          !(
            await executor.store.pool.query(
              "SELECT version FROM stellar_migrations WHERE version=2",
            )
          ).rowCount
        )
          fail("INTERNAL_ERROR");
        const net = await executor.server.getNetwork();
        if (net.passphrase !== executor.config.networkPassphrase)
          fail("INVALID_ARGUMENT");
        if (executor.config.writeMode && !executor.signer)
          fail("SIGNER_NOT_CONFIGURED");
        json(res, 200, { ok: true });
        return;
      }
      const token = /^Bearer (\S+)$/i.exec(
        req.headers.authorization ?? "",
      )?.[1];
      const principal = token
        ? await executor.store.authenticate(token)
        : undefined;
      if (!principal) {
        res.setHeader("www-authenticate", "Bearer");
        json(res, 401, envelope(new RegistryError("UNAUTHORIZED")));
        return;
      }
      const match = /^\/contracts\/(C[A-Z2-7]+)\/mcp$/.exec(url.pathname);
      if (!match) {
        json(res, 404, { ok: false });
        return;
      }
      const id = contractId(match[1]);
      const i = await executor.store.get(executor.config.network, id);
      if (
        !i ||
        !executor.config.policies.some(
          (p) => p.contractId === id && p.principals.includes(principal),
        )
      ) {
        json(res, 404, { ok: false });
        return;
      }
      // Guard browser-origin access even on loopback deployments.
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host) {
          json(res, 403, envelope(new RegistryError("UNAUTHORIZED")));
          return;
        }
      }
      await executor.store.rate(principal, id, executor.config.rateLimit);
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        json(res, 405, { ok: false });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) fail("INVALID_ARGUMENT");
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        fail("INVALID_ARGUMENT");
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = mcp(executor, i, principal);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(res, 503, envelope(e));
      else res.end();
    }
  });
}
