ALTER TABLE attempts ADD COLUMN confirmed_workspace_path TEXT;
ALTER TABLE attempts ADD COLUMN confirmed_git_kind TEXT CHECK (confirmed_git_kind IN ('non_git','primary','linked'));
ALTER TABLE attempts ADD COLUMN confirmed_git_branch TEXT;
ALTER TABLE attempts ADD COLUMN confirmed_session_id TEXT;
ALTER TABLE attempts ADD COLUMN confirmed_session_file TEXT;
