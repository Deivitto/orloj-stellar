// Read-only natural-language -> Groq tool choice -> real Orloj MCP execution.
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const key = (await readFile(".local/groq-key", "utf8")).trim();
const config = JSON.parse(
  await readFile(".local/top10-mainnet.mcp.json", "utf8"),
);
const mainnetEvidence = JSON.parse(
  await readFile(
    new URL(
      "../demo-contract/top10-audit/mcp-mainnet-remediation-results.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const classicPool = mainnetEvidence.projects
  .find((p) => p.project === "Stellar AMM")
  .checks.find((c) => c.ok).data.pool_id;
const prompts = {
  "Blend Pools V2": "Read the current reward zone.",
  "Stellar DeFi Hub": "Read the total assets in this vault.",
  "Aquarius Stellar": "How many token sets does this router have?",
  Upshift: "What is the name of this vault?",
  "Gami Labs": "What is the name of this vault?",
  DeFindex: "What is the name of this vault? Use its name tool.",
  "Templar Protocol": "Read the name of this experimental vault.",
  "Stellar DEX":
    "Read the account balances for GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA.",
  "Stellar AMM": `Read the reserves of classic liquidity pool ${classicPool}.`,
  "Sushi Stellar": "Read the protocol fee for token 0.",
};
const expectedTools = {
  "Blend Pools V2": "reward_zone",
  "Stellar DeFi Hub": "total_assets",
  "Aquarius Stellar": "get_tokens_sets_count",
  Upshift: "name",
  "Gami Labs": "name",
  DeFindex: "name",
  "Sushi Stellar": "get_protocol_fee_0",
  "Templar Protocol": "name",
  "Stellar DEX": "account_balances",
  "Stellar AMM": "liquidity_pool",
};
const out = {
  testedAt: new Date().toISOString(),
  model: "openai/gpt-oss-20b",
  network: "mainnet",
  mode: "READ",
  projects: [],
};
for (const [project, entry] of Object.entries(config.mcpServers)) {
  const client = new Client({
    name: "orloj-natural-language-audit",
    version: "1",
  });
  const result = { project, prompt: prompts[project] };
  out.projects.push(result);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: entry.headers },
      }),
    );
    const list = await client.listTools();
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + key,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: out.model,
          messages: [
            {
              role: "system",
              content:
                "Use the provided read-only tool to answer. Never invent results.",
            },
            { role: "user", content: prompts[project] },
          ],
          tools: list.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          })),
          tool_choice: "required",
          max_completion_tokens: 512,
          reasoning_effort: "low",
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    result.providerStatus = response.status;
    const body = await response.json();
    if (!response.ok) {
      result.errorCode = body.error?.code ?? "MODEL_REQUEST_FAILED";
      continue;
    }
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    if (!call || !list.tools.some((t) => t.name === call.function.name))
      throw Error("No declared tool selected");
    result.tool = call.function.name;
    result.expectedTool = expectedTools[project];
    result.toolMatchesRequest = result.tool === result.expectedTool;
    result.arguments = JSON.parse(call.function.arguments);
    result.mcp = (
      await client.callTool({ name: result.tool, arguments: result.arguments })
    ).structuredContent;
    result.ok =
      result.toolMatchesRequest &&
      result.mcp?.ok === true &&
      ["SIMULATED", "READ_ONLY"].includes(result.mcp?.result_status);
    console.log(JSON.stringify({ project, tool: result.tool, ok: result.ok }));
  } catch (e) {
    result.error = String(e.message).slice(0, 180);
  } finally {
    await client.close().catch(() => {});
    await writeFile(
      process.env.AUDIT_OUTPUT_FILE ??
        new URL(
          "../demo-contract/top10-audit/agent-results.json",
          import.meta.url,
        ),
      JSON.stringify(out, null, 2) + "\n",
    );
  }
}
