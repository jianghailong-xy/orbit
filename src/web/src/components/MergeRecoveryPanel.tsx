import type { ReactNode } from 'react';
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MessageFilled, WarningFilled } from '@ant-design/icons';
import { mergeRecoveryCommitOrigin, mergeRecoveryConfirmable, mergeRecoveryReady, mergeRecoveryTargetRelation,
  type MergeRecovery, type MergeRecoveryAction } from '@orbit/shared';
import type { MergeRepairSession, SessionDetail } from '../api';
import { relTime } from './Transcript';

const ORIGIN_LABEL = { local: 'Local-only', merge: 'Merge commit', session: 'This session' } as const;
const REPAIR_RUNNING = ['PENDING', 'QUEUED', 'RUNNING'];
/** How long after a repair turn ends the check Orbit runs after it is still expected to appear. The server queues
 *  that check as the turn settles, so this only bridges a detail read in between. */
const REPAIR_CHECK_GRACE_MS = 60_000;
type RepairRowKind = 'running' | 'checking' | 'ready' | 'conflict' | 'reply' | 'failed' | 'finished';
const REPAIR_ICON: Record<RepairRowKind, ReactNode> = {
  running: <LoadingOutlined spin />, checking: <LoadingOutlined spin />, ready: <CheckCircleFilled />,
  conflict: <WarningFilled />, reply: <MessageFilled />, failed: <CloseCircleFilled />, finished: null,
};

const repairRunStateOf = (s?: MergeRepairSession | null) => (s?.runState ?? s?.runStatus ?? s?.status ?? '').toUpperCase();
/** When the repair session's last turn ended. */
const repairTurnEndedAt = (s: MergeRepairSession) => s.lastTurnAt ?? s.finishedAt ?? null;
/** The recovery on screen was checked after the repair's last turn ended, so it is that repair's result. */
const checkedAfterRepair = (r: MergeRecovery, s: MergeRepairSession) =>
  Date.parse(r.checkedAt ?? '') >= Date.parse(repairTurnEndedAt(s) ?? '');

/** A check of the recovery is running or owed: a preview in flight, or the check a repair turn left waiting for this
 *  session's own turn to end. Orbit starts both by itself; clients only show them. */
export function mergeRecoveryChecking(d: Pick<SessionDetail, 'mergeStatus' | 'mergeRecoveryAction' | 'mergeRepairTurnEndedAt'>): boolean {
  return (d.mergeStatus === 'pending' && d.mergeRecoveryAction === 'preview') || !!d.mergeRepairTurnEndedAt;
}

/** Whether the session detail keeps polling for its repair loop: while the repair session runs, and from when it stops
 *  until the check Orbit runs after it has answered — running, owed, or not yet queued for a turn that just ended. */
export function mergeRepairLoopLive(d: Pick<SessionDetail, 'mergeRecovery' | 'mergeRepairSession' | 'mergeStatus' |
  'mergeRecoveryAction' | 'mergeRepairTurnEndedAt'>, now = Date.now()): boolean {
  const s = d.mergeRepairSession;
  if (!d.mergeRecovery || !s) return false;
  if (REPAIR_RUNNING.includes(repairRunStateOf(s)) || mergeRecoveryChecking(d)) return true;
  return !checkedAfterRepair(d.mergeRecovery, s) && now - Date.parse(repairTurnEndedAt(s) ?? '') < REPAIR_CHECK_GRACE_MS;
}

/** The target moved after a finished repair, the check kept that repair and merged the new tips into it, and that merge
 *  is what conflicts. A kept repair keeps the branch an earlier check named after its previewId, while a repair that
 *  starts over is named after this check's. A kept repair that conflicts replaying the source saw no target move. */
export function mergeRecoveryTargetMovedAfterRepair(r: MergeRecovery): boolean {
  return r.code === 'CONFLICT' && r.phase === 'TARGET_SYNC' && !!r.repairBranch && !!r.previewId &&
    r.repairBranch !== `orbit/recovery/${r.previewId}`;
}

/** "Oct 11": the day a commit reached origin, with the year when it is not this one. */
function landedDay(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function MergeRecoveryPanel({ recovery: r, branch, message, busy, supported, checking = false, onAction, onRepair,
  repairSession, repairStarting, onOpenRepair }: {
  recovery: MergeRecovery;
  /** The session's branch — where the pushed work comes from. */
  branch?: string | null;
  message?: string | null;
  busy: boolean;
  supported: boolean;
  /** A check of this recovery is running or owed (mergeRecoveryChecking). */
  checking?: boolean;
  onAction?: (action: MergeRecoveryAction, previewId?: string) => void;
  onRepair?: (preparePr: boolean) => void;
  repairSession?: MergeRepairSession | null;
  repairStarting?: boolean;
  onOpenRepair?: () => void;
}) {
  const ready = mergeRecoveryReady(r);
  const pendingLocal = r.code === 'LOCAL_SYNC_PENDING';
  const retry = ['PUSH_FAILED', 'REMOTE_NOT_VERIFIED'].includes(r.code);
  const landed = r.code === 'ALREADY_LANDED';
  const unfinished = r.code === 'REPAIR_IN_PROGRESS';
  const repairRunState = repairRunStateOf(repairSession);
  const repairRunning = REPAIR_RUNNING.includes(repairRunState) || repairStarting;
  const repairFailed = repairRunState === 'FAILED';
  const t = r.targetBranch;
  const relation = mergeRecoveryTargetRelation(r);
  const push = r.pushCommits;
  const localOnly = r.localCommits?.length ?? 0;
  const conflicts = r.conflicts?.length ?? 0;
  const landedCommits = landed ? r.landedCommits ?? [] : [];
  const canAct = supported && !!onAction;
  // With a repair session attached, the panel follows its loop: it runs, Orbit checks what it left, and the main step
  // follows that result (docs/mocks/merge-recovery-repair-loop-ios.html). Nothing is left to repair once on origin.
  const loop = !repairSession || landed ? null : repairRunning ? 'running' : checking ? 'checking' : 'settled';
  const checkedAgo = r.checkedAt ? relTime(r.checkedAt) : '';
  const checkLabel = r.previewId ? 'Check again' : 'Check and repair';
  const fresh = !!repairSession && checkedAfterRepair(r, repairSession);
  const asked = repairSession?.lastAssistantText?.replace(/\s+/g, ' ').trim();
  const row: { kind: RepairRowKind; head: string; note?: string | null } | null = !loop ? null
    : loop === 'running' ? { kind: 'running', head: 'Repair session running', note: 'Tap to open the running session' }
    : repairFailed ? { kind: 'failed', head: 'Repair session failed', note: repairSession!.error }
    : loop === 'checking' ? { kind: 'checking', head: 'Repair session finished', note: 'Checking its result…' }
    : !fresh ? { kind: 'finished', head: 'Repair session finished' }
    : unfinished ? { kind: 'reply', head: 'Repair session needs your reply',
      note: asked ? `“${asked}” · ${relTime(repairTurnEndedAt(repairSession!)!)}` : null }
    : ready ? { kind: 'ready', head: 'Repair session finished', note: `Checked ${checkedAgo} — ready to merge` }
    : r.code === 'CONFLICT' ? { kind: 'conflict', head: 'Repair session finished',
      note: `Checked ${checkedAgo} — ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} left` }
    : { kind: 'finished', head: 'Repair session finished', note: checkedAgo && `Checked ${checkedAgo}` };
  // Beside the time once the loop has settled. While the repair runs, a check could only say it isn't done yet.
  const checkLink = loop === 'settled' && canAct && !pendingLocal;
  const title = pendingLocal ? `Merged into origin/${r.targetBranch}; local sync pending`
    : landed ? `Already on origin/${t}`
    : ready ? `Review synchronization into ${r.targetBranch}`
    : r.code === 'CONFLICT' ? (r.phase === 'TARGET_SYNC' ? `${r.targetBranch} synchronization has conflicts` : 'Your changes conflict with the synchronized target')
    : unfinished ? 'The repair isn’t finished'
    : r.code === 'PREVIEW_CHANGED' ? 'Branches changed — check again'
    : r.code === 'FETCH_FAILED' ? 'Could not check the remote'
    : retry ? 'Could not confirm the target push'
    : `${r.targetBranch} needs synchronization`;
  return <section className="wt-recovery" aria-label="Target branch recovery">
    <strong>{title}</strong>
    {loop === 'checking'
      ? <p className="wt-recovery-checked"><LoadingOutlined spin aria-hidden="true" /> Checking the repair…</p>
      : (checkedAgo || checkLink) && <p className="wt-recovery-checked">
        {checkedAgo && `Checked ${checkedAgo}`}{checkedAgo && checkLink && ' · '}
        {checkLink && <button type="button" className="wt-recovery-link" disabled={busy} onClick={() => onAction!('preview')}>{checkLabel}</button>}
      </p>}
    {unfinished && <p>Some files in the repair worktree are still unresolved.</p>}
    {landed && <p>{landedCommits.length ? `This session’s changes reached origin/${t} on ${landedDay(landedCommits[0].date)}. ` : ''}Nothing is left to merge.</p>}
    {row && onOpenRepair && <button type="button" className={`wt-recovery-repair-status is-${row.kind}`} onClick={onOpenRepair}>
      {REPAIR_ICON[row.kind] && <span aria-hidden="true" className="wt-recovery-repair-icon">{REPAIR_ICON[row.kind]}</span>}
      <span className="wt-recovery-repair-status-copy">
        <strong>{row.head}</strong>
        <small>{repairSession!.title ?? `Resolve merge recovery for ${r.targetBranch}`}</small>
        {row.note && <small className="wt-recovery-repair-note">{row.note}</small>}
      </span>
      <span aria-hidden="true" className="wt-recovery-repair-chevron">›</span>
    </button>}
    {/* What the last check found. While Orbit checks again it fades: the new result is about to replace it. */}
    <div className={`wt-recovery-snapshot${loop === 'checking' ? ' is-stale' : ''}`}>
      {(branch || relation) && <p className="wt-recovery-route">
        {branch && <><code>{branch}</code> → <code>{t}</code>{relation && ' · '}</>}
        {relation && (!relation.ahead && !relation.behind ? `Local ${t} matches origin/${t}`
          : !relation.behind ? `Local ${t} is ${relation.ahead} ahead of origin/${t}`
          : !relation.ahead ? `Local ${t} is ${relation.behind} behind origin/${t}`
          : `Local ${t}: ${relation.ahead} ahead, ${relation.behind} behind origin/${t}`)}
      </p>}
      {landed && localOnly > 0 && <p>Local {t}’s own {localOnly} {localOnly === 1 ? 'commit isn’t' : 'commits aren’t'} part of this session.</p>}
      {r.code === 'TARGET_DIVERGED' && <p>Local {r.targetBranch} and origin/{r.targetBranch} each have unique commits.</p>}
      {r.code === 'TARGET_AHEAD' && <p>Local {r.targetBranch} has extra commits that are not on origin/{r.targetBranch}. Review them before continuing this merge.</p>}
      {message && !ready && !landed && <details><summary>Details</summary><pre>{message}</pre></details>}
      {!r.previewId && !landed && <p>Check the local and remote commits before continuing the merge.</p>}
      {landedCommits.length > 0 && <div className="wt-recovery-histories">
        <details open className="wt-recovery-landed"><summary>On origin/{t} ({landedCommits.length} {landedCommits.length === 1 ? 'commit' : 'commits'})</summary>
          {landedCommits.map((c) => <div key={c.sha}><strong>{c.subject}</strong><small>Merged {landedDay(c.date)} · {c.author} · {c.sha.slice(0, 8)}</small></div>)}
          {landedCommits.some((c) => c.sha !== c.sourceSha) && <p>Matched by content — this branch was rewritten after {landedCommits.length === 1 ? 'it' : 'these'} merged.</p>}
        </details>
      </div>}
      {!landed && (push || r.localCommits || r.remoteCommits) && <div className="wt-recovery-histories">
        {push ? <details open className="wt-recovery-push"><summary>Pushes to origin/{t} ({push.length} {push.length === 1 ? 'commit' : 'commits'})</summary>
          {push.map((c) => { const origin = mergeRecoveryCommitOrigin(r, c);
            return <div key={c.sha}><strong>{c.subject}</strong><small><span className={`wt-recovery-origin is-${origin}`}>{ORIGIN_LABEL[origin]}</span> · {c.author} · {relTime(c.date)} · {c.sha.slice(0, 8)}</small></div>; })}
          <p>{r.addsMergeCommit ? `A merge commit joins both histories; nothing already on origin/${t} is rewritten.`
            : `Fast-forward push: nothing already on origin/${t} is rewritten.`}
            {localOnly ? ` Includes ${localOnly} local-only ${localOnly === 1 ? 'commit that was' : 'commits that were'} never pushed.` : ''}</p>
        </details>
        : r.localCommits && <details open><summary>Local-only commits ({r.localCommits.length}) — included in the push</summary>
          {r.localCommits.map((c) => <div key={c.sha}><strong>{c.subject}</strong><small>{c.author} · {relTime(c.date)} · {c.sha.slice(0, 8)}</small></div>)}
        </details>}
        {r.remoteCommits?.length ? <details><summary>Remote-only commits ({r.remoteCommits.length})</summary>
          {r.remoteCommits.map((c) => <div key={c.sha}><strong>{c.subject}</strong><small>{c.author} · {relTime(c.date)} · {c.sha.slice(0, 8)}</small></div>)}
        </details> : null}
      </div>}
      {r.conflicts?.length ? <div className="wt-recovery-files">
        <strong>{unfinished ? 'Still unresolved' : 'Conflicts'}</strong>
        <ul>{r.conflicts.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        {mergeRecoveryTargetMovedAfterRepair(r) && <p>origin/{t} moved after the repair. The repair was kept; only {conflicts === 1 ? 'this file conflicts' : 'these files conflict'} with the new commits.</p>}
      </div> : null}
      {r.patch !== undefined && r.candidateSha && <details className="wt-recovery-diff"><summary>Complete candidate diff against origin/{r.targetBranch}</summary><pre>{r.patch || 'No content changes.'}</pre></details>}
      {r.check && <p>{r.check.status === 'unconfigured' ? 'Git preview only; no merge check is configured.' : r.check.status === 'passed' ? 'Configured merge check passed.' : 'Configured merge check failed.'}</p>}
      {r.check?.output && <details><summary>Check output</summary><pre>{r.check.output}</pre></details>}
      {ready && <p>{!push && <>Preserves both target histories.{r.addsMergeCommit ? ' Adds one merge commit.' : ''}{localOnly ? ' The local-only commits above will be pushed with this session’s changes.' : ''} </>}If the repository requires linear history or a PR, prepare a PR candidate instead.</p>}
      {pendingLocal && <p>The remote contains the reviewed candidate. Save the blocking local edits before syncing; this action only updates this machine.</p>}
      {r.repairBranch && <details><summary>Saved repair branch and location</summary><code>{r.repairBranch}</code><br /><code>{r.repairWorktree}</code></details>}
    </div>
    <div className="wt-recovery-actions">
      {loop === 'running'
        ? <button type="button" className="wt-merge-btn" disabled={repairStarting || !onOpenRepair} onClick={onOpenRepair}>{repairStarting ? 'Opening repair session…' : 'Open repair session'}</button>
        : loop === 'checking'
        ? <button type="button" className="wt-merge-btn" disabled><LoadingOutlined spin aria-hidden="true" /> Checking…</button>
        : <>
          {canAct && (landed && mergeRecoveryConfirmable(r)
            ? <button type="button" className="wt-merge-btn" disabled={busy} onClick={() => onAction!('confirm-landed', r.previewId)}>Done</button>
            : pendingLocal
            ? <button type="button" disabled={busy} onClick={() => onAction!('sync-local', r.previewId)}>Sync local checkout</button>
            : <>
              {!loop && <button type="button" disabled={busy} onClick={() => onAction!('preview')}>{busy ? 'Checking…' : checkLabel}</button>}
              {ready && <button type="button" className="wt-merge-btn" disabled={busy} onClick={() => onAction!('apply', r.previewId)}>Sync {r.targetBranch} and merge</button>}
              {retry && <button type="button" disabled={busy} onClick={() => onAction!('apply', r.previewId)}>Check result / retry reviewed candidate</button>}
            </>)}
          {r.repairWorktree && onRepair && !pendingLocal && (loop
            // The same repair session takes the next step and carries on from its earlier rounds (S2), except a failed one:
            // the server opens a new repair session in its place, so that step is named as a new repair is.
            ? <>
              {!ready && <button type="button" className={r.code === 'CONFLICT' || unfinished ? 'wt-merge-btn' : undefined} disabled={busy}
                onClick={() => onRepair(false)}>{repairFailed ? 'Resolve in repair session' : unfinished ? 'Reply in repair session' : 'Continue repair'}</button>}
              {!unfinished && <button type="button" disabled={busy} onClick={() => onRepair(true)}>Prepare PR candidate</button>}
            </>
            : <>
              {r.code !== 'READY' && <button type="button" disabled={busy || repairRunning} onClick={() => onRepair(false)}>{repairStarting ? 'Opening repair session…' : 'Resolve in repair session'}</button>}
              <button type="button" disabled={busy || repairRunning} onClick={() => onRepair(true)}>Prepare PR candidate</button>
            </>)}
        </>}
    </div>
    {loop === 'running' && <p className="wt-recovery-actions-note">Orbit checks again when the repair stops.</p>}
    {!supported && <p>Update the runner to use target synchronization recovery.</p>}
  </section>;
}
