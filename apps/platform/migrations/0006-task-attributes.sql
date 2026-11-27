ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low'));
ALTER TABLE tasks ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'unassessed' CHECK (difficulty IN ('unassessed', 'simple', 'medium', 'complex'));
