import type { Task } from '@pi-steward/contract';
import { isIntegrationPhase } from '../lib/git';
import { useI18n } from '../lib/i18n';

export function GitSection({ task }: { task: Task }) {
  const { t } = useI18n();
  const git = task.git;
  if (!git) return null;
  const blocked = git.phase === 'merge_blocked' || git.phase === 'cleanup_blocked' || git.phase === 'needs_rework';
  const accepted = task.lifecycle?.acceptedAt != null && isIntegrationPhase(git.phase) && git.phase !== 'complete';
  const commit = (value: string | null) => value
    ? <code>{value}</code> : <span className="muted">{t.common.unknown}</span>;
  return <section className="detail-section git-section">
    <h2 tabIndex={-1}>{t.git.section}</h2>
    {git.message && <p role={blocked ? 'alert' : undefined} className={`callout${blocked ? ' warning' : ' neutral'}`}>
      {git.message === 'git_target_checked_out' ? t.git.targetCheckedOut :
        git.message === 'git_foreground_session_active' ? t.git.foregroundActive : git.message}</p>}
    {accepted && <p className="callout neutral">{t.lifecycle.gitAcceptedHint}</p>}
    <dl className="kv">
      <dt>{t.git.phase}</dt><dd>{t.git.phases[git.phase]}</dd>
      <dt>{t.git.baseBranch}</dt><dd><code>{git.baseBranch}</code></dd>
      <dt>{t.git.baseCommit}</dt><dd>{commit(git.baseCommit)}</dd>
      <dt>{t.git.taskBranch}</dt><dd><code>{git.taskBranch}</code></dd>
      <dt>{t.git.approvedCommit}</dt><dd>{commit(git.approvedCommit)}</dd>
      <dt>{t.git.mergedCommit}</dt><dd>{commit(git.mergedCommit)}</dd>
      <dt>{t.git.syncBeforeStart}</dt><dd>{git.syncBeforeStart ? t.git.syncResults[git.syncResult] : t.git.syncResults.disabled}</dd>
      <dt>{t.git.repository}</dt><dd><code>{git.repositoryPath}</code></dd>
      {git.worktreePath && <><dt>{t.git.worktree}</dt><dd><code>{git.worktreePath}</code></dd></>}
    </dl>
  </section>;
}
