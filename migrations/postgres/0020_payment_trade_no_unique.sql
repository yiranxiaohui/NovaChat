-- Enforce trade_no uniqueness across payment_orders (see sqlite version for
-- rationale). Partial unique index — NULL trade_no is allowed to repeat.
CREATE UNIQUE INDEX idx_payment_orders_trade_no
    ON payment_orders(trade_no) WHERE trade_no IS NOT NULL;
