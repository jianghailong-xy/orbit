import {
  AgentProvider,
  CLAIM_PERMISSION_MODE_SUBSTITUTION_REASONS,
  PermissionMode,
  ROOT_FALLBACK_PERMISSION_MODE,
  permissionModeAvailableOnRunner,
} from '@orbit/shared';

import { assertCursorPermissionMode, assertDshPermissionMode } from '../common/permission-semantics';
import { scheduleRunPermissionMode } from '../schedules/schedule-access';
import type { AccessLevel } from '../schedules/schedule-envelope';
import type { ClaimedModeSubstitution } from '../sessions/actual-permission-mode';
import { CLAIM_MODEL_LOG_REDACTED, modelId } from './claim-model-log';

/**
 * The mode a claim or a reclaim hands the runner (QueueService.buildSession, RunnerApiController.reclaim), a config
 * change's setconfig and reload turns tell the engine (SessionsService.updateConfig), and a SubAgent is spawned in
 * (RunnerSubagentsController.childExec, subagent-remote.ts planRemoteExec); and, when it is not the mode asked for, the
 * substitution, which each logs (claimPermissionModeLogLine) and records: a claim on the mode change it writes, a config
 * change on the one its turn causes (recordActualPermissionMode), a SubAgent on its attempt
 * (SubagentAttempt.permissionModeSubstitution).
 *
 * The session's mode goes through as asked, with two exceptions, and neither is a prediction about the engine
 * (project 350NMcNDulzkqRAFFUsXZ: keep the substitutions that are not predictions):
 *  - SCHEDULED_RUN: a scheduled run on Claude Code runs in Auto, whatever its level (scheduleRunPermissionMode);
 *  - ROOT_RUNNER: Bypass on a runner that runs as root, where Claude Code exits before its first frame, runs as Auto
 *    (ROOT_FALLBACK_PERMISSION_MODE).
 * DeepSeek Harness and Cursor CLI keep their own tables, which refuse a mode they cannot enforce rather than substitute
 * another (assertDshPermissionMode, assertCursorPermissionMode).
 *
 * What none of them does any more is take Auto away from a Claude model whose catalogue row lists none
 * (normalizeBuiltinPermissionMode, which only the create and revive checks of a DeepSeek Harness or Cursor mode keep).
 * That row is the runner's probe, run under the runner's own environment and account rather than the session's, and
 * these were where it turned Auto into Default with nothing on record. Claude Code takes `--permission-mode auto` on any model and starts in Default where it has
 * no Auto (measured on 2.1.280 and 2.1.332, and the probe itself spawns every model that way), and its init frame says
 * what it settled on. That report is the session's actual mode, and the runner asks for Auto at once when the engine
 * settled lower (runner-go claude_mode_correction.go). So a session that asked for Auto is claimed in Auto, and the
 * mode it runs in is read from the engine, not foretold.
 */
export interface ClaimedPermissionMode {
  mode: PermissionMode;
  /** Null when `mode` is the mode the session asked for. */
  substitution: ClaimedModeSubstitution | null;
}

export function claimPermissionMode(
  provider: AgentProvider,
  requested: PermissionMode,
  scheduleRunAccessLevel: AccessLevel | null | undefined,
  runsAsRoot: boolean | null | undefined,
): ClaimedPermissionMode {
  if (provider === AgentProvider.DSH) return { mode: assertDshPermissionMode(requested), substitution: null };
  if (provider === AgentProvider.CURSOR) return { mode: assertCursorPermissionMode(requested), substitution: null };
  const scheduled = scheduleRunPermissionMode(requested, scheduleRunAccessLevel, provider);
  if (scheduled !== requested) {
    return { mode: scheduled, substitution: { requestedMode: requested, reason: 'SCHEDULED_RUN' } };
  }
  if (!permissionModeAvailableOnRunner(requested, runsAsRoot)) {
    return { mode: ROOT_FALLBACK_PERMISSION_MODE, substitution: { requestedMode: requested, reason: 'ROOT_RUNNER' } };
  }
  return { mode: requested, substitution: null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDERS: ReadonlySet<string> = new Set(Object.values(AgentProvider));
const MODES: ReadonlySet<string> = new Set(Object.values(PermissionMode));
const REASONS: ReadonlySet<string> = new Set(CLAIM_PERMISSION_MODE_SUBSTITUTION_REASONS);

/** Where a substitution was made: a claim (or reclaim), a config change, or a SubAgent's spawn. */
export type PermissionModeSubstitutionPath = 'CLAIM' | 'CONFIG_CHANGE' | 'SUBAGENT';
const PATHS: ReadonlySet<string> = new Set<PermissionModeSubstitutionPath>(['CLAIM', 'CONFIG_CHANGE', 'SUBAGENT']);

/** What the substitution line says: the claimed session, its runtime and model, the mode asked for and the one handed. */
export interface ClaimPermissionModeLogFields {
  /** The session; a SubAgent's parent. */
  sessionId: string;
  /** Absent on a claim, whose line keeps the shape it had. */
  path?: PermissionModeSubstitutionPath;
  /** A SubAgent's run, when it has one yet. */
  subagentRunId?: string | null;
  provider: string;
  /** The model the runner is handed. */
  model: string | null | undefined;
  /** The mode handed. */
  mode: PermissionMode;
  substitution: ClaimedModeSubstitution;
}

/**
 * The line a claim writes for a substitution: `claim-permission-mode {json}`, with the session, the model, the mode
 * asked for (`from`), the mode handed (`to`) and the reason. A config change and a SubAgent write the same line, naming
 * the `path` (and a SubAgent its run). Every value is one of a known set or checked by its shape, as the claim-model
 * line's are, and anything else is written "[redacted]".
 */
export function claimPermissionModeLogLine(fields: ClaimPermissionModeLogFields): string {
  const known = (set: ReadonlySet<string>, value: string) => (set.has(value) ? value : CLAIM_MODEL_LOG_REDACTED);
  const uuid = (value: string) => (UUID.test(value) ? value : CLAIM_MODEL_LOG_REDACTED);
  const line = {
    sessionId: uuid(fields.sessionId),
    ...(fields.path ? { path: known(PATHS, fields.path) } : {}),
    ...(fields.subagentRunId ? { subagentRunId: uuid(fields.subagentRunId) } : {}),
    provider: known(PROVIDERS, fields.provider),
    model: modelId(fields.model),
    from: known(MODES, fields.substitution.requestedMode),
    to: known(MODES, fields.mode),
    reason: known(REASONS, fields.substitution.reason),
  };
  return `claim-permission-mode ${JSON.stringify(line)}`;
}

/**
 * The substitution a config turn carries (updateConfig writes it beside the mode), for the mode change its delivery or
 * acknowledgement records; null when it carries none, or one this server would not have written.
 */
export function configTurnSubstitution(value: unknown): ClaimedModeSubstitution | null {
  if (!value || typeof value !== 'object') return null;
  const { requestedMode, reason } = value as { requestedMode?: unknown; reason?: unknown };
  if (typeof requestedMode !== 'string' || !MODES.has(requestedMode)) return null;
  if (typeof reason !== 'string' || !REASONS.has(reason)) return null;
  return { requestedMode: requestedMode as PermissionMode, reason: reason as ClaimedModeSubstitution['reason'] };
}
