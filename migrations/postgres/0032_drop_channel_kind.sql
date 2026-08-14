-- Channels are protocol endpoints; a model's function lives in model_pricing.kind.
ALTER TABLE upstream_channels DROP COLUMN kind;
