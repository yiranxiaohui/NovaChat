-- Studio: extra image-generation parameters threaded end-to-end so users can
-- tune negative prompts, seeds, and gpt-image-1's transparent background.
-- `n` already exists in 0018.
ALTER TABLE studio_generations ADD COLUMN negative_prompt TEXT;
ALTER TABLE studio_generations ADD COLUMN seed INTEGER;
ALTER TABLE studio_generations ADD COLUMN background TEXT;
