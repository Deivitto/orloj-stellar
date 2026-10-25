import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(".local");
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(resolve(root, "secrets"), { recursive: true, mode: 0o700 });
for (const file of [
  "control",
  "signer",
  "runtime",
  "master",
  "auth",
  "database",
]) {
  try {
    await writeFile(
      resolve(root, "secrets", file),
      randomBytes(32).toString(file === "master" ? "base64" : "base64url") +
        "\n",
      { mode: 0o600, flag: "wx" },
    );
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
const password = (
    await readFile(resolve(root, "secrets/database"), "utf8")
  ).trim(),
  auth = (await readFile(resolve(root, "secrets/auth"), "utf8")).trim();
const lines = [
  `POSTGRES_PASSWORD=${password}`,
  `BETTER_AUTH_SECRET=${auth}`,
  "SIMULATION_SOURCE=GAKOUU3TK4VZQEOKAYCGLGXILNXS2TC43KC63CGFIZDJWPYBS2Y7KPTK",
  "ZEROCLAW_MODEL_API_KEY=",
  "ZEROCLAW_MODEL_URL=https://router-api.0g.ai/v1",
  "ZEROCLAW_MODEL=qwen3.7-max",
];
try {
  await writeFile(resolve(root, "product.env"), lines.join("\n") + "\n", {
    mode: 0o600,
    flag: "wx",
  });
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}
await chmod(resolve(root, "product.env"), 0o600);
console.log(
  "Private local configuration: .local/product.env\nFor optional in-app chat, configure a model provider key privately there. Existing secrets were preserved.",
);
