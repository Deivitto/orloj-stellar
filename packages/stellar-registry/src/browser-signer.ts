import { randomUUID } from "node:crypto";
import {
  contract,
  TransactionBuilder,
  Networks,
  Keypair,
  hash,
  StrKey,
} from "@stellar/stellar-sdk";
import { fail, RegistryError } from "./errors.js";
import type { Signer } from "./signer.js";
export type SigningRequest = {
  id: string;
  kind: "transaction" | "authorization";
  payload: string;
  address: string;
  networkPassphrase: string;
};
/** In-memory callback adapter. The transport is operator-only, never an MCP tool. */
export class BrowserSigner implements Signer {
  private pending?: {
    request: SigningRequest;
    claimed: boolean;
    resolve: (value: Record<string, string>) => void;
    reject: (e: RegistryError) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  public signatures = 0;
  constructor(
    public address: string,
    private timeoutMs = 45000,
  ) {
    if (!StrKey.isValidEd25519PublicKey(address)) fail("SIGNER_NOT_CONFIGURED");
  }
  private async request(
    kind: SigningRequest["kind"],
    payload: string,
    opts?: { networkPassphrase?: string; address?: string; submit?: boolean },
  ) {
    if (
      opts?.networkPassphrase !== Networks.TESTNET ||
      opts?.submit ||
      (opts?.address && opts.address !== this.address)
    )
      fail("SIGNING_FAILED");
    if (this.pending) fail("SIGNING_FAILED");
    return new Promise<Record<string, string>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new RegistryError("SIGNING_FAILED"));
      }, this.timeoutMs);
      this.pending = {
        request: {
          id: randomUUID(),
          kind,
          payload,
          address: this.address,
          networkPassphrase: Networks.TESTNET,
        },
        claimed: false,
        resolve,
        reject,
        timer,
      };
    });
  }
  peek(): SigningRequest | undefined {
    return this.pending?.request;
  }
  take(): SigningRequest | undefined {
    if (!this.pending || this.pending.claimed) return;
    this.pending.claimed = true;
    return this.pending.request;
  }
  complete(id: string, result: unknown) {
    const pending = this.pending;
    if (!pending || pending.request.id !== id) fail("SIGNING_FAILED");
    clearTimeout(pending.timer);
    this.pending = undefined;
    try {
      if (!result || typeof result !== "object") fail("SIGNING_FAILED");
      const r = result as Record<string, unknown>;
      if (r.error || r.signerAddress !== this.address) fail("SIGNING_FAILED");
      const field =
        pending.request.kind === "transaction"
          ? "signedTxXdr"
          : "signedAuthEntry";
      if (
        typeof r[field] !== "string" ||
        (r[field] as string).length > 1024 * 1024
      )
        fail("SIGNING_FAILED");
      if (pending.request.kind === "transaction") {
        const original = TransactionBuilder.fromXdr(
            pending.request.payload,
            Networks.TESTNET,
          ),
          signed = TransactionBuilder.fromXdr(
            r[field] as string,
            Networks.TESTNET,
          );
        if (
          !("source" in original) ||
          original.source !== this.address ||
          Buffer.compare(
            Buffer.from(original.hash()),
            Buffer.from(signed.hash()),
          ) !== 0
        )
          fail("SIGNING_FAILED");
        if (
          !signed.signatures.some((sig) =>
            Keypair.fromPublicKey(this.address).verify(
              signed.hash(),
              sig.signature.value,
            ),
          )
        )
          fail("SIGNING_FAILED");
      } else {
        const bytes = Buffer.from(r[field] as string, "base64");
        if (
          bytes.length !== 64 ||
          !Keypair.fromPublicKey(this.address).verify(
            hash(Buffer.from(pending.request.payload, "base64")),
            bytes,
          )
        )
          fail("AUTHORIZATION_FAILED");
      }
      this.signatures++;
      pending.resolve({
        [field]: r[field] as string,
        signerAddress: this.address,
      });
    } catch {
      pending.reject(new RegistryError("SIGNING_FAILED"));
      fail("SIGNING_FAILED");
    }
  }
  close() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new RegistryError("SIGNING_FAILED"));
      this.pending = undefined;
    }
  }
  sign_transaction_envelope: contract.SignTransaction = async (payload, opts) =>
    this.request("transaction", payload, opts) as Promise<{
      signedTxXdr: string;
      signerAddress: string;
    }>;
  sign_authorization_entries: contract.SignAuthEntry = async (payload, opts) =>
    this.request("authorization", payload, opts) as Promise<{
      signedAuthEntry: string;
      signerAddress: string;
    }>;
}
