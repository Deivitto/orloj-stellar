import type { McpServerEntry } from "./mcp-block";

export const MAX_MCPS = 32;

// A selection that prunes to nothing. Individual names the manifest has dropped are not
// fatal — resolveMcpServers prunes them — but a selection with nothing left cannot start a
// useful session, and the caller has to be able to tell that apart from a deliberately
// empty one.
export class SelectionUnresolvableError extends Error {
  readonly dropped: string[];
  constructor(dropped: string[]) {
    super(`No selected MCP is in the registry: ${dropped.join(", ")}`);
    this.name = "SelectionUnresolvableError";
    this.dropped = dropped;
  }
}

export class RegistryUnreachableError extends Error {
  constructor(cause?: unknown) {
    super("Registry manifest unreachable");
    this.name = "RegistryUnreachableError";
    this.cause = cause;
  }
}

type ManifestEntry = {
  name: string;
  url: string;
  contractName?: string | null;
  toolNames?: string[];
};

// zeroclaw's tool prefix (`<server>__<tool>`) and the bundle's membership key. Raw registry
// names like `1_0x1c7D…` would produce ugly, near-length-limit tool names.
const sanitize = (raw: string): string => raw.replace(/[^A-Za-z0-9_]/g, "_");

export type ResolvedMcps = {
  entries: McpServerEntry[];
  // Selected names the live manifest does not publish. Reported rather than swallowed: the
  // agent silently loses those tools, so the UI has to be able to say which ones.
  dropped: string[];
};

export const resolveMcpServers = async (
  mcpNames: string[],
  bearerToken: string,
): Promise<ResolvedMcps> => {
  const registryUrl = process.env.REGISTRY_URL;
  if (!registryUrl && !process.env.STELLAR_REGISTRY_URL)
    throw new RegistryUnreachableError(new Error("No registry configured"));

  if (mcpNames.length === 0) return { entries: [], dropped: [] };

  let manifest: ManifestEntry[];
  try {
    const targets = [registryUrl, process.env.STELLAR_REGISTRY_URL].filter(
      (url): url is string => !!url,
    );
    const results = await Promise.all(
      targets.map(async (base) => {
        const res = await fetch(`${base}/mcp`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${bearerToken}` },
        });
        if (!res.ok) throw new Error("Registry manifest unavailable");
        const rows = (await res.json()) as ManifestEntry[];
        return rows.map((row) => ({
          ...row,
          url: new URL(
            row.url,
            base === process.env.STELLAR_REGISTRY_URL
              ? (process.env.STELLAR_RUNTIME_REGISTRY_URL ?? base)
              : base,
          ).toString(),
        }));
      }),
    );
    manifest = results.flat();
  } catch (err) {
    throw new RegistryUnreachableError(err);
  }

  const byName = new Map(manifest.map((m) => [m.name, m]));

  // Deterministic for a given selection: the server name is also the bundle key, so the
  // dedupe suffixes must not depend on the order the client happened to send.
  const ordered = [...new Set(mcpNames)].sort();
  const used = new Set<string>();
  const entries: McpServerEntry[] = [];
  const dropped: string[] = [];

  for (const mcpName of ordered) {
    const item = byName.get(mcpName);
    // Pruned, not fatal. A stored selection outlives the registry entries it names — an MCP
    // can be unregistered, and names minted by the pre-Rust registry (`<chainId>-<address>`)
    // do not exist under the current `<chainId>_<address>` scheme at all. Throwing here
    // bricked the agent's chat on a single dead name, because every route back to the picker
    // funnels through this same stored selection.
    if (!item) {
      dropped.push(mcpName);
      continue;
    }

    const label = item.contractName?.trim() || mcpName;
    const base =
      mcpName.startsWith("stellar_") && /^C[A-Z2-7]{55}$/.test(label)
        ? `Stellar_${label.slice(-10)}`
        : sanitize(label) || "Mcp";
    let serverName = base;
    for (let n = 2; used.has(serverName); n += 1) serverName = `${base}_${n}`;
    used.add(serverName);

    // The manifest's `url` is a path (`/interface/<name>/mcp`), not an absolute URL — the
    // same join lib/registry-mcps.ts does for the catalog. REGISTRY_URL, not
    // PUBLIC_REGISTRY_URL: zeroclaw runs on the same host as the app.
    entries.push({
      mcpName,
      serverName,
      url: mcpName.startsWith("stellar_")
        ? `${item.url}?client=zeroclaw`
        : item.url,
      approvedTools: item.toolNames ?? [],
      bearerToken,
    });
  }

  // Only when nothing survived. An empty `mcpNames` returned earlier, so reaching here with
  // no entries means every name was stale — the user has to pick again.
  if (entries.length === 0) throw new SelectionUnresolvableError(dropped);

  return { entries, dropped };
};
