ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'implementation' CHECK (type IN ('discussion','implementation'));
ALTER TABLE attempts ADD COLUMN discussion_end_requested_at INTEGER;
ALTER TABLE questions ADD COLUMN wait_id TEXT;
ALTER TABLE questions ADD COLUMN wait_since INTEGER;
