import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { serviceAuthorized } from "./managed-signer.js";
import { fail, envelope } from "./errors.js";
import type { Product } from "./product.js";
export async function productHttp(
  p: Product,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    !url.pathname.startsWith("/control/") &&
    url.pathname !== "/mcp" &&
    url.pathname !== "/register"
  )
    return false;
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(v));
  };
  try {
    if (url.pathname === "/mcp") {
      const token = /^Bearer (\S+)$/i.exec(
        req.headers.authorization ?? "",
      )?.[1];
      const a = token ? await p.identity(token) : undefined;
      if (!a) fail("UNAUTHORIZED");
      json(await p.manifest(a));
      return true;
    }
    if (
      !serviceAuthorized(req.headers["x-orloj-service"], p.options.serviceToken)
    )
      fail("UNAUTHORIZED");
    if (url.pathname === "/control/vendor/freighter.js") {
      const bytes = await readFile(
        new URL(
          (import.meta.url.includes("/dist/") ? "../../" : "../") +
            "node_modules/@stellar/freighter-api/build/index.min.js",
          import.meta.url,
        ),
      );
      res.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "public,max-age=3600",
      });
      res.end(bytes);
      return true;
    }
    const match = /^\/control\/agents\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) fail("INVALID_ARGUMENT");
    const owner = req.headers["x-orloj-owner"];
    if (typeof owner !== "string") fail("UNAUTHORIZED");
    const a = await p.owner(owner, decodeURIComponent(match[1]));
    let b: Record<string, unknown> = {};
    if (req.method !== "GET") {
      let text = "";
      for await (const c of req) {
        text += c;
        if (Buffer.byteLength(text) > 1024 * 1024) fail("INVALID_ARGUMENT");
      }
      try {
        b = JSON.parse(text || "{}");
      } catch {
        fail("INVALID_ARGUMENT");
      }
    }
    const action = match[2];
    if (action === "state" && req.method === "GET")
      json({
        wallets: await p.wallets(a),
        policies: await p.policies(a),
        contracts: await p.manifest(a),
        operations: await p.list(a),
      });
    else if (action === "register" && req.method === "POST")
      json(await p.register(a, b));
    else if (action === "policies" && req.method === "PUT")
      json(await p.setPolicies(a, b));
    else if (action === "wallet/managed" && req.method === "POST")
      json(await p.managedWallet(a));
    else if (action === "wallet/activate" && req.method === "POST")
      json(await p.activate(a, String(b.id)));
    else if (action === "wallet/challenge" && req.method === "POST")
      json(await p.challenge(a, String(b.address)));
    else if (action === "wallet/link" && req.method === "POST")
      json(await p.link(a, String(b.id), String(b.signature)));
    else if (action === "wallet/fund" && req.method === "POST") {
      const wallet = (await p.wallets(a)).find((w) => w.id === b.id);
      if (!wallet) fail("UNAUTHORIZED");
      if (p.config.network !== "testnet") fail("WRITE_NOT_PERMITTED");
      const r = await fetch(
        "https://friendbot.stellar.org?addr=" +
          encodeURIComponent(wallet.address),
        { signal: AbortSignal.timeout(30000) },
      );
      if (!r.ok) fail("SUBMISSION_FAILED");
      json({ ok: true, address: wallet.address });
    } else if (action.startsWith("operations/")) {
      const [id, command] = action.slice(11).split("/");
      if (!command && req.method === "GET") json(await p.status(a, id));
      else if (command === "approve" && req.method === "POST")
        json(await p.approve(a, id, true));
      else if (command === "cancel" && req.method === "POST")
        json(await p.approve(a, id, false));
      else if (command === "signing" && req.method === "GET")
        json(await p.signing(a, id));
      else if (command === "signed" && req.method === "POST")
        json(await p.complete(a, id, String(b.id), b.result));
      else if (command === "reconcile" && req.method === "POST")
        json(await p.reconcile(a, id, b.proveExpired === true));
      else fail("INVALID_ARGUMENT");
    } else fail("INVALID_ARGUMENT");
  } catch (e) {
    json(envelope(e), 403);
  }
  return true;
}
