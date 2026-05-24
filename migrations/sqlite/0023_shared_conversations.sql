-- Public-shared snapshots of conversations. A snapshot is fully frozen at
-- create time: later edits/deletes/messages on the source conversation do not
-- change what a shared link viewer sees. The owner can revoke at any time by
-- deleting the row.
CREATE TABLE shared_conversations (
    token            TEXT PRIMARY KEY,                   -- random 16-byte hex
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id  INTEGER NOT NULL,                   -- soft ref; survives source delete
    title            TEXT NOT NULL,
    creator_name     TEXT,                               -- display_name or username snapshot
    snapshot_json    TEXT NOT NULL,                      -- {system_prompt, messages: [{role, content, created_at}]}
    view_count       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at       TEXT
);
CREATE INDEX idx_shared_user_created
    ON shared_conversations(user_id, created_at DESC);
CREATE INDEX idx_shared_conv
    ON shared_conversations(conversation_id);
