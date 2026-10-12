-- sync progress for restoring wallets (scanned height / target height)

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS sync_height bigint;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS sync_target bigint;
