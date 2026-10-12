-- creation height: the chain height when a wallet's seed first existed
-- (set for wallets created on this site; used to make same-seed imports fast)

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS creation_height bigint;
