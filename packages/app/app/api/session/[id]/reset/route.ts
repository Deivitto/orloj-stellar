import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getSession, resetSession } from "@/lib/session/registry";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const entry = getSession(id, session.user.id);
  if (!entry) return Response.json({ error: "Session expired" }, { status: 410 });
  if (entry.busy) return Response.json({ error: "Session busy" }, { status: 409 });

  try {
    // Prefer a warm context reset; a dead child is recreated with a new session ID.
    // Neither path replays prompts or changes durable Stellar operations.
    const result = await resetSession(id, session.user.id);
    if (!result) return Response.json({ error: "Session expired" }, { status: 410 });
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "SESSION_BUSY")
      return Response.json({ error: "Session busy" }, { status: 409 });
    console.error("[session] reset failed");
    return Response.json({ error: "Failed to reset session" }, { status: 500 });
  }
}
