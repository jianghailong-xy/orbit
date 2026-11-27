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
 * The mode a claim or a reclaim hands the runner (QueueService.buildSession, RunnerApiController.reclaim), and, when it
 * is not the mode the session asked for, the substitution, which the claim logs and records on the mode change it
 * writes (recordActualPermissionMode).
 *
 * The session's mode goes through as asked, with two exceptions, and neither is a prediction about the engine
 * (project 350NMcNDulzkqRAFFUsXZ: keep the substitutions that are not predictions):
 *  - SCHEDULED_RUN: a scheduled run on Claude Code runs in Auto, whatever its level (scheduleRunPermissionMode);
 *  - ROOT_RUNNER: Bypass on a runner that runs as root, where Claude Code exits before its first frame, runs as Auto
 *    (ROOT_FALLBACK_PERMISSION_MODE).
 * DeepSeek Harness and Cursor CLI keep their own tables, which refuse a mode they cannot enforce rather than substitute
 * another (assertDshPermissionMode, assertCursorPermissionMode).
 *
 * What a claim no longer does is take Auto away from a Claude model whose catalogue row lists none
 * (normalizeBuiltinPermissionMode, which the other callers keep). That row is the runner's probe, run under the
 * runner's own environment and account rather than the session's, and the claim was where it turned Auto into Default
 * with nothing on record. Claude Code takes `--permission-mode auto` on any model and starts in Default where it has
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

/** What the substitution line says: the claimed session, its runtime and model, the mode asked for and the one handed. */
export interface ClaimPermissionModeLogFields {
  sessionId: string;
  provider: string;
  /** The model the runner is handed. */
  model: string | null | undefined;
  /** The mode handed. */
  mode: PermissionMode;
  substitution: ClaimedModeSubstitution;
}

/**
 * The line a claim writes for a substitution: `claim-permission-mode {json}`, with the session, the model, the mode
 * asked for (`from`), the mode handed (`to`) and the reason. Every value is one of a known set or checked by its shape,
 * as the claim-model line's are, and anything else is written "[redacted]".
 */
export function claimPermissionModeLogLine(fields: ClaimPermissionModeLogFields): string {
  const known = (set: ReadonlySet<string>, value: string) => (set.has(value) ? value : CLAIM_MODEL_LOG_REDACTED);
  const line = {
    sessionId: UUID.test(fields.sessionId) ? fields.sessionId : CLAIM_MODEL_LOG_REDACTED,
    provider: known(PROVIDERS, fields.provider),
    model: modelId(fields.model),
    from: known(MODES, fields.substitution.requestedMode),
    to: known(MODES, fields.mode),
    reason: known(REASONS, fields.substitution.reason),
  };
  return `claim-permission-mode ${JSON.stringify(line)}`;
}
