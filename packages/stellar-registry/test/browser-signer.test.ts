import { it, expect, vi } from "vitest";
import {
  Keypair,
  Account,
  Networks,
  TransactionBuilder,
  Operation,
  contract,
} from "@stellar/stellar-sdk";
import { BrowserSigner } from "../src/browser-signer.js";
import { parseConfig } from "../src/config.js";
const transaction = (kp: Keypair, amount = "1") =>
  new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: kp.publicKey(),
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(60)
    .build();
import { Asset } from "@stellar/stellar-sdk";
it("accepts only the exact transaction signed by the selected wallet", async () => {
  const kp = Keypair.random(),
    bridge = new BrowserSigner(kp.publicKey());
  const tx = transaction(kp);
  const pending = bridge.sign_transaction_envelope(tx.toXdr(), {
    networkPassphrase: Networks.TESTNET,
    address: kp.publicKey(),
  });
  const request = bridge.take()!;
  expect(bridge.take()).toBeUndefined();
  tx.sign(kp);
  bridge.complete(request.id, {
    signedTxXdr: tx.toXdr(),
    signerAddress: kp.publicKey(),
  });
  expect((await pending).signedTxXdr).toBe(tx.toXdr());
  expect(bridge.signatures).toBe(1);
});
it("rejects modified payloads, unrelated signatures, declined requests and wrong network", async () => {
  for (const test of ["modified", "wrongSigner", "declined"]) {
    const kp = Keypair.random(),
      bridge = new BrowserSigner(kp.publicKey());
    const tx = transaction(kp);
    const pending = bridge.sign_transaction_envelope(tx.toXdr(), {
      networkPassphrase: Networks.TESTNET,
    });
    const rejection = expect(pending).rejects.toThrow("signing");
    const request = bridge.take()!;
    const signed = test === "modified" ? transaction(kp, "2") : tx;
    signed.sign(test === "wrongSigner" ? Keypair.random() : kp);
    expect(() =>
      bridge.complete(
        request.id,
        test === "declined"
          ? { error: true }
          : { signedTxXdr: signed.toXdr(), signerAddress: kp.publicKey() },
      ),
    ).toThrow("signing");
    await rejection;
  }
  const b = new BrowserSigner(Keypair.random().publicKey());
  await expect(
    b.sign_transaction_envelope("not-xdr", {
      networkPassphrase: Networks.PUBLIC,
    }),
  ).rejects.toThrow("signing");
});
it("times out and closes without leaving pending signing jobs", async () => {
  const kp = Keypair.random(),
    b = new BrowserSigner(kp.publicKey(), 5);
  await expect(
    b.sign_transaction_envelope(transaction(kp).toXdr(), {
      networkPassphrase: Networks.TESTNET,
    }),
  ).rejects.toThrow("signing");
  expect(b.take()).toBeUndefined();
  const p = b.sign_transaction_envelope(transaction(kp).toXdr(), {
    networkPassphrase: Networks.TESTNET,
  });
  const assertion = expect(p).rejects.toThrow("signing");
  b.close();
  await assertion;
});
it("accepts an external testnet signer without a server private key and rejects ambiguous configuration", () => {
  const kp = Keypair.random();
  const base = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    databaseUrl: "postgres://localhost/test",
    simulationSource: kp.publicKey(),
    writeMode: true,
    externalSignerAddress: kp.publicKey(),
    maxFee: "1000",
  };
  expect(parseConfig(base).signerSecret).toBeUndefined();
  expect(() => parseConfig({ ...base, signerSecret: kp.secret() })).toThrow(
    "signer",
  );
});
it("verifies authorization signatures over the SDK callback payload", async () => {
  const kp = Keypair.random(),
    bridge = new BrowserSigner(kp.publicKey());
  const payload = Buffer.from("authorization-preimage-fixture").toString(
    "base64",
  );
  const pending = bridge.sign_authorization_entries(payload, {
    networkPassphrase: Networks.TESTNET,
    address: kp.publicKey(),
  });
  const request = bridge.take()!;
  const response = await contract
    .basicNodeSigner(kp, Networks.TESTNET)
    .signAuthEntry(payload, {
      networkPassphrase: Networks.TESTNET,
      address: kp.publicKey(),
    });
  bridge.complete(request.id, response);
  expect((await pending).signedAuthEntry).toBe(response.signedAuthEntry);
});
