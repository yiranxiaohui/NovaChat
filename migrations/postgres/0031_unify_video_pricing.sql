-- Merge video_pricing into model_pricing: one whitelist table for all kinds.
-- video rows carry base_credits/per_second/allowed_seconds/size_rules;
-- chat/image rows keep using cost_credits and leave the new columns NULL.

ALTER TABLE model_pricing ADD COLUMN base_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE model_pricing ADD COLUMN per_second BIGINT NOT NULL DEFAULT 0;
ALTER TABLE model_pricing ADD COLUMN allowed_seconds TEXT NULL;
ALTER TABLE model_pricing ADD COLUMN size_rules TEXT NULL;

-- video_pricing rows win over any placeholder video rows created in model_pricing.
DELETE FROM model_pricing WHERE model IN (SELECT model FROM video_pricing);

INSERT INTO model_pricing
    (model, kind, cost_credits, display_name, enabled, protocol, context_limit,
     base_credits, per_second, allowed_seconds, size_rules, created_at, updated_at)
SELECT model, 'video', 0, display_name, enabled, 'openai', NULL,
       base_credits, per_second, allowed_seconds, size_rules, created_at, updated_at
FROM video_pricing;

DROP TABLE video_pricing;
