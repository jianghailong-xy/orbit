import { BadRequestException } from '@nestjs/common';
import { DSH_PERMISSION_MODES, PermissionMode } from '@orbit/shared';

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
