export type Network = "testnet" | "mainnet";
export type Schema = Record<string, unknown>;
export type Leaf =
  | "bool"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "u256"
  | "i256"
  | "Symbol"
  | "Address"
  | "MuxedAddress"
  | "Bytes"
  | "BytesN"
  | "String"
  | "void";
export type TypeNode =
  | { kind: Leaf; size?: number; protocol?: number }
  | { kind: "Option" | "Vec"; item: TypeNode }
  | {
      kind: "Result";
      ok: TypeNode;
      genericError?: boolean;
      errors: { name: string; value: number }[];
    }
  | { kind: "Map"; key: TypeNode; value: TypeNode }
  | { kind: "Tuple"; items: TypeNode[] }
  | { kind: "Enum"; cases: { name: string; value: number }[] }
  | { kind: "Union"; cases: { name: string; items: TypeNode[] }[] }
  | {
      kind: "Struct";
      fields: { name: string; type: TypeNode; description: string }[];
    };
export interface FieldModel {
  name: string;
  type: TypeModel;
  description: string;
}
export interface TypeModel {
  sorobanType: string;
  jsonSchema: Schema;
  converterId: string;
  isCollection: boolean;
  itemType?: TypeModel;
  structFields?: FieldModel[];
  node: TypeNode;
}
export interface ParamModel {
  name: string;
  sorobanType: string;
  jsonSchema: Schema;
  required: boolean;
  description: string;
  converterId: string;
  type: TypeModel;
}
export interface FunctionModel {
  sorobanName: string;
  mcpToolName: string;
  description: string;
  mode: "READ" | "WRITE";
  params: ParamModel[];
  returns: TypeModel;
  simulationSafe: boolean;
  writeAllowed: boolean;
}
export interface ContractInterface {
  network: Network;
  contractId: string;
  wasmHash?: string;
  sourceKind?: "wasm" | "stellar_asset" | "classic_dex" | "classic_amm";
  interfaceHash?: string;
  encodingVersion?: number;
  protocolVersion?: number;
  inventory?: {
    name: string;
    eligible: boolean;
    policyStatus: "enabled" | "disabled";
    allowedMode?: "READ" | "WRITE";
    signature?: Omit<FunctionModel, "mode" | "simulationSafe" | "writeAllowed">;
    error_code?: string;
    restriction?: string;
    declaredSignature?: unknown;
    exclusion?: { location: string; type: string };
  }[];
  asset?: { kind: "native" } | { kind: "issued"; code: string; issuer: string };
  functions: FunctionModel[];
  generatedAt: string;
  excluded: { name: string; error_code: string }[];
}
