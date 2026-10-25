#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
export function composeCommand(run = spawnSync) {
  for (const [command, prefix] of [
    ["docker", ["compose"]],
    ["docker-compose", []],
  ]) {
    const result = run(command, [...prefix, "version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    });
    if (result.status === 0) return { command, prefix };
  }
  throw Error(
    "Docker Compose is unavailable. Install the official Compose plugin or docker-compose, then retry.",
  );
}
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv[0] === "--help") {
    console.log(
      "Local Orloj stack: node scripts/local-stack.mjs <build|up|down|ps|logs|stop|start|restart|exec|pull|images> [arguments]. Uses .local/product.env and infra/local/compose.yaml.",
    );
    return;
  }
  if (
    ![
      "build",
      "up",
      "down",
      "ps",
      "logs",
      "stop",
      "start",
      "restart",
      "exec",
      "pull",
      "images",
    ].includes(argv[0])
  )
    throw Error("Unsupported stack command. Use --help.");
  const compose = composeCommand();
  const engine = spawnSync(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { encoding: "utf8", timeout: 10000, stdio: "pipe" },
  );
  if (engine.status !== 0)
    throw Error(
      "Docker engine is unavailable. Start the configured Docker or Colima instance, then retry. No stack command was run.",
    );
  const args = [
    ...compose.prefix,
    "--env-file",
    fileURLToPath(new URL("../.local/product.env", import.meta.url)),
    "-f",
    fileURLToPath(new URL("../infra/local/compose.yaml", import.meta.url)),
    ...argv,
  ];
  const child = spawn(compose.command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
