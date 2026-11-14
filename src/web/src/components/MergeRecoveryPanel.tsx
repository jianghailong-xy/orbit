import { useState, type ReactNode } from 'react';
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

type RepairRow = { kind: RepairRowKind; head: string; note?: string | null };
type RepairLoop = 'running' | 'checking' | 'settled' | null;

/** Where a recovery's repair loop stands, and the row that says so: the repair session runs, Orbit checks what it left,
 *  and the next step follows that result (docs/mocks/merge-recovery-repair-loop-ios.html). No loop without a repair
 *  session, nor once the work is on origin: nothing is left to repair. */
export function mergeRepairLoop(r: MergeRecovery, repairSession: MergeRepairSession | null | undefined, checking: boolean,
  repairStarting = false): { loop: RepairLoop; row: RepairRow | null } {
  const repairRunState = repairRunStateOf(repairSession);
  const repairRunning = REPAIR_RUNNING.includes(repairRunState) || repairStarting;
  const loop: RepairLoop = !repairSession || r.code === 'ALREADY_LANDED' ? null : repairRunning ? 'running' : checking ? 'checking' : 'settled';
  if (!loop) return { loop, row: null };
  const checkedAgo = r.checkedAt ? relTime(r.checkedAt) : '';
  const conflicts = r.conflicts?.length ?? 0;
  const fresh = checkedAfterRepair(r, repairSession!);
  const asked = repairSession!.lastAssistantText?.replace(/\s+/g, ' ').trim();
  const row: RepairRow = loop === 'running' ? { kind: 'running', head: 'Repair session running', note: 'Tap to open the running session' }
    : repairRunState === 'FAILED' ? { kind: 'failed', head: 'Repair session failed', note: repairSession!.error }
    : loop === 'checking' ? { kind: 'checking', head: 'Repair session finished', note: 'Checking its result…' }
    : !fresh ? { kind: 'finished', head: 'Repair session finished' }
    : r.code === 'REPAIR_IN_PROGRESS' ? { kind: 'reply', head: 'Repair session needs your reply',
      note: asked ? `“${asked}” · ${relTime(repairTurnEndedAt(repairSession!)!)}` : null }
    : mergeRecoveryReady(r) ? { kind: 'ready', head: 'Repair session finished', note: `Checked ${checkedAgo} — ready to merge` }
    : r.code === 'CONFLICT' ? { kind: 'conflict', head: 'Repair session finished',
      note: `Checked ${checkedAgo} — ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} left` }
    : { kind: 'finished', head: 'Repair session finished', note: checkedAgo && `Checked ${checkedAgo}` };
  return { loop, row };
}

/** The step the strip's repair row carries, which the panel under it then leaves out. */
type RepairStepKey = 'open' | 'apply' | 'repair';
/** The ready check's main step, on the panel and on the row alike. */
const mergeLabel = (r: MergeRecovery) => {
  const local = r.localCommits?.length ?? 0;
  const push = r.pushCommits;
  return local && push ? `Push ${push.length} ${push.length === 1 ? 'commit' : 'commits'} and merge` : `Merge into ${r.targetBranch}`;
};
/** The repair session takes the next step and carries on from its earlier rounds (S2), except a failed one: the server
 *  opens a new repair session in its place, so that step is named as a new repair is. */
const repairStepLabel = (r: MergeRecovery, s?: MergeRepairSession | null) =>
  repairRunStateOf(s) === 'FAILED' ? 'Resolve in repair session' : r.code === 'REPAIR_IN_PROGRESS' ? 'Reply in repair session' : 'Continue repair';

/** The target moved after a finished repair, the check kept that repair and merged the new tips into it, and that merge
 *  is what conflicts. A kept repair keeps the branch an earlier check named after its previewId, while a repair that
 *  starts over is named after this check's. A kept repair that conflicts replaying the source saw no target move. */
export function mergeRecoveryTargetMovedAfterRepair(r: MergeRecovery): boolean {
  return r.code === 'CONFLICT' && r.phase === 'TARGET_SYNC' && !!r.repairBranch && !!r.previewId &&
    r.repairBranch !== `orbit/recovery/${r.previewId}`;
}

/** A ready check whose push only adds this session's own commits on top of an origin the local target matches: nothing
 *  for the owner to decide, so the merge slot offers a plain Merge on its preview instead of this panel. Older runners
 *  leave pushCommits out, and then the panel still lists what the push adds. */
export function mergeRecoveryFastForward(r: MergeRecovery): boolean {
  const rel = mergeRecoveryTargetRelation(r);
  return mergeRecoveryReady(r) && !r.addsMergeCommit && !!rel && !rel.ahead && !rel.behind &&
    !!r.pushCommits?.length && r.pushCommits.every((c) => mergeRecoveryCommitOrigin(r, c) === 'session');
}

/** Past this a pending merge operation is overdue: the server's own WORKTREE_OPERATION_STALE_MS. */
const MERGE_OPERATION_OVERDUE_MS = 5 * 60_000;

/** The one line the merge slot shows while a merge operation is pending: what Orbit is doing, since when, and on which
 *  runner. It takes the place of the panel and every button, so nothing reads as a check that isn't running. */
export function MergeOperationLine({ action, target, requestedAt, runner, now = Date.now() }: {
  action?: MergeRecoveryAction | null;
  target: string;
  requestedAt?: string | null;
  runner?: { name?: string | null; displayName?: string | null; lastHeartbeatAt?: string | null } | null;
  now?: number;
}) {
  const what = action === 'preview' ? `Checking ${target} against origin/${target}`
    : action === 'sync-local' ? `Syncing local ${target}` : `Merging into ${target}`;
  const runnerName = runner?.displayName || runner?.name;
  const overdue = !!requestedAt && now - Date.parse(requestedAt) > MERGE_OPERATION_OVERDUE_MS;
  const since = [requestedAt && `started ${relTime(requestedAt)}`, runnerName && `on ${runnerName}`].filter(Boolean).join(' ');
  return <div className={`wt-merge-op${overdue ? ' is-overdue' : ''}`} role="status">
    {!overdue && <LoadingOutlined spin aria-hidden="true" />}
    <strong>{overdue ? `Still ${what[0].toLowerCase()}${what.slice(1)}` : what}</strong>
    {since && <span>· {since}</span>}
    {overdue && runnerName && runner?.lastHeartbeatAt && <span>· {runnerName} last reported {relTime(runner.lastHeartbeatAt)}</span>}
  </div>;
}

/** "Oct 11": the day a commit reached origin, with the year when it is not this one. */
function landedDay(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function MergeRecoveryPanel({ recovery: r, branch, message, busy, supported, checking = false, onAction, onRepair,
  repairSession, repairStarting, onOpenRepair, waitingForTurn = false, failed = false, underRow }: {
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
  /** The session is running a turn: every write waits for it to end, and the panel says so. */
  waitingForTurn?: boolean;
  /** The last operation on this recovery failed and `message` says why. A ready check would otherwise show nothing of it. */
  failed?: boolean;
  /** Drawn opened under the strip's repair row, which carries this step (or 'row' when it carries none). */
  underRow?: RepairStepKey | 'row';
}) {
  const ready = mergeRecoveryReady(r);
  const pendingLocal = r.code === 'LOCAL_SYNC_PENDING';
  const retry = ['PUSH_FAILED', 'REMOTE_NOT_VERIFIED'].includes(r.code);
  const landed = r.code === 'ALREADY_LANDED';
  const unfinished = r.code === 'REPAIR_IN_PROGRESS';
  const repairRunning = REPAIR_RUNNING.includes(repairRunStateOf(repairSession)) || repairStarting;
  const t = r.targetBranch;
  const relation = mergeRecoveryTargetRelation(r);
  const push = r.pushCommits;
  const localOnly = r.localCommits?.length ?? 0;
  const conflicts = r.conflicts?.length ?? 0;
  const landedCommits = landed ? r.landedCommits ?? [] : [];
  const canAct = supported && !!onAction;
  // With a repair session attached, the panel follows its loop (mergeRepairLoop).
  const { loop, row } = mergeRepairLoop(r, repairSession, checking, repairStarting);
  const checkedAgo = r.checkedAt ? relTime(r.checkedAt) : '';
  const checkLabel = r.previewId ? 'Check again' : 'Check and repair';
  // Under the strip's row (MergeRepairStrip) the row says where the repair stands and carries the next step, so the
  // panel draws neither again.
  const shown = (step: RepairStepKey) => !underRow || underRow !== step;
  // Beside the time once the loop has settled. While the repair runs, a check could only say it isn't done yet.
  const checkLink = loop === 'settled' && canAct && !pendingLocal;
  const more = (!!message && (!ready || failed) && !landed) || (r.patch !== undefined && !!r.candidateSha) || !!r.check || ready || !!r.repairBranch;
  const title = pendingLocal ? `Merged into origin/${r.targetBranch}; local sync pending`
    : landed ? `Already on origin/${t}`
    : ready && failed && message ? `The merge into ${t} didn’t go through`
    : ready ? (localOnly ? `Local ${t} has ${localOnly} ${localOnly === 1 ? 'commit' : 'commits'} that ${localOnly === 1 ? 'isn’t' : 'aren’t'} on origin`
      : r.addsMergeCommit ? `origin/${t} moved — merging joins both histories` : `Ready to merge into ${t}`)
    : r.code === 'CONFLICT' ? (!conflicts
        ? (r.phase === 'TARGET_SYNC' ? `${r.targetBranch} synchronization has conflicts` : 'Your changes conflict with the synchronized target')
      : r.phase === 'TARGET_SYNC' ? `Local ${t} and origin/${t} conflict in ${conflicts} ${conflicts === 1 ? 'file' : 'files'}`
      : `${conflicts} ${conflicts === 1 ? 'file conflicts' : 'files conflict'} with origin/${t}`)
    : unfinished ? 'The repair isn’t finished'
    : r.code === 'PREVIEW_CHANGED' ? 'Branches changed — check again'
    : r.code === 'FETCH_FAILED' ? 'Could not check the remote'
    : retry ? 'Could not confirm the target push'
    : `${r.targetBranch} needs synchronization`;
  return <section className="wt-recovery" aria-label="Target branch recovery">
    <strong>{title}</strong>
    {ready && failed && message && <p className="wt-recovery-failure">{message.split('\n')[0]}</p>}
    {loop === 'checking'
      ? <p className="wt-recovery-checked"><LoadingOutlined spin aria-hidden="true" /> Checking the repair…</p>
      : (checkedAgo || checkLink) && <p className="wt-recovery-checked">
        {checkedAgo && `Checked ${checkedAgo}`}{checkedAgo && checkLink && ' · '}
        {checkLink && <button type="button" className="wt-recovery-link" disabled={busy} onClick={() => onAction!('preview')}>{checkLabel}</button>}
      </p>}
    {unfinished && <p>Some files in the repair worktree are still unresolved.</p>}
    {landed && <p>{landedCommits.length ? `This session’s changes reached origin/${t} on ${landedDay(landedCommits[0].date)}. ` : ''}Nothing is left to merge.</p>}
    {row && onOpenRepair && !underRow && <button type="button" className={`wt-recovery-repair-status is-${row.kind}`} onClick={onOpenRepair}>
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
      {pendingLocal && <p>The remote contains the reviewed candidate. Save the blocking local edits before syncing; this action only updates this machine.</p>}
      {/* Everything below the decision: the full diff, the configured check, the policy note and where the repair lives. */}
      {more && <details className="wt-recovery-more"><summary>Details</summary>
        {message && (!ready || failed) && !landed && <pre>{message}</pre>}
        {r.patch !== undefined && r.candidateSha && <details className="wt-recovery-diff"><summary>Complete candidate diff against origin/{r.targetBranch}</summary><pre>{r.patch || 'No content changes.'}</pre></details>}
        {r.check && <p>{r.check.status === 'unconfigured' ? 'Git preview only; no merge check is configured.' : r.check.status === 'passed' ? 'Configured merge check passed.' : 'Configured merge check failed.'}</p>}
        {r.check?.output && <details><summary>Check output</summary><pre>{r.check.output}</pre></details>}
        {ready && <p>{!push && <>Preserves both target histories.{r.addsMergeCommit ? ' Adds one merge commit.' : ''}{localOnly ? ' The local-only commits above will be pushed with this session’s changes.' : ''} </>}If the repository requires linear history or a PR, prepare a PR candidate instead.</p>}
        {r.repairBranch && <details><summary>Saved repair branch and location</summary><code>{r.repairBranch}</code><br /><code>{r.repairWorktree}</code></details>}
      </details>}
    </div>
    <div className="wt-recovery-actions">
      {loop === 'running'
        ? shown('open') && <button type="button" className="wt-merge-btn" disabled={repairStarting || !onOpenRepair} onClick={onOpenRepair}>{repairStarting ? 'Opening repair session…' : 'Open repair session'}</button>
        : loop === 'checking'
        ? <button type="button" className="wt-merge-btn" disabled><LoadingOutlined spin aria-hidden="true" /> Checking…</button>
        : <>
          {canAct && (landed && mergeRecoveryConfirmable(r)
            ? <button type="button" className="wt-merge-btn" disabled={busy} onClick={() => onAction!('confirm-landed', r.previewId)}>Done</button>
            : pendingLocal
            ? <button type="button" disabled={busy} onClick={() => onAction!('sync-local', r.previewId)}>Sync local checkout</button>
            : <>
              {!loop && <button type="button" disabled={busy} onClick={() => onAction!('preview')}>{checkLabel}</button>}
              {ready && shown('apply') && <button type="button" className="wt-merge-btn" disabled={busy} onClick={() => onAction!('apply', r.previewId)}>{mergeLabel(r)}</button>}
              {retry && <button type="button" disabled={busy} onClick={() => onAction!('apply', r.previewId)}>Check result / retry reviewed candidate</button>}
            </>)}
          {r.repairWorktree && onRepair && !pendingLocal && (loop
            ? <>
              {!ready && shown('repair') && <button type="button" className={r.code === 'CONFLICT' || unfinished ? 'wt-merge-btn' : undefined} disabled={busy}
                onClick={() => onRepair(false)}>{repairStepLabel(r, repairSession)}</button>}
              {!unfinished && <button type="button" disabled={busy} onClick={() => onRepair(true)}>Prepare PR candidate</button>}
            </>
            : <>
              {r.code !== 'READY' && <button type="button" className={r.code === 'CONFLICT' ? 'wt-merge-btn' : undefined}
                disabled={busy || repairRunning} onClick={() => onRepair(false)}>{repairStarting ? 'Opening repair session…' : 'Resolve in repair session'}</button>}
              <button type="button" disabled={busy || repairRunning} onClick={() => onRepair(true)}>Prepare PR candidate</button>
            </>)}
        </>}
    </div>
    {loop === 'running' && !underRow && <p className="wt-recovery-actions-note">Orbit checks again when the repair stops.</p>}
    {waitingForTurn && loop !== 'running' && <p className="wt-recovery-actions-note">Available when this session’s turn ends.</p>}
    {!supported && <p>Update the runner to use target synchronization recovery.</p>}
  </section>;
}

/** A result that waits on the owner: the row opens itself once for it, so the panel is read before its step is taken. */
const NEEDS_YOU: RepairRowKind[] = ['ready', 'conflict', 'reply', 'failed'];

/** A recovery with a repair session, as one row of the parking strip (docs/mocks/merge-repair-strip-row, decided
 *  2026-11-14): where the repair stands and its next step, folded while the repair runs or Orbit checks it. The arrow
 *  opens the panel under it; a result that needs the owner opens it once by itself. */
export function MergeRepairStrip(props: Parameters<typeof MergeRecoveryPanel>[0]) {
  const { recovery: r, repairSession, repairStarting, checking = false, busy, supported, onAction, onRepair, onOpenRepair } = props;
  const { loop, row } = mergeRepairLoop(r, repairSession, checking, repairStarting);
  const pendingLocal = r.code === 'LOCAL_SYNC_PENDING';
  const ready = mergeRecoveryReady(r);
  const step: { key: RepairStepKey; label: string; run: () => void } | null = loop === 'running'
    ? onOpenRepair ? { key: 'open', label: repairStarting ? 'Opening…' : 'Open ›', run: onOpenRepair } : null
    : loop !== 'settled' || pendingLocal ? null
    : ready ? supported && onAction ? { key: 'apply', label: mergeLabel(r), run: () => onAction('apply', r.previewId) } : null
    : r.repairWorktree && onRepair ? { key: 'repair', label: repairStepLabel(r, repairSession), run: () => onRepair(false) } : null;
  // This result, so a new one opens the row again, and folding it keeps it folded.
  const result = row && NEEDS_YOU.includes(row.kind)
    ? `${row.kind}|${r.checkedAt ?? ''}|${repairSession ? repairTurnEndedAt(repairSession) ?? '' : ''}` : null;
  const [opened, setOpened] = useState(false);
  const [foldedFor, setFoldedFor] = useState<string | null>(null);
  if (!row) return <MergeRecoveryPanel {...props} />;
  const open = opened || (!!result && foldedFor !== result);
  const toggle = () => { if (open) { setOpened(false); setFoldedFor(result); } else setOpened(true); };
  const note = loop === 'running' ? `${repairSession!.title ?? `Resolve merge recovery for ${r.targetBranch}`} · Orbit checks again when it stops`
    : row.note || repairSession!.title;
  return <>
    <div className={`wt-repair-row is-${row.kind}`} onClick={toggle}>
      {REPAIR_ICON[row.kind] && <span aria-hidden="true" className="wt-repair-row-icon">{REPAIR_ICON[row.kind]}</span>}
      <span className="wt-repair-row-head">{row.head}</span>
      {note && <span className="wt-repair-row-note">· {note}</span>}
      <span className="wt-spacer" />
      {step && <button type="button" className={`wt-repair-row-step${step.key !== 'open' && row.kind !== 'finished' ? ' wt-merge-btn' : ''}`}
        disabled={step.key === 'open' ? !!repairStarting : busy}
        onClick={(e) => { e.stopPropagation(); step.run(); }}>{step.label}</button>}
      <button type="button" className="wt-expand" aria-expanded={open} aria-label={open ? 'Hide merge recovery' : 'Show merge recovery'}
        onClick={(e) => { e.stopPropagation(); toggle(); }}>{open ? '▾' : '▸'}</button>
    </div>
    {open && <MergeRecoveryPanel {...props} underRow={step?.key ?? 'row'} />}
  </>;
}
