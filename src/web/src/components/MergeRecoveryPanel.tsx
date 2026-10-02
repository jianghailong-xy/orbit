import { mergeRecoveryCommitOrigin, mergeRecoveryReady, mergeRecoveryTargetRelation, type MergeRecovery,
  type MergeRecoveryAction } from '@orbit/shared';
import type { MergeRepairSession } from '../api';

const ORIGIN_LABEL = { local: 'Local-only', merge: 'Merge commit', session: 'This session' } as const;

export function MergeRecoveryPanel({ recovery: r, branch, message, busy, supported, onAction, onRepair,
  repairSession, repairStarting, onOpenRepair }: {
  recovery: MergeRecovery;
  /** The session's branch — where the pushed work comes from. */
  branch?: string | null;
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
  const t = r.targetBranch;
  const relation = mergeRecoveryTargetRelation(r);
  const push = r.pushCommits;
  const localOnly = r.localCommits?.length ?? 0;
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
    {(branch || relation) && <p className="wt-recovery-route">
      {branch && <><code>{branch}</code> → <code>{t}</code>{relation && ' · '}</>}
      {relation && (!relation.ahead && !relation.behind ? `Local ${t} matches origin/${t}`
        : !relation.behind ? `Local ${t} is ${relation.ahead} ahead of origin/${t}`
        : !relation.ahead ? `Local ${t} is ${relation.behind} behind origin/${t}`
        : `Local ${t}: ${relation.ahead} ahead, ${relation.behind} behind origin/${t}`)}
    </p>}
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
    {(push || r.localCommits || r.remoteCommits) && <div className="wt-recovery-histories">
      {push ? <details open className="wt-recovery-push"><summary>Pushes to origin/{t} ({push.length} {push.length === 1 ? 'commit' : 'commits'})</summary>
        {push.map((c) => { const origin = mergeRecoveryCommitOrigin(r, c);
          return <div key={c.sha}><strong>{c.subject}</strong><small><span className={`wt-recovery-origin is-${origin}`}>{ORIGIN_LABEL[origin]}</span> · {c.author} · {c.date} · {c.sha.slice(0, 8)}</small></div>; })}
        <p>{r.addsMergeCommit ? `A merge commit joins both histories; nothing already on origin/${t} is rewritten.`
          : `Fast-forward push: nothing already on origin/${t} is rewritten.`}
          {localOnly ? ` Includes ${localOnly} local-only ${localOnly === 1 ? 'commit that was' : 'commits that were'} never pushed.` : ''}</p>
      </details>
      : r.localCommits && <details open><summary>Local-only commits ({r.localCommits.length}) — included in the push</summary>
        {r.localCommits.map((c) => <div key={c.sha}><strong>{c.subject}</strong><small>{c.author} · {c.date} · {c.sha.slice(0, 8)}</small></div>)}
      </details>}
      {r.remoteCommits?.length ? <details><summary>Remote-only commits ({r.remoteCommits.length})</summary>
        {r.remoteCommits.map((c) => <div key={c.sha}><strong>{c.subject}</strong><small>{c.author} · {c.date} · {c.sha.slice(0, 8)}</small></div>)}
      </details> : null}
    </div>}
    {r.conflicts?.length ? <p>Conflict stage: {r.phase === 'TARGET_SYNC' ? 'target synchronization' : 'source replay'}<br />{r.conflicts.join(', ')}</p> : null}
    {r.patch !== undefined && r.candidateSha && <details className="wt-recovery-diff"><summary>Complete candidate diff against origin/{r.targetBranch}</summary><pre>{r.patch || 'No content changes.'}</pre></details>}
    {r.check && <p>{r.check.status === 'unconfigured' ? 'Git preview only; no merge check is configured.' : r.check.status === 'passed' ? 'Configured merge check passed.' : 'Configured merge check failed.'}</p>}
    {r.check?.output && <details><summary>Check output</summary><pre>{r.check.output}</pre></details>}
    {ready && <p>{!push && <>Preserves both target histories.{r.addsMergeCommit ? ' Adds one merge commit.' : ''}{localOnly ? ' The local-only commits above will be pushed with this session’s changes.' : ''} </>}If the repository requires linear history or a PR, prepare a PR candidate instead.</p>}
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
