import { stellarOwner, stellarRequest } from "@/lib/stellar";
export async function POST(request: Request) {
  const parsed = await request
    .clone()
    .json()
    .catch(() => null);
  if (parsed?.family === "stellar" || parsed?.contractId || parsed?.asset) {
    if (typeof parsed.agentId !== "string")
      return Response.json({ error: "agentId is required" }, { status: 400 });
    const owner = await stellarOwner(parsed.agentId);
    if (owner instanceof Response) return owner;
    if (
      request.headers.get("origin") !==
      new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin
    )
      return Response.json({ error: "Origin not permitted" }, { status: 403 });
    try {
      return Response.json(
        await stellarRequest(
          owner,
          parsed.agentId,
          "register",
          "POST",
          parsed.asset
            ? { asset: parsed.asset }
            : { contractId: parsed.contractId },
        ),
      );
    } catch {
      return Response.json(
        { error: "Stellar registration failed" },
        { status: 502 },
      );
    }
  }
  const registryUrl = process.env.REGISTRY_URL;
  if (!registryUrl) {
    return Response.json(
      { error: "REGISTRY_URL not configured" },
      { status: 500 },
    );
  }
  const publicRegistryUrl = process.env.PUBLIC_REGISTRY_URL ?? registryUrl;
  try {
    const body = await request.json();
    const res = await fetch(`${registryUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && typeof data.url === "string") {
      data.mcpUrl = `${publicRegistryUrl}${data.url}`;
    }
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
