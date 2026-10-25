import { readFile } from "node:fs/promises";
import { headers } from "next/headers";
import { auth } from "./auth";
import { assertAgentOwner } from "./agent-ownership";
export async function stellarRequest(
  ownerId: string,
  agentId: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const origin = process.env.STELLAR_REGISTRY_URL;
  if (!origin) throw new Error("Stellar registry is not configured");
  const token =
    process.env.STELLAR_CONTROL_TOKEN ??
    (process.env.CONTROL_TOKEN_FILE
      ? (await readFile(process.env.CONTROL_TOKEN_FILE, "utf8")).trim()
      : "");
  if (!token) throw new Error("Stellar control channel is not configured");
  const r = await fetch(
    new URL(`/control/agents/${encodeURIComponent(agentId)}/${path}`, origin),
    {
      method,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-orloj-service": token,
        "x-orloj-owner": ownerId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(35000),
    },
  );
  const result = await r.json();
  if (!r.ok) throw new Error(result.human_message ?? "Stellar request failed");
  return result;
}
export async function stellarOwner(agentId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const owned = await assertAgentOwner(agentId, session.user.id);
  return owned === true ? session.user.id : owned;
}
