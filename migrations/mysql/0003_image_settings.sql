ALTER TABLE user_settings ADD COLUMN image_base_url VARCHAR(512) NULL;
ALTER TABLE user_settings ADD COLUMN image_api_key VARCHAR(512) NULL;
ALTER TABLE user_settings ADD COLUMN image_model VARCHAR(128) NULL;
ALTER TABLE user_settings ADD COLUMN image_use_proxy TINYINT NULL;
