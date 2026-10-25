import { open } from "node:fs/promises";
import path from "node:path";

export type ProviderFailure = "context_limit" | "rate_limit" | "provider";

// Read only a bounded tail; never return or log provider bodies, keys, or traces.
export async function providerFailure(dir: string, since: number): Promise<ProviderFailure> {
  let file;
  try {
    file = await open(path.join(dir, "data/state/runtime-trace.jsonl"), "r");
    const { size } = await file.stat();
    const bytes = Buffer.alloc(Math.min(size, 65536));
    await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    let failure: ProviderFailure = "provider";
    for (const line of bytes.toString("utf8").split("\n")) {
      try {
        const row = JSON.parse(line);
        if (!(Date.parse(row["@timestamp"]) >= since)) continue;
        const a = row.attributes ?? {};
        if (a.status === 413) return "context_limit";
        if (a.status === 429 || a.error_kind === "rate_limited") failure = "rate_limit";
      } catch { /* incomplete tail record */ }
    }
    return failure;
  } catch {
    return "provider";
  } finally {
    await file?.close();
  }
}

export function chatFailureMessage(kind: ProviderFailure): string {
  const reason = kind === "context_limit"
    ? "The chat request exceeded the provider's size limit. Start a fresh chat context or select fewer MCPs."
    : kind === "rate_limit"
      ? "The model provider's free quota is temporarily exhausted. Wait before continuing."
      : "The chat provider or runtime stopped responding. Restart the chat context to continue.";
  return `${reason} A write may already be confirmed or pending: check Write operations before requesting it again. Restarting chat does not cancel or resend transactions.`;
}
