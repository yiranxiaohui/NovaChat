-- Enforce trade_no uniqueness across payment_orders. epay's trade_no should
-- map 1:1 to our out_trade_no; a duplicate would mean either a replay attack
-- across different orders or the gateway reusing a trade_no for a different
-- settlement. Partial index — NULL trade_no (still-pending orders) is allowed
-- to repeat.
CREATE UNIQUE INDEX idx_payment_orders_trade_no
    ON payment_orders(trade_no) WHERE trade_no IS NOT NULL;
