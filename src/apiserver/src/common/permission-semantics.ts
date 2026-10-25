import { BadRequestException } from '@nestjs/common';
import {
  AgentProvider,
  CURSOR_DEFAULT_PERMISSION_MODE,
  CURSOR_PERMISSION_MODES,
  DSH_PERMISSION_MODES,
  ENGINE_CLI_NAMES,
  PermissionMode,
} from '@orbit/shared';

/**
 * The server half of DeepSeek Harness's permission table. The pickers describe the same set through
 * the shared `derivePermissionSemantics`; this is the boundary, because an account default, an
 * MCP-created session and an older client all reach dispatch without passing a picker.
 *
 * A mode dsh cannot enforce is refused, never substituted: running Plan or Accept Edits as Default,
 * or Bypass as Auto, would report a guarantee that was never applied (P0 contract §5, P4 evidence).
 */
export function assertDshPermissionMode(permissionMode: string): PermissionMode {
  if (!(DSH_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new BadRequestException(
      `DeepSeek Harness cannot enforce permission mode "${permissionMode}"; use Default, Auto or Don't Ask`,
    );
  }
  return permissionMode as PermissionMode;
}

/**
 * The server half of Cursor CLI's permission table (CURSOR_PERMISSION_MODES), on the same terms as
 * DeepSeek Harness's above: a mode it cannot be held to is refused, never substituted. Default would
 * need a write inside the workspace to ask, which no setting makes Cursor CLI do over ACP
 * (docs/cursor-runtime-contract.md §5.4, §16.5); Auto is the runner's own review of each request
 * Cursor CLI asks about. A session nobody named a mode for is given one Cursor CLI keeps when it is
 * created (SessionsService.create).
 */
export function assertCursorPermissionMode(permissionMode: string): PermissionMode {
  if (!(CURSOR_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new BadRequestException(
      `${ENGINE_CLI_NAMES[AgentProvider.CURSOR]} cannot enforce permission mode "${permissionMode}"; ` +
        "use Accept Edits, Plan, Auto, Don't Ask or Bypass",
    );
  }
  return permissionMode as PermissionMode;
}

/** The mode a new Cursor CLI session starts in when its caller named none: the account default when
 *  Cursor CLI keeps it, else its own default allowlist (CURSOR_DEFAULT_PERMISSION_MODE). */
export function cursorDefaultPermissionMode(accountDefault: string | null | undefined): PermissionMode {
  return accountDefault && (CURSOR_PERMISSION_MODES as readonly string[]).includes(accountDefault)
    ? (accountDefault as PermissionMode)
    : CURSOR_DEFAULT_PERMISSION_MODE;
}
