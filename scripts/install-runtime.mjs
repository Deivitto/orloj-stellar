import { mkdir, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const version = "0.8.6";
const targets = {
  darwin: {
    arm64: [
      "aarch64-apple-darwin",
      "7355af49b3bdee356198a5d434534dc20de62eb7f2646901e2a82a66296d1899",
    ],
    x64: [
      "x86_64-apple-darwin",
      "6d37d1eb75f8d993252b31a01001680d348a604713d6fdd7ecb0f935d7424122",
    ],
  },
  linux: {
    arm64: [
      "aarch64-unknown-linux-musl",
      "826f1852189fe76dbf1860d73d3fceb2cbe5d6cc58714bb9c64941f42ffa09a1",
    ],
    x64: [
      "x86_64-unknown-linux-musl",
      "3547ab00a5af77b76e7feedc852c733c69a178cc3e961f689cb66eb56ab4bcf9",
    ],
  },
};
const [triple, expected] = targets[process.platform]?.[process.arch] ?? [];
if (!triple) throw new Error("Unsupported runtime platform");
const r = await fetch(
  `https://github.com/zeroclaw-labs/zeroclaw/releases/download/v${version}/zeroclaw-${triple}.tar.gz`,
);
if (!r.ok) throw new Error("Runtime download failed");
const bytes = Buffer.from(await r.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw new Error("Runtime checksum mismatch");
const dir = resolve(".local/bin");
await mkdir(dir, { recursive: true });
await writeFile(resolve(dir, "zeroclaw.tar.gz"), bytes);
execFileSync("tar", ["-xzf", resolve(dir, "zeroclaw.tar.gz"), "-C", dir]);
await chmod(resolve(dir, "zeroclaw"), 0o755);
console.log(
  execFileSync(resolve(dir, "zeroclaw"), ["--version"], {
    encoding: "utf8",
  }).trim(),
);
