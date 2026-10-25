import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANAGED_MARKER =
  "# >>> orloj-managed — regenerated on every session start; do not edit below this line";

const SIDECAR = "orloj-mcps.json";
const BUNDLE = "remote";

export type McpServerEntry = {
  mcpName: string;
  serverName: string;
  url: string;
  bearerToken: string;
  approvedTools?: string[];
};

export type McpSelectionItem = { mcpName: string; serverName: string };

// TOML basic string. URLs come from the registry manifest and names are sanitized, so
// nothing hostile is expected — the escaper is here so that stops being load-bearing.
const toml = (value: string): string => {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(
      /[\u0000-\u001f\u007f]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return `"${escaped}"`;
};

const renderBlock = (entries: McpServerEntry[]): string => {
  const servers = entries
    .map(
      (e) =>
        `[[mcp.servers]]\nname = ${toml(e.serverName)}\ntransport = "http"\nurl = ${toml(
          e.url,
        )}\nheaders = { Authorization = ${toml(`Bearer ${e.bearerToken}`)} }\n`,
    )
    .join("\n");
  // The bundle table is emitted even for an empty selection: the template's
  // `mcp_bundles = ["remote"]` grant would otherwise dangle and fail Config::validate().
  const bundle = `[mcp_bundles.${BUNDLE}]\nservers = [${entries
    .map((e) => toml(e.serverName))
    .join(", ")}]\n`;
  return `${MANAGED_MARKER}\n${servers}${servers ? "\n" : ""}${bundle}`;
};

const configPath = (dir: string) => path.join(dir, "config.toml");
const sidecarPath = (dir: string) => path.join(dir, SIDECAR);

// Atomic: a crash mid-write must not leave zeroclaw a truncated config.
const writeAtomic = async (target: string, contents: string): Promise<void> => {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, target);
};

// renderBlock owns `[mcp_bundles.remote]`, so nothing above the marker may declare it too —
// that is a TOML duplicate key, and zeroclaw answers a malformed config by resetting the WHOLE
// config to defaults for the run, which drops [agents.default] and fails session/new with
// `Unknown agent default`. Every config dir provisioned while the template still carried its
// own `servers = []` stub holds exactly that second copy, so strip it on the way past: those
// dirs repair themselves on their next start and keep their transcripts and provider key,
// instead of having to be deleted. Also the one guard against the stub coming back.
const stripManagedBundle = (head: string): string => {
  const kept: string[] = [];
  let dropping = false;
  for (const line of head.split("\n")) {
    // Any table header ends the previous table, and `[[mcp.servers]]` counts — otherwise a
    // stale bundle would swallow every line to the end of the head.
    if (/^\s*\[/.test(line))
      dropping = /^\s*\[mcp_bundles\.remote\]\s*$/.test(line);
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
};

export const writeMcpSelection = async (
  dir: string,
  entries: McpServerEntry[],
): Promise<McpSelectionItem[]> => {
  const current = await readFile(configPath(dir), "utf8");
  const idx = current.indexOf(MANAGED_MARKER);
  // Append-and-truncate, not parse-and-reserialize: everything a human wrote above the
  // marker keeps its bytes and its order, and there is no TOML dependency.
  const raw =
    idx === -1 ? current.replace(/\s*$/, "\n\n") : current.slice(0, idx);
  const head = stripManagedBundle(raw);
  await writeAtomic(configPath(dir), `${head}${renderBlock(entries)}`);

  const selection: McpSelectionItem[] = entries.map((e) => ({
    mcpName: e.mcpName,
    serverName: e.serverName,
  }));
  await writeAtomic(
    sidecarPath(dir),
    `${JSON.stringify(selection, null, 2)}\n`,
  );
  return selection;
};

// Derives the selection from the managed block when the sidecar is missing — a dir made by
// an older build or by hand — and rewrites the sidecar so the next read is cheap.
const deriveFromBlock = (config: string): McpSelectionItem[] => {
  const idx = config.indexOf(MANAGED_MARKER);
  if (idx === -1) return [];
  const block = config.slice(idx);
  const items: McpSelectionItem[] = [];
  const re =
    /\[\[mcp\.servers\]\][^[]*?name\s*=\s*"([^"]+)"[^[]*?url\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const [, serverName, url] = m;
    const stellar = /\/contracts\/(C[A-Z2-7]{55})\/mcp/.exec(url)?.[1];
    const mcpName = stellar
      ? `stellar_testnet_${stellar}`
      : /\/interface\/([^/]+)\/mcp/.exec(url)?.[1];
    if (mcpName)
      items.push({ mcpName: decodeURIComponent(mcpName), serverName });
  }
  return items;
};

export const readMcpSelection = async (
  dir: string,
): Promise<McpSelectionItem[]> => {
  try {
    const raw = await readFile(sidecarPath(dir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          typeof (i as McpSelectionItem).mcpName === "string" &&
          typeof (i as McpSelectionItem).serverName === "string",
      )
    ) {
      return parsed as McpSelectionItem[];
    }
  } catch {
    // fall through to the block
  }
  let config: string;
  try {
    config = await readFile(configPath(dir), "utf8");
  } catch {
    return [];
  }
  const derived = deriveFromBlock(config);
  try {
    await writeAtomic(
      sidecarPath(dir),
      `${JSON.stringify(derived, null, 2)}\n`,
    );
  } catch {
    // A read must not fail because the cache could not be refreshed.
  }
  return derived;
};
