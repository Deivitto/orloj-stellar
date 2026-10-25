ALTER TABLE stellar_interfaces DROP CONSTRAINT stellar_interface_source;
ALTER TABLE stellar_interfaces ADD CONSTRAINT stellar_interface_source CHECK (
  (source_kind='wasm' AND wasm_hash IS NOT NULL) OR
  (source_kind='stellar_asset' AND wasm_hash IS NULL) OR
  (source_kind='classic_dex' AND wasm_hash IS NULL AND contract_id='classic:stellar-dex') OR
  (source_kind='classic_amm' AND wasm_hash IS NULL AND contract_id='classic:stellar-amm')
);
