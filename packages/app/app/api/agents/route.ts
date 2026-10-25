import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getAgentClient } from "@/lib/agent-client";
import { registerAgent, listAgentIdsForUser } from "@/lib/agent-ownership";
import { getActiveTokenForAgent, issueTokenForAgent } from "@/lib/mcp-tokens";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let client;
  try {
    client = await getAgentClient();
  } catch (err) {
    console.error("[agents] 1claw client init failed", err);
    return Response.json(
      { error: "Agent service is not configured" },
      { status: 503 },
    );
  }

  const [ownedIds, listResult] = await Promise.all([
    listAgentIdsForUser(session.user.id),
    client.agents.list(),
  ]);

  const { data, error } = listResult;
  if (error || !data) {
    console.error("[agents] 1claw list failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to list agents upstream" },
      { status: 502 },
    );
  }

  const owned = data.agents.filter((a) => ownedIds.has(a.id));

  const enriched = await Promise.all(
    owned.map(async (a) => ({
      ...a,
      api_key: await getActiveTokenForAgent(a.id),
    })),
  );

  return Response.json({ agents: enriched });
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const { name, description, scopes } = body as Record<string, unknown>;

  if (typeof name !== "string") {
    return Response.json({ error: "`name` must be a string" }, { status: 400 });
  }

  const trimmedName = name.trim();

  if (trimmedName.length === 0 || trimmedName.length > NAME_MAX) {
    return Response.json(
      { error: `\`name\` must be 1–${NAME_MAX} characters` },
      { status: 400 },
    );
  }

  if (description && typeof description !== "string") {
    return Response.json(
      { error: "`description` must be a string" },
      { status: 400 },
    );
  }

  const trimmedDescription = description
    ? (description as string).trim()
    : undefined;

  if (trimmedDescription && trimmedDescription.length > DESCRIPTION_MAX) {
    return Response.json(
      { error: `\`description\` must be ≤ ${DESCRIPTION_MAX} characters` },
      { status: 400 },
    );
  }

  let client;
  try {
    client = await getAgentClient();
  } catch (err) {
    console.error("[agents] 1claw client init failed", err);
    return Response.json(
      { error: "Agent service is not configured" },
      { status: 503 },
    );
  }

  const { data, error } = await client.agents.create({
    name: trimmedName,
    description: trimmedDescription,
    scopes: scopes && Array.isArray(scopes) ? (scopes as string[]) : [],
    intents_api_enabled: false,
  });

  if (error || !data) {
    console.error("[agents] 1claw create failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to create agent upstream" },
      { status: 502 },
    );
  }

  try {
    await registerAgent(data.agent.id, session.user.id);
  } catch (registerErr) {
    console.error(
      "[agents] ownership registration failed; rolling back upstream agent",
      registerErr,
    );
    const { error: rollbackError } = await client.agents.delete(data.agent.id);
    if (rollbackError) {
      console.error(
        `[agents] rollback delete failed for orphan agent ${data.agent.id}`,
        rollbackError,
      );
    }
    return Response.json(
      { error: "Failed to register agent ownership" },
      { status: 500 },
    );
  }

  let issued;
  try {
    issued = await issueTokenForAgent(data.agent.id, session.user.id);
  } catch (tokenErr) {
    console.error(
      "[agents] mcp token issuance failed; rolling back upstream agent",
      tokenErr,
    );
    const { error: rollbackError } = await client.agents.delete(data.agent.id);
    if (rollbackError) {
      console.error(
        `[agents] rollback delete failed for orphan agent ${data.agent.id}`,
        rollbackError,
      );
    }
    return Response.json(
      { error: "Failed to issue MCP API key" },
      { status: 500 },
    );
  }

  return Response.json(
    { agent: data.agent, api_key: issued.token },
    { status: 201 },
  );
}
