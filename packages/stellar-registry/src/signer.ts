import { contract, Keypair } from "@stellar/stellar-sdk";
export interface Signer {
  address: string;
  sign_transaction_envelope: contract.SignTransaction;
  sign_authorization_entries: contract.SignAuthEntry;
}
export function environmentSigner(
  secret: string,
  networkPassphrase: string,
): Signer {
  const kp = Keypair.fromSecret(secret);
  const callbacks = contract.basicNodeSigner(kp, networkPassphrase);
  return {
    address: kp.publicKey(),
    sign_transaction_envelope: callbacks.signTransaction,
    sign_authorization_entries: callbacks.signAuthEntry,
  };
}
