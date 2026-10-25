import { it, expect } from "vitest";
import { Product } from "../src/product.js";
import type { ProductOperation } from "../src/product-types.js";
it("formats historical confirmed operation fees exactly without altering stored metadata", () => {
  const product = Object.create(Product.prototype) as Product;
  const result = { ok: true, result_status: "SUBMITTED_AND_CONFIRMED", fee_charged: "7228", transaction_hash: "a".repeat(64) };
  const operation = { id: "op", state: "SUCCESS", result } as unknown as ProductOperation;
  expect(product.publicOperation(operation)).toMatchObject({ fee_charged: "7228", fee_charged_xlm: "0.0007228", transaction_hash: "a".repeat(64) });
  expect(result).not.toHaveProperty("fee_charged_xlm");
  expect(product.publicOperation({ ...operation, result: { fee_charged: "1e3" } })).not.toHaveProperty("fee_charged_xlm");
});
