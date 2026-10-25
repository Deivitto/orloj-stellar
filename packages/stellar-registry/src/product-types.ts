import type { FunctionModel } from "./model.js";
export type AgentIdentity = {
  agentId: string;
  instanceId: string;
  ownerId: string;
  credentialId: string;
};
export type Limits = {
  recipients: string[];
  perTransfer: string;
  rollingAmount: string;
  rollingFee: string;
};
export type Wallet = {
  id: string;
  agent_id: string;
  instance_id: string;
  owner_id: string;
  network: "testnet";
  mode: "managed" | "freighter";
  address: string;
  active: boolean;
  revision: number;
};
export type Policy = {
  agent_id: string;
  instance_id: string;
  owner_id: string;
  contract_id: string;
  function_name: string;
  mode: "READ" | "WRITE";
  revision: number;
  limits: Limits | null;
};
export type ProductOperation = {
  id: string;
  agent_id: string;
  instance_id: string;
  owner_id: string;
  credential_id: string;
  contract_id: string;
  network: "testnet";
  function_name: string;
  interface_hash: string;
  function_model: FunctionModel;
  arguments: Record<string, unknown>;
  idempotency_key: string;
  request_fingerprint: string;
  wallet_id: string;
  wallet_revision: number;
  policy_revision: number;
  state: string;
  result: Record<string, unknown> | null;
  lease_owner: string | null;
};

export const agentPrincipal = (
  a: Pick<AgentIdentity, "agentId" | "instanceId">,
) => `agent:${a.agentId}:${a.instanceId}`;

export const operationStatusName = (
  i: import("./model.js").ContractInterface,
) => {
  let name = "orloj_operation_status";
  for (
    let n = 2;
    i.inventory?.some((m) => m.signature?.mcpToolName === name);
    n++
  )
    name = `orloj_operation_status_${n}`;
  return name;
};
