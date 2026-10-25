#!/usr/bin/env node
// Stdio adapter. Only the trusted app process gets the broker credential.
import { request } from "node:http";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2),
  index = args.indexOf("--config-dir"),
  directory = args[index + 1];
const id =
  /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
    directory ?? "",
  )?.[1];
const action =
  args[0] === "acp"
    ? "acp"
    : args[0] === "config" && args[1] === "patch"
      ? "patch"
      : undefined;
if (
  !id ||
  !action ||
  !process.env.RUNTIME_BROKER_URL ||
  !process.env.RUNTIME_TOKEN_FILE
) {
  console.error("Runtime broker configuration is invalid");
  process.exit(1);
}
const stamp = JSON.parse(
  readFileSync(directory + "/.orloj-owner.json", "utf8"),
);
if (!/^[0-9a-f-]{36}$/.test(stamp.instanceId))
  throw new Error("Runtime identity unavailable");
const req = request(
  new URL("/run", process.env.RUNTIME_BROKER_URL),
  {
    method: "POST",
    headers: {
      "x-orloj-runtime": readFileSync(
        process.env.RUNTIME_TOKEN_FILE,
        "utf8",
      ).trim(),
      "x-orloj-agent": id,
      "x-orloj-action": action,
      "x-orloj-instance": stamp.instanceId,
    },
  },
  (res) => {
    if (res.statusCode !== 200) {
      console.error("Runtime unavailable");
      process.exitCode = 1;
      res.resume();
      return;
    }
    res.pipe(process.stdout, { end: false });
    res.on("end", () => {
      process.exitCode = Number(res.trailers["x-runtime-exit"] ?? 0);
      process.stdin.unpipe(req);
      process.stdin.pause();
      req.end();
      req.destroy();
    });
  },
);
req.on("error", () => {
  console.error("Runtime broker unavailable");
  process.exitCode = 1;
});
process.stdin.pipe(req);
process.on("SIGTERM", () => {
  req.destroy();
  process.exit(0);
});
