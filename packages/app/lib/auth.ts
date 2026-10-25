import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { magicLink, siwe } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import { Resend } from "resend";
import { renderMagicLinkEmail } from "./magic-link-email";
import {
  createPublicClient,
  getAddress,
  http,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { normalize } from "viem/ens";
import { parseSiweMessage } from "viem/siwe";
import { resolveEnsChain } from "./chains";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const siweDomain = new URL(baseURL).host;

let resendClient: Resend | null = null;
const getResend = () => {
  if (!resendClient) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    resendClient = new Resend(key);
  }
  return resendClient;
};
const emailFrom = process.env.EMAIL_FROM ?? "Orloj <onboarding@resend.dev>";

const ENS_TIMEOUT_MS = 3000;
const {
  chain: ensChain,
  rpcUrl: ensRpcUrl,
  key: ensChainKey,
} = resolveEnsChain();
console.log(`[auth] ENS lookups via ${ensChainKey} (${ensRpcUrl})`);
const ensClient = createPublicClient({
  chain: ensChain,
  transport: http(ensRpcUrl, { timeout: ENS_TIMEOUT_MS }),
});

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race<T | null>([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

const lookupEnsProfile = async (address: Address) => {
  const name = await withTimeout(
    ensClient.getEnsName({ address }),
    ENS_TIMEOUT_MS,
  );
  if (!name) return { name: null, avatar: null } as const;
  const avatar = await withTimeout(
    ensClient.getEnsAvatar({ name: normalize(name) }),
    ENS_TIMEOUT_MS,
  );
  return { name, avatar: avatar ?? null } as const;
};

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === "false"
        ? false
        : { rejectUnauthorized: true },
  }),
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const { html, text } = renderMagicLinkEmail(url);
        if (process.env.LOCAL_MAILBOX_URL) {
          if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname))
            throw new Error(
              "Local email delivery requires a loopback app origin",
            );
          const response = await fetch(
            new URL("/api/v1/send", process.env.LOCAL_MAILBOX_URL),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                From: { Email: "login@orloj.local", Name: "Orloj" },
                To: [{ Email: email }],
                Subject: "Your sign-in link to Orloj",
                HTML: html,
                Text: text,
              }),
            },
          );
          if (!response.ok) throw new Error("Local mailbox unavailable");
          return;
        }
        const { error } = await getResend().emails.send({
          from: emailFrom,
          to: email,
          subject: "Your sign-in link to Orloj",
          html,
          text,
        });
        if (error) {
          console.error("[auth] resend send failed:", error);
          throw new Error(error.message ?? "Failed to send magic link");
        }
      },
    }),
    siwe({
      domain: siweDomain,
      anonymous: true,
      getNonce: async () => randomBytes(16).toString("hex"),
      verifyMessage: async ({ message, signature, address, cacao }) => {
        const fields = parseSiweMessage(message);

        if (!fields.nonce || fields.nonce !== cacao?.p.nonce) return false;
        if (!fields.domain || fields.domain !== cacao.p.domain) return false;
        if (
          !fields.address ||
          fields.address.toLowerCase() !== address.toLowerCase()
        )
          return false;
        const now = Date.now();
        if (
          fields.expirationTime &&
          now > new Date(fields.expirationTime).getTime()
        )
          return false;
        if (fields.notBefore && now < new Date(fields.notBefore).getTime())
          return false;

        try {
          const recovered = await recoverMessageAddress({
            message,
            signature: signature as Hex,
          });
          return recovered.toLowerCase() === address.toLowerCase();
        } catch {
          return false;
        }
      },
      ensLookup: async ({ walletAddress }) => {
        try {
          const { name, avatar } = await lookupEnsProfile(
            walletAddress as Address,
          );
          return { name: name ?? "", avatar: avatar ?? "" };
        } catch {
          return { name: "", avatar: "" };
        }
      },
    }),
    nextCookies(),
  ],
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/siwe/verify") return;
      const rawAddress = (ctx.body as { walletAddress?: string })
        ?.walletAddress;
      if (!rawAddress) return;
      try {
        const address = getAddress(rawAddress);
        const wallet = await ctx.context.adapter.findOne<{ userId: string }>({
          model: "walletAddress",
          where: [{ field: "address", operator: "eq", value: address }],
        });
        if (!wallet) return;
        const user = await ctx.context.adapter.findOne<{
          id: string;
          name: string;
          image: string | null;
        }>({
          model: "user",
          where: [{ field: "id", operator: "eq", value: wallet.userId }],
        });
        if (!user) return;
        const { name, avatar } = await lookupEnsProfile(address);
        if (!name) return;
        const desiredImage = avatar ?? "";
        if (user.name === name && (user.image ?? "") === desiredImage) return;
        await ctx.context.adapter.update({
          model: "user",
          where: [{ field: "id", operator: "eq", value: user.id }],
          update: { name, image: desiredImage },
        });
        console.log(
          `[auth] refreshed ENS for ${address}: ${user.name} -> ${name}`,
        );
      } catch (err) {
        console.warn(
          "[auth] post-siwe ENS refresh failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }),
  },
});

export type Session = typeof auth.$Infer.Session;
