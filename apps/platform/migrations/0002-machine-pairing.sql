CREATE TABLE machine_pairings (
  code TEXT NOT NULL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX machine_pairing_expiry ON machine_pairings(expires_at);
