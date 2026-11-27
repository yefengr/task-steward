ALTER TABLE projects ADD COLUMN git_base_branch TEXT;
ALTER TABLE projects ADD COLUMN git_sync_before_start INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN git_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN base_branch TEXT;
ALTER TABLE tasks ADD COLUMN git_sync_before_start INTEGER;
ALTER TABLE attempts ADD COLUMN confirmed_git_root TEXT;
CREATE TABLE task_git (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  snapshot TEXT NOT NULL
);
CREATE TABLE git_operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  authorization TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('merge','cleanup','stopped','complete'))
);
