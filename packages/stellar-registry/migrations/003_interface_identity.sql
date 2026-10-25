ALTER TABLE stellar_interfaces ADD COLUMN source_kind text NOT NULL DEFAULT 'wasm';
ALTER TABLE stellar_interfaces ADD COLUMN interface_hash text;
UPDATE stellar_interfaces SET interface_hash=wasm_hash,
  interface=interface || jsonb_build_object('sourceKind','wasm','interfaceHash',wasm_hash);
ALTER TABLE stellar_interfaces ALTER COLUMN interface_hash SET NOT NULL;
ALTER TABLE stellar_interfaces DROP CONSTRAINT stellar_interfaces_pkey;
ALTER TABLE stellar_interfaces ALTER COLUMN wasm_hash DROP NOT NULL;
ALTER TABLE stellar_interfaces ADD PRIMARY KEY(network,contract_id,interface_hash);
ALTER TABLE stellar_interfaces ADD CONSTRAINT stellar_interface_source CHECK (
  (source_kind='wasm' AND wasm_hash IS NOT NULL) OR
  (source_kind='stellar_asset' AND wasm_hash IS NULL)
);
