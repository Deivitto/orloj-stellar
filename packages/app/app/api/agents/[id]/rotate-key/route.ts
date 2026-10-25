import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { rotateTokenForAgent } from "@/lib/mcp-tokens";
import { killByAgent } from "@/lib/session/registry";

export async function POST(
  _request: Request,
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

  try {
    const issued = await rotateTokenForAgent(id, session.user.id);
    // The live process holds the now-revoked token in its config, so its MCP calls would
    // start 401-ing mid-turn. The next session start rewrites the block with this token.
    killByAgent(id);
    return Response.json({ api_key: issued.token });
  } catch (err) {
    console.error("[agents] mcp token rotation failed", err);
    return Response.json(
      { error: "Failed to rotate agent key" },
      { status: 500 },
    );
  }
}
