import { stellarOwner, stellarRequest } from "@/lib/stellar";
import { getActiveTokenForAgent } from "@/lib/mcp-tokens";
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("agentId");
  if (!id)
    return Response.json({ error: "agentId is required" }, { status: 400 });
  const owner = await stellarOwner(id);
  if (owner instanceof Response) return owner;
  const token = await getActiveTokenForAgent(id);
  if (!token)
    return Response.json(
      { error: "Agent credential unavailable" },
      { status: 409 },
    );
  try {
    const state = await stellarRequest(owner, id, "state");
    const origin =
      process.env.PUBLIC_STELLAR_REGISTRY_URL ?? "http://localhost:3002";
    return Response.json(
      {
        mcpServers: Object.fromEntries(
          state.contracts.map((c: { name: string; url: string }) => [
            c.name,
            {
              url: new URL(c.url, origin).toString(),
              headers: { Authorization: `Bearer ${token}` },
            },
          ]),
        ),
      },
      { headers: { "cache-control": "private,no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Stellar registry unavailable" },
      { status: 503 },
    );
  }
}
