CREATE TABLE IF NOT EXISTS stellar_rate_limits (
 principal text NOT NULL, contract_id text NOT NULL, minute bigint NOT NULL, count bigint NOT NULL,
 PRIMARY KEY(principal,contract_id,minute)
);
