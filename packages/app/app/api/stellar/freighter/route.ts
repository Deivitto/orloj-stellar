import { readFile } from "node:fs/promises";
export async function GET() {
  const token =
    process.env.STELLAR_CONTROL_TOKEN ??
    (process.env.CONTROL_TOKEN_FILE
      ? (await readFile(process.env.CONTROL_TOKEN_FILE, "utf8")).trim()
      : "");
  if (!process.env.STELLAR_REGISTRY_URL || !token)
    return new Response("Wallet SDK unavailable", { status: 503 });
  try {
    const r = await fetch(
      new URL("/control/vendor/freighter.js", process.env.STELLAR_REGISTRY_URL),
      {
        headers: { "x-orloj-service": token },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!r.ok) throw new Error();
    return new Response(await r.text(), {
      headers: {
        "content-type": "text/javascript",
        "cache-control": "public,max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Wallet SDK unavailable", { status: 503 });
  }
}
