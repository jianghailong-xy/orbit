import { Prisma } from '@prisma/client';

import { ENGINE_INCOMPATIBLE_ERROR_LIKE } from '../providers/custom-provider';
import {
  ADMIN_ONLY_PROVIDER_ERROR,
  ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
  CURSOR_NOT_INSTALLED_ERROR,
  CURSOR_RUNNER_UPGRADE_ERROR,
  DSH_NOT_INSTALLED_ERROR,
  DSH_PLATFORM_UNSUPPORTED_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  DSH_VERSION_INCOMPATIBLE_ERROR,
  OPENCODE_RUNNER_UPGRADE_ERROR,
  PROVIDER_UNAVAILABLE_ERROR,
  SOURCE_PROTOCOL_UNSUPPORTED_ERROR,
} from '../runner-api/runner-provider-support';
import { CLAUDE_REGION_ERROR_PREFIX } from '../runners/runner-region';

/**
 * A hold notice: the sentence a queued session carries in `session.error` while something nobody asked for keeps a
 * runner from starting it, which the claim that starts it clears (`QueueService.trySessionClaim`). This module is the
 * one list of those sentences: the claim clears exactly what `holdNoticeSql` matches, and a session payload's
 * `waitingOn: 'HOLD'` (sessions/session-phase.ts) reads a PENDING row's notice with `isHoldNotice`. Any other `error`
 * on a row is not a hold — it is a leftover the claim keeps.
 *
 * Writers, each on a PENDING row or putting a claimed one back to PENDING:
 *   - `QueueService.pausedPendingSessions`: a paused account, an unavailable or admin-only provider, an
 *     engine-incompatible credential, the Claude region check, dsh not ready;
 *   - `QueueService.trySessionClaim`: its own POOL_ACCOUNT_PAUSED / PROVIDER_ENGINE_INCOMPATIBLE refusal;
 *   - `RunnerApiController.dequeueTurn`: the account-pause put-back;
 *   - `RunnerApiController.markProviderUpgradeRequired`: the runner-upgrade and provider notices;
 *   - `RunnerApiController.completeTurn` and the region-stop finalize: a turn the region check stopped, its sentence.
 */
export const HOLD_NOTICE_ERRORS: readonly string[] = [
  OPENCODE_RUNNER_UPGRADE_ERROR,
  ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  CURSOR_RUNNER_UPGRADE_ERROR,
  CURSOR_NOT_INSTALLED_ERROR,
  DSH_NOT_INSTALLED_ERROR,
  DSH_PLATFORM_UNSUPPORTED_ERROR,
  DSH_VERSION_INCOMPATIBLE_ERROR,
  PROVIDER_UNAVAILABLE_ERROR,
  ADMIN_ONLY_PROVIDER_ERROR,
  SOURCE_PROTOCOL_UNSUPPORTED_ERROR,
];

/** A paused account's sentence, `Account paused until <instant>`, as a LIKE pattern. */
export const ACCOUNT_PAUSED_ERROR_LIKE = 'Account paused until %';

/** A LIKE pattern (with `%` and `_`, no escape) as the anchored regular expression it means. */
function likeToRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((ch) => (ch === '%' ? '[\\s\\S]*' : ch === '_' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'u');
}

const HOLD_NOTICE_PATTERNS = [ACCOUNT_PAUSED_ERROR_LIKE, ENGINE_INCOMPATIBLE_ERROR_LIKE].map(likeToRegExp);

/** Whether `error` is a hold notice. */
export function isHoldNotice(error: string | null | undefined): boolean {
  if (error == null) return false;
  return HOLD_NOTICE_ERRORS.includes(error)
    || HOLD_NOTICE_PATTERNS.some((pattern) => pattern.test(error))
    || error.startsWith(CLAUDE_REGION_ERROR_PREFIX);
}

/** `isHoldNotice` in SQL, over the error column `error` names. */
export function holdNoticeSql(error: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${error} IN (${Prisma.join(HOLD_NOTICE_ERRORS)})
    OR ${error} LIKE ${ACCOUNT_PAUSED_ERROR_LIKE} OR ${error} LIKE ${ENGINE_INCOMPATIBLE_ERROR_LIKE}
    -- The region check's hold, released (docs/claude-region-check-contract.md §11), and the sentence a turn it
    -- stopped ended with: both begin with the code.
    OR starts_with(${error}, ${CLAUDE_REGION_ERROR_PREFIX}))`;
}
