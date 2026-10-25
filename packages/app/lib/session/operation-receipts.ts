type Operation = Record<string, unknown>;
export function changedOperations(before: Operation[], after: Operation[]): Operation[] {
  const previous = new Map(before.map(o => [o.operation_id, JSON.stringify([o.result_status, o.transaction_hash, o.fee_charged])]));
  return after.filter(o => previous.get(o.operation_id) !== JSON.stringify([o.result_status, o.transaction_hash, o.fee_charged]));
}
// Only fixed, validated fields enter chat. Never copy arbitrary arguments or signing data.
export function operationReceipt(operations: Operation[]): string {
  return operations.map(o => {
    if (typeof o.operation_id !== "string" || !/^[0-9a-f-]{36}$/.test(o.operation_id)) return "";
    const state = typeof o.result_status === "string" && /^[A-Z_]+$/.test(o.result_status) ? o.result_status : "UNKNOWN";
    const hash = typeof o.transaction_hash === "string" && /^[a-f0-9]{64}$/.test(o.transaction_hash) ? `\nTransaction: ${o.transaction_hash}` : "";
    const fee = typeof o.fee_charged === "string" && /^\d+$/.test(o.fee_charged) ? `\nFee: ${o.fee_charged} stroops = ${formatStroops(o.fee_charged)} XLM` : "";
    return `\n\n**Orloj operation receipt (registry data)**\nOperation: ${o.operation_id}\nStatus: ${state}${hash}${fee}`;
  }).join("");
}
export function formatStroops(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error("Invalid stroop amount");
  const amount = BigInt(value);
  return `${amount / BigInt(10000000)}.${(amount % BigInt(10000000)).toString().padStart(7, "0")}`;
}
