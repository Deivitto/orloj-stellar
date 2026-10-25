import { Keypair, rpc } from "@stellar/stellar-sdk";
import { writeFile, readFile, chmod } from "node:fs/promises";
async function main() {
  const file = new URL("../.env.demo", import.meta.url);
  let key;
  try {
    const env = await readFile(file, "utf8");
    key = Keypair.fromSecret(/^STELLAR_SIGNER_SECRET=(.+)$/m.exec(env)[1]);
  } catch {
    key = Keypair.random();
    await writeFile(
      file,
      `DATABASE_URL=${process.env.DATABASE_URL ?? "postgres://orloj:local-development-only@127.0.0.1:55432/orloj_stellar"}\nSTELLAR_NETWORK=testnet\nSTELLAR_RPC_URL=https://soroban-testnet.stellar.org\nSIMULATION_SOURCE=${key.publicKey()}\nSTELLAR_SIGNER_SECRET=${key.secret()}\nMAX_FEE=2000000\nWRITE_MODE=false\n`,
      { mode: 0o600, flag: "wx" },
    );
  }
  await chmod(file, 0o600);
  const server = new rpc.Server("https://soroban-testnet.stellar.org", {
    timeout: 15000,
  });
  try {
    await server.getAccount(key.publicKey());
  } catch {
    await server.fundAddress(key.publicKey());
  }
  console.log(
    JSON.stringify({
      ok: true,
      source: key.publicKey(),
      environment_file: file.pathname,
    }),
  );
}
main().catch(() => {
  console.error(JSON.stringify({ ok: false, error_code: "DEMO_FAILED" }));
  process.exitCode = 1;
});
