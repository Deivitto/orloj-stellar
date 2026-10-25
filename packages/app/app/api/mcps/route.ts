import { fetchMcps } from "@/lib/registry-mcps";

export async function GET() {
  try {
    const mcps = await fetchMcps();
    return Response.json({ mcps });
  } catch {
    return Response.json(
      { error: "Registry unavailable. Check Stellar service readiness." },
      { status: 503 },
    );
  }
}
