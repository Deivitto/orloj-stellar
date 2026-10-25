CREATE TABLE stellar_signer_epoch(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 fingerprint text NOT NULL,
 version integer NOT NULL CHECK(version>0)
);
