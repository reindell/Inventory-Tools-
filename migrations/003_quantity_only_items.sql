-- Pricing is no longer part of item entry or reports. Retain historical values
-- and immutable ledger snapshots; do not drop or rewrite existing amounts.
ALTER TABLE items ALTER COLUMN unit_price SET DEFAULT 0;
ALTER TABLE items ALTER COLUMN unit_cost SET DEFAULT 0;
