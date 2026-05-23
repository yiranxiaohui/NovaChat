ALTER TABLE studio_generations ADD COLUMN negative_prompt TEXT;
ALTER TABLE studio_generations ADD COLUMN seed BIGINT;
ALTER TABLE studio_generations ADD COLUMN background TEXT;
