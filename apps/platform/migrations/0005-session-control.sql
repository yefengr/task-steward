ALTER TABLE machines ADD COLUMN session_control INTEGER NOT NULL DEFAULT 0 CHECK (session_control IN (0,1));
ALTER TABLE attempts ADD COLUMN session_locator TEXT;
ALTER TABLE attempts ADD COLUMN resumed_from_attempt_id TEXT REFERENCES attempts(id);

CREATE TABLE session_operations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), machine_id TEXT NOT NULL REFERENCES machines(id),
  source_attempt_id TEXT NOT NULL REFERENCES attempts(id), replacement_id TEXT UNIQUE REFERENCES attempts(id),
  mode TEXT NOT NULL CHECK (mode IN ('restart','restore')), locator TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('stop','launch','cleanup','succeeded','failed')),
  deadline_at INTEGER NOT NULL, loaded_at INTEGER, failure TEXT,
  CHECK ((step = 'failed') = (failure IS NOT NULL)),
  CHECK (step NOT IN ('launch','cleanup','succeeded') OR replacement_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX session_operations_active_task ON session_operations(task_id) WHERE step IN ('stop','launch','cleanup');
CREATE INDEX session_operations_machine_step ON session_operations(machine_id, step);
CREATE INDEX session_operations_task ON session_operations(task_id);
