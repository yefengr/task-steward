CREATE TABLE machines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
  revoked_at INTEGER, slots INTEGER NOT NULL DEFAULT 0 CHECK (slots BETWEEN 0 AND 1000),
  last_seen_at INTEGER, launcher_version TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, last_machine_id TEXT REFERENCES machines(id), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE machine_projects (
  machine_id TEXT REFERENCES machines(id), project_id TEXT REFERENCES projects(id),
  local_path TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (machine_id, project_id)
) STRICT;
CREATE INDEX project_machines ON machine_projects(project_id, machine_id);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
  goal TEXT NOT NULL, acceptance TEXT NOT NULL, notes TEXT NOT NULL, agent TEXT NOT NULL CHECK (agent IN ('pi','claude')),
  machine_id TEXT REFERENCES machines(id), status TEXT NOT NULL CHECK (status IN
    ('unscheduled','queued','running','review','done','interrupted','cancelled')),
  rework_pending INTEGER NOT NULL DEFAULT 0 CHECK (rework_pending IN (0,1)), position INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('user','agent')), version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, position)
) STRICT;
CREATE INDEX tasks_queue ON tasks(status, rework_pending DESC, position, created_at, id);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), machine_id TEXT NOT NULL REFERENCES machines(id),
  agent TEXT NOT NULL CHECK (agent IN ('pi','claude')), kind TEXT NOT NULL CHECK (kind IN ('new','rework')),
  session_id TEXT NOT NULL, workspace_path TEXT NOT NULL, tmux_session TEXT, claimed_at INTEGER NOT NULL, started_at INTEGER,
  lease_expires_at INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  ended_at INTEGER, exit_code INTEGER, result TEXT CHECK (result IN ('delivered','interrupted','cancelled'))
) STRICT;
CREATE UNIQUE INDEX one_active_attempt ON attempts(task_id) WHERE ended_at IS NULL;
CREATE INDEX machine_active_attempts ON attempts(machine_id) WHERE ended_at IS NULL;
CREATE INDEX task_attempts ON attempts(task_id, claimed_at);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  version INTEGER NOT NULL, summary TEXT NOT NULL, done TEXT NOT NULL, not_covered TEXT NOT NULL,
  verification TEXT NOT NULL, how_to TEXT NOT NULL, issues TEXT NOT NULL, base_commit TEXT, "commit" TEXT, report_ref TEXT,
  review TEXT CHECK (review IN ('accepted','rework')), feedback TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(task_id, version)
) STRICT;
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT REFERENCES attempts(id),
  text TEXT NOT NULL, confirmed_by_user INTEGER NOT NULL CHECK (confirmed_by_user IN (0,1)), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE progress (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id),
  text TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE questions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL REFERENCES attempts(id),
  text TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','resolved','withdrawn')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE task_events (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), actor TEXT NOT NULL CHECK (actor IN ('user','launcher','agent')),
  attempt_id TEXT REFERENCES attempts(id), kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX task_decisions ON decisions(task_id);
CREATE INDEX task_progress ON progress(task_id);
CREATE INDEX task_questions ON questions(task_id, status);
CREATE INDEX task_events_order ON task_events(task_id, created_at);
CREATE TABLE web_sessions (id_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX web_session_expiry ON web_sessions(expires_at);
CREATE TABLE request_log (
  machine_id TEXT NOT NULL REFERENCES machines(id), request_id TEXT NOT NULL, actor TEXT NOT NULL,
  operation TEXT NOT NULL, target TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (machine_id, request_id)
) STRICT;
CREATE INDEX request_expiry ON request_log(created_at);
