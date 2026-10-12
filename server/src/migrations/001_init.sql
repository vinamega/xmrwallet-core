-- xmrwallet dev schema (Phase 2). No secrets in plaintext:
-- seeds and wallet passwords are AES-256-GCM blobs (see server/src/wallets/seedstore.ts).

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  password_hash text,
  is_anon boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text,
  address text NOT NULL,
  encrypted_seed bytea NOT NULL,
  wrapped_data_key bytea NOT NULL,
  encrypted_wallet_pass bytea NOT NULL,
  restore_height bigint NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempts int NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_state_check CHECK (state IN ('queued','restoring','ready','watching','error'))
);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_queue ON wallets(state, created_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS idx_wallets_watch ON wallets(state) WHERE state IN ('ready','watching');
