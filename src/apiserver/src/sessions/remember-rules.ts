import type { PermissionRule } from '@orbit/shared';

/** The "remember same kind" rules a stored approval maps to. The schemaless
 *  `remember_rule` JSON column holds an array (current) or a lone object (legacy rows
 *  written before the array form); normalize both to an array. We return the array for
 *  current runners and the primary rule under the deprecated `rememberRule` so a runner
 *  that predates the array form still remembers at least that one until it self-updates. */
export function normalizeStoredRememberRules(stored: unknown): {
  rememberRules?: PermissionRule[];
  rememberRule?: PermissionRule;
} {
  const rules = Array.isArray(stored)
    ? (stored as PermissionRule[])
    : stored
      ? [stored as PermissionRule]
      : [];
  return rules.length ? { rememberRules: rules, rememberRule: rules[0] } : {};
}

/**
 * Whether a tool name reaches past one MCP tool: `mcp__orbit` is a whole server in every runtime that
 * reads these rules, and so is a wildcard. A card asks about one call, so an "always allow" on it may
 * remember that call's tool and no more.
 *
 * Codex's MCP consent carries its tool only in its wording, so a runner that cannot read it, and every
 * runner from before it could, files a card named for the server. Such a card still gets its answer. It
 * leaves no rule, and no rule answers it (`SessionsService.rememberForWorkspace`,
 * `RunnerApiController.standingGrantCovers`).
 */
export function reachesPastOneMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__') && (toolName.includes('*') || !/^mcp__.+__.+$/.test(toolName));
}
