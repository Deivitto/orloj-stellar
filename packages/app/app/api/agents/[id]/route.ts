import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getAgentClient } from "@/lib/agent-client";
import { assertAgentOwner, deregisterAgent } from "@/lib/agent-ownership";
import { killByAgent } from "@/lib/session/registry";
import {
  InvalidAgentIdError,
  removeConfigDir,
} from "@/lib/session/zeroclaw-config";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

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

  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) {
    return ownership;
  }

  const { data, error } = await client.agents.get(id);

  if (error || !data) {
    console.error("[agents] 1claw get failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to get agent upstream" },
      { status: 502 },
    );
  }

  return Response.json({ agent: data });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) {
    return ownership;
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

  const { error } = await client.agents.delete(id);

  if (error) {
    console.error("[agents] 1claw delete failed", error);
    return Response.json(
      { error: error?.message ?? "Failed to delete agent upstream" },
      { status: 502 },
    );
  }

  try {
    await deregisterAgent(id);
  } catch (deregisterErr) {
    console.error("[agents] ownership deregistration failed", deregisterErr);
    return Response.json(
      { error: "Failed to deregister agent ownership" },
      { status: 500 },
    );
  }

  // The dir holds this agent's bearer token in cleartext and its whole transcript; a
  // re-created agent reusing the id must not inherit a stranger's memory. Cleanup failure is
  // logged, not fatal — the agent is already gone upstream and in Postgres, so a 500 here
  // would misreport a completed deletion.
  try {
    killByAgent(id);
    await removeConfigDir(id);
  } catch (cleanupErr) {
    if (!(cleanupErr instanceof InvalidAgentIdError)) {
      console.error("[agents] session cleanup failed", cleanupErr);
    }
  }

  return Response.json({ success: true }, { status: 200 });
}
