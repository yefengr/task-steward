ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy' CHECK (origin IN ('task_board','foreground','legacy'));
ALTER TABLE attempts ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'background' CHECK (execution_mode IN ('foreground','background'));
ALTER TABLE attempts ADD COLUMN goal_id TEXT;
ALTER TABLE attempts ADD COLUMN owner_id TEXT;
ALTER TABLE attempts ADD COLUMN owner_pid INTEGER;
ALTER TABLE machines ADD COLUMN foreground_control INTEGER NOT NULL DEFAULT 0 CHECK (foreground_control IN (0,1));
CREATE TABLE foreground_goals (
  machine_id TEXT NOT NULL REFERENCES machines(id), goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), PRIMARY KEY (machine_id, goal_id)
) STRICT;
CREATE TABLE session_operations_new (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), machine_id TEXT NOT NULL REFERENCES machines(id),
  source_attempt_id TEXT NOT NULL REFERENCES attempts(id), replacement_id TEXT UNIQUE REFERENCES attempts(id),
  mode TEXT NOT NULL CHECK (mode IN ('restart','restore','background')), locator TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('stop','launch','cleanup','succeeded','failed')),
  deadline_at INTEGER NOT NULL, loaded_at INTEGER, failure TEXT,
  CHECK ((step = 'failed') = (failure IS NOT NULL)),
  CHECK (step NOT IN ('launch','cleanup','succeeded') OR replacement_id IS NOT NULL)
) STRICT;
INSERT INTO session_operations_new SELECT * FROM session_operations;
DROP TABLE session_operations;
ALTER TABLE session_operations_new RENAME TO session_operations;
CREATE UNIQUE INDEX session_operations_active_task ON session_operations(task_id) WHERE step IN ('stop','launch','cleanup');
CREATE INDEX session_operations_machine_step ON session_operations(machine_id, step);
CREATE INDEX session_operations_task ON session_operations(task_id);
