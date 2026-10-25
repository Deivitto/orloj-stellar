"use client";
type Reply = {
  error?: unknown;
  address?: string;
  networkPassphrase?: string;
  signedMessage?: string | Uint8Array;
  signerAddress?: string;
  signedTxXdr?: string;
  signedAuthEntry?: string;
};
type Api = {
  requestAccess: () => Promise<Reply>;
  getNetwork: () => Promise<Reply>;
  signMessage: (message: string, opts: unknown) => Promise<Reply>;
  signTransaction: (xdr: string, opts: unknown) => Promise<Reply>;
  signAuthEntry: (payload: string, opts: unknown) => Promise<Reply>;
};
declare global {
  interface Window {
    freighterApi?: Api;
  }
}
let loading: Promise<Api> | undefined;
export function freighter(): Promise<Api> {
  if (window.freighterApi) return Promise.resolve(window.freighterApi);
  if (!loading)
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/api/stellar/freighter";
      script.onload = () =>
        window.freighterApi
          ? resolve(window.freighterApi)
          : reject(new Error("Wallet SDK unavailable"));
      script.onerror = () => {
        loading = undefined;
        reject(new Error("Wallet SDK unavailable"));
      };
      document.head.append(script);
    });
  return loading;
}
export const testnetPassphrase = "Test SDF Network ; September 2015";
