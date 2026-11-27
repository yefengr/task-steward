ALTER TABLE attempts ADD COLUMN work_revision INTEGER NOT NULL DEFAULT 0 CHECK (work_revision >= 0);
ALTER TABLE attempts ADD COLUMN settled_at INTEGER;
ALTER TABLE attempts ADD COLUMN continuation_pending INTEGER NOT NULL DEFAULT 0 CHECK (continuation_pending IN (0,1));
ALTER TABLE attempts ADD COLUMN work_mode TEXT CHECK (work_mode IN ('foreground','background'));
ALTER TABLE tasks ADD COLUMN accepted_at INTEGER;
ALTER TABLE tasks ADD COLUMN lifecycle_phase TEXT;
ALTER TABLE tasks ADD COLUMN lifecycle_message TEXT;

CREATE TABLE deliveries_new (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id),
  version INTEGER NOT NULL, summary TEXT NOT NULL, done TEXT NOT NULL, not_covered TEXT NOT NULL,
  verification TEXT NOT NULL, how_to TEXT NOT NULL, issues TEXT NOT NULL, base_commit TEXT, "commit" TEXT, report_ref TEXT,
  review TEXT CHECK (review IN ('accepted','rework')), feedback TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL,
  work_revision INTEGER NOT NULL DEFAULT 0 CHECK (work_revision >= 0),
  kind TEXT NOT NULL DEFAULT 'implementation' CHECK (kind IN ('implementation','record')),
  source_delivery_id TEXT REFERENCES deliveries_new(id), revision_reason TEXT,
  UNIQUE(task_id, version)
) STRICT;
INSERT INTO deliveries_new (id,task_id,attempt_id,version,summary,done,not_covered,verification,how_to,issues,base_commit,"commit",report_ref,review,feedback,reviewed_at,created_at)
  SELECT * FROM deliveries;
DROP TABLE deliveries;
ALTER TABLE deliveries_new RENAME TO deliveries;
CREATE UNIQUE INDEX one_implementation_per_work ON deliveries(attempt_id,work_revision) WHERE kind='implementation';

CREATE TABLE session_operations_new (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), machine_id TEXT NOT NULL REFERENCES machines(id),
  source_attempt_id TEXT NOT NULL REFERENCES attempts(id), replacement_id TEXT UNIQUE REFERENCES attempts(id),
  mode TEXT NOT NULL CHECK (mode IN ('restart','restore','background','pause','continue','finalize')), locator TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('stop','launch','cleanup','succeeded','failed')),
  deadline_at INTEGER NOT NULL, loaded_at INTEGER, failure TEXT,
  CHECK ((step = 'failed') = (failure IS NOT NULL)),
  CHECK (step NOT IN ('launch','cleanup','succeeded') OR replacement_id IS NOT NULL OR mode IN ('pause','finalize'))
) STRICT;
INSERT INTO session_operations_new SELECT * FROM session_operations;
DROP TABLE session_operations;
ALTER TABLE session_operations_new RENAME TO session_operations;
CREATE UNIQUE INDEX session_operations_active_task ON session_operations(task_id) WHERE step IN ('stop','launch','cleanup');
CREATE INDEX session_operations_machine_step ON session_operations(machine_id,step);
CREATE INDEX session_operations_task ON session_operations(task_id);
-- 历史验收只保留已确认结果，不将未合并 Git 的 review 提前标成验收。
UPDATE tasks SET accepted_at=updated_at,lifecycle_phase='complete' WHERE status='done';
UPDATE attempts SET settled_at=ended_at WHERE ended_at IS NOT NULL AND result='delivered';
