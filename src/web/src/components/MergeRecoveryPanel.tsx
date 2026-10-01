import { mergeRecoveryReady, type MergeRecovery, type MergeRecoveryAction } from '@orbit/shared';
import type { MergeRepairSession } from '../api';

export function MergeRecoveryPanel({ recovery: r, message, busy, supported, onAction, onRepair,
  repairSession, repairStarting, onOpenRepair }: {
  recovery: MergeRecovery;
  message?: string | null;
  busy: boolean;
  supported: boolean;
  onAction?: (action: MergeRecoveryAction, previewId?: string) => void;
  onRepair?: (preparePr: boolean) => void;
  repairSession?: MergeRepairSession | null;
  repairStarting?: boolean;
  onOpenRepair?: () => void;
}) {
  const ready = mergeRecoveryReady(r);
  const pendingLocal = r.code === 'LOCAL_SYNC_PENDING';
  const retry = ['PUSH_FAILED', 'REMOTE_NOT_VERIFIED'].includes(r.code);
  const repairRunState = (repairSession?.runState ?? repairSession?.runStatus ?? repairSession?.status ?? '').toUpperCase();
  const repairRunning = ['PENDING', 'QUEUED', 'RUNNING'].includes(repairRunState) || repairStarting;
  const repairFailed = repairRunState === 'FAILED';
  const title = pendingLocal ? `Merged into origin/${r.targetBranch}; local sync pending`
    : ready ? `Review synchronization into ${r.targetBranch}`
    : r.code === 'CONFLICT' ? (r.phase === 'TARGET_SYNC' ? `${r.targetBranch} synchronization has conflicts` : 'Your changes conflict with the synchronized target')
    : r.code === 'PREVIEW_CHANGED' ? 'Branches changed — check again'
    : r.code === 'FETCH_FAILED' ? 'Could not check the remote'
    : retry ? 'Could not confirm the target push'
    : `${r.targetBranch} needs synchronization`;
  return <section className="wt-recovery" aria-label="Target branch recovery">
    <strong>{title}</strong>
    {r.checkedAt && <p>Checked at {r.checkedAt}</p>}
    {r.code === 'TARGET_DIVERGED' && <p>Local {r.targetBranch} and origin/{r.targetBranch} each have unique commits.</p>}
    {r.code === 'TARGET_AHEAD' && <p>Local {r.targetBranch} has extra commits that are not on origin/{r.targetBranch}. Review them before continuing this merge.</p>}
    {message && !ready && <details><summary>Details</summary><pre>{message}</pre></details>}
    {repairSession && onOpenRepair && <button type="button" className={`wt-recovery-repair-status${repairRunning ? ' is-running' : repairFailed ? ' is-failed' : ' is-complete'}`}
      onClick={onOpenRepair} aria-label={repairRunning ? 'Open running repair session' : 'Open repair session'}>
      <span className="wt-recovery-repair-status-copy">
        <strong>{repairRunning ? 'Repair session running' : repairFailed ? 'Repair session failed' : 'Repair session completed'}</strong>
        <small>{repairSession.title ?? `Resolve merge recovery for ${r.targetBranch}`}</small>
      </span>
      <span aria-hidden="true" className="wt-recovery-repair-chevron">›</span>
    </button>}
    {repairSession && repairRunning && <p className="wt-recovery-repair-hint">Tap to open the running session</p>}
    {repairSession && !repairRunning && !repairFailed && <p className="wt-recovery-repair-hint">Ready to check again</p>}
    {repairSession && repairFailed && repairSession.error && <p className="wt-recovery-repair-error">{repairSession.error}</p>}
    {!r.previewId && <p>Check the local and remote commits before continuing the merge.</p>}
    {r.localCommits && <div className="wt-recovery-histories">
      <details open><summary>Local-only commits ({r.localCommits.length}) — included in the push</summary>
        {r.localCommits.map((c) => <div key={c.sha}><strong>{c.subject}</strong><small>{c.author} · {c.date} · {c.sha.slice(0, 8)}</small></div>)}
      </details>
      <details><summary>Remote-only commits ({r.remoteCommits?.length ?? 0})</summary>
        {r.remoteCommits?.map((c) => <div key={c.sha}><strong>{c.subject}</strong><small>{c.author} · {c.date} · {c.sha.slice(0, 8)}</small></div>)}
      </details>
    </div>}
    {r.conflicts?.length ? <p>Conflict stage: {r.phase === 'TARGET_SYNC' ? 'target synchronization' : 'source replay'}<br />{r.conflicts.join(', ')}</p> : null}
    {r.patch !== undefined && r.candidateSha && <details className="wt-recovery-diff"><summary>Complete candidate diff against origin/{r.targetBranch}</summary><pre>{r.patch || 'No content changes.'}</pre></details>}
    {r.check && <p>{r.check.status === 'unconfigured' ? 'Git preview only; no merge check is configured.' : r.check.status === 'passed' ? 'Configured merge check passed.' : 'Configured merge check failed.'}</p>}
    {r.check?.output && <details><summary>Check output</summary><pre>{r.check.output}</pre></details>}
    {ready && <p>Preserves both target histories.{r.addsMergeCommit ? ' Adds one merge commit.' : ''} The local-only commits above will be pushed with this session’s changes. If the repository requires linear history or a PR, prepare a PR candidate instead.</p>}
    {pendingLocal && <p>The remote contains the reviewed candidate. Save the blocking local edits before syncing; this action only updates this machine.</p>}
    {r.repairBranch && <details><summary>Saved repair branch and location</summary><code>{r.repairBranch}</code><br /><code>{r.repairWorktree}</code></details>}
    <div className="wt-recovery-actions">
      {supported && onAction && (pendingLocal
        ? <button type="button" disabled={busy} onClick={() => onAction('sync-local', r.previewId)}>Sync local checkout</button>
        : <>
          <button type="button" disabled={busy} onClick={() => onAction('preview')}>{busy ? 'Checking…' : r.previewId ? 'Check again' : 'Check and repair'}</button>
          {ready && <button type="button" className="wt-merge-btn" disabled={busy} onClick={() => onAction('apply', r.previewId)}>Sync {r.targetBranch} and merge</button>}
          {retry && <button type="button" disabled={busy} onClick={() => onAction('apply', r.previewId)}>Check result / retry reviewed candidate</button>}
        </>)}
      {r.repairWorktree && onRepair && !pendingLocal && <>
        {r.code !== 'READY' && <button type="button" disabled={busy || repairRunning} onClick={() => onRepair(false)}>{repairStarting ? 'Opening repair session…' : 'Resolve in repair session'}</button>}
        <button type="button" disabled={busy || repairRunning} onClick={() => onRepair(true)}>Prepare PR candidate</button>
      </>}
    </div>
    {!supported && <p>Update the runner to use target synchronization recovery.</p>}
  </section>;
}
