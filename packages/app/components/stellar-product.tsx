"use client";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./auth-context";
import { useLocale } from "./i18n-context";
import { AgentAppSignIn } from "./agent-app";
import { freighter, testnetPassphrase } from "@/lib/freighter";
type Wallet = { id: string; address: string; mode: string; active: boolean };
type Signature = {
  sorobanName: string;
  description: string;
  params: { name: string; sorobanType: string }[];
};
type Method = {
  name: string;
  eligible: boolean;
  allowedMode?: "READ" | "WRITE";
  error_code?: string;
  restriction?: string;
  exclusion?: { location: string; type: string };
  signature?: Signature;
};
type Contract = {
  name: string;
  address: string;
  contractName: string;
  sourceKind?: string;
  inventory: Method[];
  excluded: unknown[];
};
type Policy = {
  contract_id: string;
  function_name: string;
  mode: "READ" | "WRITE";
  limits: unknown;
};
type Op = {
  signing_ready?: boolean;
  can_cancel?: boolean;
  operation_id: string;
  result_status: string;
  function_name: string;
  contract_id: string;
  arguments: unknown;
  wallet_id: string;
  max_fee: string;
  transaction_hash?: string;
  human_message?: string;
};
type State = {
  wallets: Wallet[];
  policies: Policy[];
  contracts: Contract[];
  operations: Op[];
};
const empty: State = {
  wallets: [],
  policies: [],
  contracts: [],
  operations: [],
};
const card: React.CSSProperties = {
  border: "1px solid var(--line)",
  padding: 20,
  borderRadius: 10,
  marginBottom: 18,
  background: "var(--parchment)",
};
const input: React.CSSProperties = {
  border: "1px solid var(--line)",
  padding: 10,
  borderRadius: 6,
  background: "var(--parchment)",
  color: "var(--ink)",
  maxWidth: "100%",
  margin: "6px 8px 6px 0",
};
const button: React.CSSProperties = {
  ...input,
  cursor: "pointer",
  background: "var(--ink)",
  color: "var(--parchment)",
};
export function StellarProduct({ agentId: fixedId }: { agentId?: string }) {
  const { user, loading } = useAuth(),
    lang = useLocale();
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]),
    [agentId, setAgentId] = useState(fixedId ?? ""),
    [state, setState] = useState<State>(empty),
    [error, setError] = useState(""),
    [registryUnavailable, setRegistryUnavailable] = useState(false),
    [busy, setBusy] = useState(false),
    [name, setName] = useState("My Stellar agent"),
    [contractId, setContractId] = useState("");
  const api = useCallback(
    async (path: string, body?: unknown, method = "POST") => {
      if (!agentId) throw new Error("Create or select an agent first");
      const r = await fetch(`/api/agents/${agentId}/stellar/${path}`, {
        method: body === undefined ? "GET" : method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(data.error ?? data.human_message ?? "Request failed");
      return data;
    },
    [agentId],
  );
  const refresh = useCallback(async () => {
    if (agentId) setState(await api("state"));
  }, [agentId, api]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!user || fixedId) return;
    let active = true;
    void fetch("/api/agents")
      .then(async (r) => {
        if (!r.ok) throw new Error("Agent service unavailable");
        return r.json();
      })
      .then((data) => {
        if (active) {
          setAgents(data.agents);
          setAgentId((id) => id || data.agents[0]?.id || "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [user, fixedId]);
  useEffect(() => {
    if (!user || !agentId) return;
    let active = true;
    const poll = async () => {
      try {
        const data = await api("state");
        if (active) {
          setState(data);
          setRegistryUnavailable(false);
        }
      } catch {
        if (active) setRegistryUnavailable(true);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, agentId, user]);
  if (loading) return <main style={{ padding: 32 }}>Loading…</main>;
  if (!user) return <AgentAppSignIn />;
  const wallet = state.wallets.find((w) => w.active);
  async function link() {
    const sdk = await freighter();
    const access = await sdk.requestAccess(),
      network = await sdk.getNetwork();
    if (
      access.error ||
      !access.address ||
      network.networkPassphrase !== testnetPassphrase
    )
      throw new Error("Select your wallet on Stellar Testnet");
    const challenge = await api("wallet/challenge", {
      address: access.address,
    });
    const result = await sdk.signMessage(challenge.message, {
      address: access.address,
      networkPassphrase: testnetPassphrase,
    });
    if (result.error || !result.signedMessage)
      throw new Error("Wallet ownership signature rejected");
    const signature =
      typeof result.signedMessage === "string"
        ? result.signedMessage
        : btoa(String.fromCharCode(...result.signedMessage));
    await api("wallet/link", { id: challenge.id, signature });
  }
  async function sign(id: string) {
    const { request } = await api(`operations/${id}/signing`);
    if (!request)
      throw new Error(
        "Preparing the transaction. Try Sign again when it is ready.",
      );
    const sdk = await freighter(),
      network = await sdk.getNetwork();
    if (network.networkPassphrase !== testnetPassphrase)
      throw new Error("Switch Freighter to Testnet");
    const result =
      request.kind === "transaction"
        ? await sdk.signTransaction(request.payload, {
            address: request.address,
            networkPassphrase: testnetPassphrase,
          })
        : await sdk.signAuthEntry(request.payload, {
            address: request.address,
          });
    await api(`operations/${id}/signed`, { id: request.id, result });
  }
  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: fixedId ? "16px 24px" : "40px 24px",
      }}
    >
      <h1>Orloj Stellar</h1>
      <p>
        Testnet · Connect a wallet, choose contract tools, and call them through
        MCP. AI chat is optional.
      </p>
      {registryUnavailable && (
        <p role="alert" style={{ color: "var(--wine)", ...card }}>
          Stellar registry unavailable. Check local service readiness.
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--wine)", ...card }}>
          {error}
        </p>
      )}
      {!fixedId && (
        <section style={card}>
          <h2>Your agents</h2>
          <select
            aria-label="Agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={input}
          >
            <option value="">Select an agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            aria-label="New agent name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={input}
          />
          <button
            disabled={busy}
            style={button}
            onClick={() =>
              void action(async () => {
                const r = await fetch("/api/agents", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name }),
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error ?? "Agent creation failed");
                setAgents((old) => [...old, d.agent]);
                setAgentId(d.agent.id);
              })
            }
          >
            Create agent
          </button>
          {agentId && (
            <button
              disabled={busy}
              style={button}
              onClick={() =>
                void action(async () => {
                  const r = await fetch(
                    `/api/stellar/connection?agentId=${encodeURIComponent(agentId)}`,
                  );
                  if (!r.ok) throw new Error("MCP configuration unavailable");
                  await navigator.clipboard.writeText(
                    JSON.stringify(await r.json(), null, 2),
                  );
                })
              }
            >
              Copy MCP configuration
            </button>
          )}
          {agentId && (
            <a href={`/${lang}/session/${agentId}`} style={{ marginLeft: 12 }}>
              Open agent chat →
            </a>
          )}
        </section>
      )}
      {agentId && (
        <>
          <section style={card}>
            <h2>Wallet</h2>
            <p>
              {wallet
                ? `${wallet.mode === "managed" ? "Managed agent wallet" : "Freighter"} · ${wallet.address}`
                : "No wallet connected. Reads can use the configured simulation account."}
            </p>
            <button
              disabled={busy}
              style={button}
              onClick={() => void action(link)}
            >
              Connect Freighter
            </button>
            <button
              disabled={busy}
              style={button}
              onClick={() =>
                void action(async () => {
                  await api("wallet/managed", {});
                })
              }
            >
              Create/use managed testnet wallet
            </button>
            {state.wallets.map((w) => (
              <div
                key={w.id}
                style={{ overflowWrap: "anywhere", marginTop: 8 }}
              >
                {w.mode}: {w.address}{" "}
                {w.active ? (
                  "(active)"
                ) : (
                  <button
                    style={input}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api("wallet/activate", { id: w.id });
                      })
                    }
                  >
                    Use wallet
                  </button>
                )}{" "}
                <button
                  style={input}
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api("wallet/fund", { id: w.id });
                    })
                  }
                >
                  Get free testnet XLM
                </button>
              </div>
            ))}
            <p>
              Changing wallets disables unattended grants until you save their
              limits again. Every Freighter write needs your signature.
            </p>
          </section>
          {!fixedId && (
            <section style={card}>
              <h2>Register a contract, asset or classic market</h2>
              <input
                aria-label="Stellar contract address"
                placeholder="C… contract address"
                value={contractId}
                onChange={(e) => setContractId(e.target.value)}
                style={{ ...input, width: 520 }}
              />
              <button
                disabled={busy}
                style={button}
                onClick={() =>
                  void action(async () => {
                    await api("register", { contractId });
                  })
                }
              >
                Register contract
              </button>
              <button
                disabled={busy}
                style={button}
                onClick={() =>
                  void action(async () => {
                    await api("register", { asset: { kind: "native" } });
                  })
                }
              >
                Register XLM
              </button>
              {(
                [
                  ["classic:stellar-dex", "Register Stellar DEX"],
                  ["classic:stellar-amm", "Register Stellar AMM"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  disabled={busy}
                  style={button}
                  onClick={() =>
                    void action(async () => {
                      await api("register", { contractId: id });
                    })
                  }
                >
                  {label}
                </button>
              ))}

              <button
                disabled={busy}
                style={button}
                onClick={() =>
                  void action(async () => {
                    await api("register", {
                      asset: {
                        kind: "issued",
                        code: "USDC",
                        issuer:
                          "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                      },
                    });
                  })
                }
              >
                Register Circle testnet USDC
              </button>
              <p>
                Registration inspects the interface. Enable methods explicitly
                below.
              </p>
            </section>
          )}
          {!fixedId &&
            state.contracts.map((c) => (
              <ContractPolicy
                key={`${agentId}:${c.name}`}
                contract={c}
                policies={state.policies}
                busy={busy}
                save={(functions) =>
                  action(async () => {
                    await api(
                      "policies",
                      { contractId: c.address, functions },
                      "PUT",
                    );
                  })
                }
              />
            ))}
          <section style={card}>
            <h2>Write operations</h2>
            {!state.operations.length && (
              <p>
                No writes requested yet. Ask your agent to call an enabled
                method.
              </p>
            )}
            {state.operations.map((o) => (
              <div
                key={o.operation_id}
                style={{
                  borderTop: "1px solid var(--line)",
                  padding: "14px 0",
                  overflowWrap: "anywhere",
                }}
              >
                <strong>
                  {o.function_name} · {o.result_status}
                </strong>
                <p>{o.contract_id}</p>
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(o.arguments, null, 2)}
                </pre>
                <p>Maximum fee: {o.max_fee} stroops · Testnet</p>
                {o.human_message && <p>{o.human_message}</p>}
                {o.transaction_hash && <p>Transaction: {o.transaction_hash}</p>}
                {o.result_status === "AWAITING_APPROVAL" && (
                  <button
                    style={button}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api(`operations/${o.operation_id}/approve`, {});
                      })
                    }
                  >
                    Review and prepare
                  </button>
                )}
                {o.signing_ready &&
                  o.result_status === "PREPARING" &&
                  state.wallets.find((w) => w.id === o.wallet_id)?.mode ===
                    "freighter" && (
                    <button
                      style={button}
                      disabled={busy}
                      onClick={() => void action(() => sign(o.operation_id))}
                    >
                      Sign in Freighter
                    </button>
                  )}
                {o.can_cancel && (
                  <button
                    style={input}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api(`operations/${o.operation_id}/cancel`, {});
                      })
                    }
                  >
                    Cancel before submission
                  </button>
                )}
                {o.result_status === "TIMEOUT" && (
                  <button
                    style={input}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api(`operations/${o.operation_id}/reconcile`, {});
                      })
                    }
                  >
                    Check chain status
                  </button>
                )}
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
function ContractPolicy({
  contract,
  policies,
  busy,
  save,
}: {
  contract: Contract;
  policies: Policy[];
  busy: boolean;
  save: (f: unknown[]) => Promise<void>;
}) {
  const [modes, setModes] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      policies
        .filter((p) => p.contract_id === contract.address)
        .map((p) => [p.function_name, p.mode]),
    ),
  );
  const [recipients, setRecipients] = useState(""),
    [perTransfer, setPerTransfer] = useState(""),
    [rollingAmount, setRollingAmount] = useState(""),
    [rollingFee, setRollingFee] = useState("");
  return (
    <section style={card}>
      <h2>{contract.contractName}</h2>
      <p style={{ overflowWrap: "anywhere" }}>{contract.address}</p>
      {contract.inventory.map((m) => (
        <div key={m.name} style={{ marginBottom: 10 }}>
          <strong>{m.name}</strong>{" "}
          {m.signature?.params
            .map((p) => `${p.name}: ${p.sorobanType}`)
            .join(", ")}{" "}
          {m.eligible ? (
            <select
              aria-label={`${m.name} permission`}
              style={input}
              value={modes[m.name] ?? ""}
              onChange={(e) =>
                setModes((old) => ({ ...old, [m.name]: e.target.value }))
              }
            >
              <option value="">Disabled</option>
              <option value="READ" disabled={m.allowedMode === "WRITE"}>
                {contract.sourceKind?.startsWith("classic_")
                  ? "Read only"
                  : "Simulate only"}
              </option>
              <option value="WRITE" disabled={m.allowedMode === "READ"}>
                Allow write
              </option>
            </select>
          ) : (
            <span>
              Excluded: {m.restriction ?? m.error_code}
              {m.exclusion
                ? ` · ${m.exclusion.location}: ${m.exclusion.type}`
                : ""}
            </span>
          )}
        </div>
      ))}
      <details>
        <summary>Unattended transfer limits (exact base units)</summary>
        <p>
          Managed wallets require all four fields. Other writes require
          Freighter. 1 XLM or USDC = 10000000 base units.
        </p>
        <input
          style={input}
          aria-label="Allowed recipients"
          placeholder="Recipients, comma separated"
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
        />
        <input
          style={input}
          aria-label="Per-transfer limit"
          placeholder="Maximum amount per transfer"
          value={perTransfer}
          onChange={(e) => setPerTransfer(e.target.value)}
        />
        <input
          style={input}
          aria-label="24-hour amount limit"
          placeholder="Rolling 24h amount"
          value={rollingAmount}
          onChange={(e) => setRollingAmount(e.target.value)}
        />
        <input
          style={input}
          aria-label="24-hour fee limit"
          placeholder="Rolling 24h fee (stroops)"
          value={rollingFee}
          onChange={(e) => setRollingFee(e.target.value)}
        />
      </details>
      <button
        style={button}
        disabled={busy}
        onClick={() =>
          void save(
            Object.entries(modes)
              .filter(([, mode]) => mode)
              .map(([name, mode]) => ({
                name,
                mode,
                ...(name === "transfer" &&
                mode === "WRITE" &&
                recipients &&
                perTransfer &&
                rollingAmount &&
                rollingFee
                  ? {
                      limits: {
                        recipients: recipients
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                        perTransfer,
                        rollingAmount,
                        rollingFee,
                      },
                    }
                  : {}),
              })),
          )
        }
      >
        Save tool permissions
      </button>
    </section>
  );
}
