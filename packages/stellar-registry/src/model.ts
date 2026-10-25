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
  | "Symbol"
  | "Address"
  | "Bytes"
  | "BytesN"
  | "String"
  | "void";
export type TypeNode =
  | { kind: Leaf; size?: number }
  | { kind: "Option" | "Vec"; item: TypeNode }
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
  wasmHash: string;
  functions: FunctionModel[];
  generatedAt: string;
  excluded: { name: string; error_code: string }[];
}
