/**
 * Moving a session to another workspace (docs/session-folders-move-design.md §5): whether it may
 * go, where it may go, and what its row looks like afterwards. Pure, so the Move panel's
 * `GET /sessions/:id/move-targets` and `POST /sessions/:id/move` — which re-asks every question on
 * the rows it has locked — judge by the same rules and give the same reasons. The reasons are
 * English sentences the clients show exactly as they are.
 */
import { AgentProvider } from '@orbit/shared';
import { RunStatus } from '@prisma/client';
import { isSessionGenerating } from '../common/session-generating';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import { runAccount } from '../providers/plan-usage-accounts';
import { makeBranchName } from './naming';
import { SESSION_RUNNER_OFFLINE_AFTER_MS } from './session-state';
import { branchName } from '../projects/project-criterion-landing';

/** What a runner declares when it can take in a session moved from another workspace: it checks an
 *  old checkout's repository and branch before reusing it, and carries a Claude conversation over to
 *  the new directory (runner session_move.go). Only such a runner is offered as a place to move to. */
export const SESSION_MOVE_V1 = 'session-move/v1';

const ENDED: readonly RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

const RUNTIME_LABEL: Record<AgentProvider, string> = {
  [AgentProvider.CLAUDE]: 'Claude',
  [AgentProvider.CODEX]: 'Codex',
  [AgentProvider.KIMI]: 'Kimi',
  [AgentProvider.OPENCODE]: 'OpenCode',
  [AgentProvider.ANTIGRAVITY]: 'Antigravity',
  [AgentProvider.DSH]: 'DeepSeek Harness',
};

/** Why a session cannot move at all (§5.2, "会话自身"). */
export const MOVE_REFUSAL = {
  TRASH: 'Restore the session from Trash first.',
  COORDINATOR: "A project's coordinator stays in its project's workspace.",
  TASK: "A task run stays in its task's workspace.",
  IMPORTING: 'The session is still being imported.',
  ENDING: 'The session is ending. Try again in a moment.',
  STOP: 'Stop the session first.',
  BACKGROUND: 'Background tasks are still running.',
  MERGE: 'A merge is in progress. Try again when it finishes.',
  COMMIT: 'A commit is in progress. Try again when it finishes.',
  MERGE_REPAIR: 'Finish the merge repair first.',
  RETRY: 'An automatic retry is scheduled. Try again after it runs.',
  /** The move itself only takes an ended session; the client ends an idle one first (End and Move). */
  END: 'End the session first.',
} as const;

/** The session's own state, as §5.2 judges it. */
export interface SessionMoveFacts {
  status: RunStatus;
  deletedAt: Date | null;
  completedAt: Date | null;
  importSourceCwd: string | null;
  taskId: string | null;
  dispatchOrigin: string;
  /** It is a project's coordinator conversation (`project.coordinator_session_id`). */
  coordinatesProject: boolean;
  cancelRequestedAt: Date | null;
  engineTurnActive: boolean;
  runningBgShells: readonly string[];
  /** Approvals still being asked (countLiveApprovals). */
  liveApprovals: number;
  /** Messages, steers and shell commands sent to it and not yet answered. */
  queuedTurns: number;
  mergeStatus: string | null;
  commitStatus: string | null;
  /** A merge recovery waiting on its owner (readMergeRecovery). */
  mergeRecoveryOpen: boolean;
  retryAt: Date | null;
  /** The runtime that runs it (sessionExecRuntime), which a move never changes. */
  runtime: AgentProvider;
}

export type SessionMoveVerdict =
  /** It cannot move anywhere now, for `reason`. */
  | { reason: string; needsEnd: false }
  /** It can move: at once when ended, after being ended when `needsEnd` (idle but still open). */
  | { reason: null; needsEnd: boolean };

/**
 * May this session leave its workspace? Only an ended session moves: ending is when its runner
 * commits what it left uncommitted, and a session moved before that would leave the work on the old
 * machine with nobody to commit it. An idle one is movable once ended — the client's End and Move.
 */
export function sessionMoveVerdict(s: SessionMoveFacts): SessionMoveVerdict {
  const refuse = (reason: string): SessionMoveVerdict => ({ reason, needsEnd: false });
  if (s.deletedAt) return refuse(MOVE_REFUSAL.TRASH);
  // Where these run is the project's or the task's to say, not the session's.
  if (s.coordinatesProject || s.dispatchOrigin === 'PROJECT_COORDINATOR') return refuse(MOVE_REFUSAL.COORDINATOR);
  if (s.taskId) return refuse(MOVE_REFUSAL.TASK);
  if (s.importSourceCwd != null) return refuse(MOVE_REFUSAL.IMPORTING);
  // How their conversations would carry over has not been verified. agy's lives in a per-session
  // gemini directory on the runner (docs/antigravity-runtime-contract.md §3.1), and a resume from
  // any other directory silently starts a new conversation (§4.3).
  if (
    s.runtime === AgentProvider.KIMI ||
    s.runtime === AgentProvider.OPENCODE ||
    s.runtime === AgentProvider.ANTIGRAVITY ||
    s.runtime === AgentProvider.DSH
  ) {
    return refuse(`Moving ${RUNTIME_LABEL[s.runtime]} sessions isn't supported yet.`);
  }
  const ended = ENDED.includes(s.status);
  if (!ended) {
    if (s.cancelRequestedAt) return refuse(MOVE_REFUSAL.ENDING);
    if (
      s.status === RunStatus.PENDING ||
      isSessionGenerating(s) ||
      s.liveApprovals > 0 ||
      s.queuedTurns > 0
    ) {
      return refuse(MOVE_REFUSAL.STOP);
    }
    if (s.runningBgShells.length > 0) return refuse(MOVE_REFUSAL.BACKGROUND);
  }
  if (s.mergeStatus === 'pending') return refuse(MOVE_REFUSAL.MERGE);
  if (s.commitStatus === 'pending') return refuse(MOVE_REFUSAL.COMMIT);
  if (s.mergeRecoveryOpen) return refuse(MOVE_REFUSAL.MERGE_REPAIR);
  // The auto-retry sweeper's own predicate (AutoRetryService.sweep): a retryAt it would never act
  // on — left on a session that ended some other way — is not a retry anybody is waiting for.
  const retryArmed =
    s.retryAt != null &&
    s.completedAt == null &&
    ((s.status === RunStatus.AWAITING_INPUT && s.cancelRequestedAt == null) || s.status === RunStatus.FAILED);
  if (retryArmed) return refuse(MOVE_REFUSAL.RETRY);
  return { reason: null, needsEnd: !ended };
}

/** What a workspace offers as a place to move to (§5.2, "目标 Workspace"). */
export interface MoveTargetFacts {
  enabled: boolean;
  runnerId: string | null;
  runner: { name: string; displayName: string | null; capabilities: string[]; engines: unknown } | null;
}

/** A runner as the panel names it. */
export function runnerLabel(runner: { name: string; displayName: string | null }): string {
  return runner.displayName?.trim() || runner.name;
}

/** The runners list's rule (RunnersService isRunnerOnline, not imported: that file pulls in the
 *  runner controller): not marked offline, and heard from within the last three heartbeats. */
export function runnerIsOnline(
  runner: { status: string; lastHeartbeatAt: Date | null },
  now: number = Date.now(),
): boolean {
  return (
    runner.status !== 'OFFLINE' &&
    !!runner.lastHeartbeatAt &&
    runner.lastHeartbeatAt.getTime() >= now - SESSION_RUNNER_OFFLINE_AFTER_MS
  );
}

/**
 * Why `session` cannot move to `target`, or null when it can. An offline runner is no reason: the
 * move only changes where the session belongs, and its next message waits for the runner.
 */
export function moveTargetRefusal(
  session: { runtime: AgentProvider; assignedRunnerId: string | null; runnerName: string },
  target: MoveTargetFacts,
): string | null {
  if (!target.enabled) return 'This workspace is disabled.';
  if (!target.runnerId || !target.runner) return 'This workspace has no runner.';
  const runner = runnerLabel(target.runner);
  // As the New Session picker reads the report: an engine the runner says is not installed. No report,
  // or none for this engine, is a runner too old to say — not one that cannot run it.
  const engine = sanitizeRunnerEngines(target.runner.engines)?.find((entry) => entry.engine === session.runtime);
  if (engine && !engine.installed) return `${runner} can't run ${RUNTIME_LABEL[session.runtime]}`;
  // A Codex thread lives in the account directory of the machine that ran it.
  if (session.runtime === AgentProvider.CODEX && target.runnerId !== session.assignedRunnerId) {
    return `Codex keeps this conversation on ${session.runnerName}`;
  }
  // Without it the runner would reuse the old checkout of another repository (§5.5).
  if (!target.runner.capabilities.includes(SESSION_MOVE_V1)) return `Update ${runner} to move sessions here`;
  return null;
}

/**
 * The branch after a move: the same name, which the new workspace checks out afresh from its own
 * repository. Only a change of worktree setting changes it — a session moving into a workspace that
 * isolates its sessions gets a branch of its own, one moving out of it runs in the shared directory.
 */
export function branchAfterMove(
  session: { branch: string | null; title: string },
  fromWorktree: boolean,
  toWorktree: boolean,
): string | null {
  if (fromWorktree === toWorktree) return session.branch;
  return toWorktree ? session.branch ?? makeBranchName(session.title) : null;
}

/**
 * The account columns a move writes (§5.1). On the same runner the session stays on the account it
 * actually runs on, written onto the session: an empty column follows the workspace, and a Codex
 * conversation lives in its account's directory. On another runner the columns are cleared and
 * follow the new workspace — an account id names a slot on one machine only.
 */
export function accountsAfterMove(args: {
  sameRunner: boolean;
  session: { provider: string; claudeAccount: string | null; codexAccount: string | null };
  from: { env: unknown; claudeAccount: string | null; codexAccount: string | null } | null;
  runnerEngines: unknown;
}): {
  claudeAccount?: string | null;
  claudeAccountPinned?: boolean;
  codexAccount?: string | null;
  codexAccountPinned?: boolean;
  antigravityAccount?: string | null;
  antigravityAccountPinned?: boolean;
} {
  if (!args.sameRunner) {
    return {
      claudeAccount: null, claudeAccountPinned: false, codexAccount: null, codexAccountPinned: false,
      antigravityAccount: null, antigravityAccountPinned: false,
    };
  }
  // A configured provider or a pool runs on a credential of its own, not on one of the runner's accounts.
  const { session } = args;
  if (session.provider === AgentProvider.CLAUDE) {
    const choice = { claudeAccount: session.claudeAccount ?? args.from?.claudeAccount };
    const current = runAccount(AgentProvider.CLAUDE, args.from?.env, choice, args.runnerEngines);
    return typeof current === 'string' ? { claudeAccount: current } : {};
  }
  if (session.provider === AgentProvider.CODEX) {
    const choice = { codexAccount: session.codexAccount ?? args.from?.codexAccount };
    const current = runAccount(AgentProvider.CODEX, args.from?.env, choice, args.runnerEngines);
    return typeof current === 'string' ? { codexAccount: current } : {};
  }
  return {};
}

/** How many files the session's branch changed, as its runner last reported them. */
export function changedFileCount(changedFiles: unknown): number {
  return Array.isArray(changedFiles) ? changedFiles.length : 0;
}

/** Whether the branch's work is already in its merge target: the runner's verdict, or — where the
 *  runner has not given one — the last merge Orbit made of it (as the worktree status bar reads it). */
export function branchIsMerged(session: { branchMerged: boolean | null; mergeStatus: string | null }): boolean {
  return session.branchMerged ?? session.mergeStatus === 'merged';
}

/** The branch the session's work merges into: the one picked for it, its project's integration line
 * when it is a code task, its workspace's remembered one, else what the runner auto-detects (main,
 * else master). */
export function mergeTargetOf(
  session: { mergeTarget: string | null; mergeTargets: string[] },
  workspaceDefault: string | null | undefined,
  projectIntegrationRef?: string | null,
): string {
  if (session.mergeTarget) return session.mergeTarget;
  if (projectIntegrationRef) return branchName(projectIntegrationRef);
  if (workspaceDefault) return workspaceDefault;
  return !session.mergeTargets.includes('main') && session.mergeTargets.includes('master') ? 'master' : 'main';
}
