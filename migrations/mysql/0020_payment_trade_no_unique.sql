-- Enforce trade_no uniqueness across payment_orders. MySQL UNIQUE indexes
-- allow multiple NULLs by default, so we don't need (and can't use) the
-- partial-WHERE filter the sqlite/postgres versions use.
CREATE UNIQUE INDEX idx_payment_orders_trade_no
    ON payment_orders(trade_no);
