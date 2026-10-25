import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
async function main() {
  const env = Object.fromEntries(
    (await readFile(new URL("../.env.demo", import.meta.url), "utf8"))
      .trim()
      .split("\n")
      .map((s) => {
        const i = s.indexOf("=");
        return [s.slice(0, i), s.slice(i + 1)];
      }),
  );
  const wasm = new URL(
    "../demo-contract/artifacts/orloj_stellar_demo.wasm",
    import.meta.url,
  );
  const r = spawnSync(
    "stellar",
    [
      "contract",
      "deploy",
      "--wasm",
      wasm.pathname,
      "--source-account",
      env.SIMULATION_SOURCE,
      "--network",
      "testnet",
      "--quiet",
      "--optimize=false",
    ],
    {
      env: { ...process.env, STELLAR_SIGN_WITH_KEY: env.STELLAR_SIGNER_SECRET },
      encoding: "utf8",
      timeout: 120000,
    },
  );
  if (r.status !== 0) {
    console.error(
      JSON.stringify({ ok: false, error_code: "DEPLOYMENT_FAILED" }),
    );
    process.exit(1);
  }
  const id = r.stdout
    .trim()
    .split("\n")
    .find((s) => /^C[A-Z2-7]{55}$/.test(s));
  if (!id) throw new Error("Deployment did not return a contract ID");
  const receipt = {
    network: "testnet",
    contractId: id,
    wasmHash: createHash("sha256")
      .update(await readFile(wasm))
      .digest("hex"),
    deployedAt: new Date().toISOString(),
  };
  await writeFile(
    new URL("../demo-contract/deployment.json", import.meta.url),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
}
main().catch(() => {
  console.error(JSON.stringify({ ok: false, error_code: "DEMO_FAILED" }));
  process.exitCode = 1;
});
