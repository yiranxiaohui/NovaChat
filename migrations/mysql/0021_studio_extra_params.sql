ALTER TABLE studio_generations
    ADD COLUMN negative_prompt TEXT NULL,
    ADD COLUMN seed BIGINT NULL,
    ADD COLUMN background VARCHAR(32) NULL;
