import { stellarOwner, stellarRequest } from "@/lib/stellar";
async function handle(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await params;
  const owner = await stellarOwner(id);
  if (owner instanceof Response) return owner;
  const expected = new URL(
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  ).origin;
  if (request.method !== "GET" && request.headers.get("origin") !== expected)
    return Response.json({ error: "Origin not permitted" }, { status: 403 });
  try {
    const text = request.method === "GET" ? undefined : await request.text();
    if (text && Buffer.byteLength(text) > 1024 * 1024)
      return Response.json({ error: "Request too large" }, { status: 413 });
    const data = await stellarRequest(
      owner,
      id,
      path.map(encodeURIComponent).join("/"),
      request.method,
      text ? JSON.parse(text) : undefined,
    );
    return Response.json(data, {
      headers: { "cache-control": "private,no-store" },
    });
  } catch {
    return Response.json(
      {
        error:
          "Stellar request failed. Check the registry connection, wallet and permissions.",
      },
      { status: 502 },
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
