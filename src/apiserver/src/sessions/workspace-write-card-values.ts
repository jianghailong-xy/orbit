import type { Prisma } from '@prisma/client';

/**
 * How Orbit holds the values of the environment variables a session asks to write to a workspace (the
 * rest of the card is runner-api/runner-workspace-approval.ts).
 *
 * The value may be a key, and the owner decides by reading it, so it has to be on the card while the
 * card asks: in plain text on `approval.input`, which only the owner's clients read, as the workspace
 * row holds a variable it was given. Once the card stops asking, nothing is left to read it for. The
 * yes the write goes through on is matched against a digest, so the row keeps the variables' names
 * and loses their values in the statement that answers it, or that collects it unanswered. A value
 * the owner refused stays nowhere, and one they allowed stays on the workspace alone.
 *
 * Two other records hold the same arguments and get the same treatment:
 *
 *   - An engine's own permission prompt for the call (Claude Code in Plan mode and Codex in Default ask
 *     one before the tool runs) files them under the tool's own name, `mcp__orbit__agent_update` and the like.
 *   - The transcript records the model's call as a tool_use, which is masked as it comes in
 *     ({@link withoutEnvValuesInToolUse}), on either transport and from any runner.
 *
 * Neither reaches what a model writes in its own words, or a command line it runs (`orbit agent update
 * --env`): those are kept as they were said, as anything else a model writes.
 */

export const WORKSPACE_CREATE_APPROVAL_TOOL_NAME = 'orbit_agent_create';
export const WORKSPACE_UPDATE_APPROVAL_TOOL_NAME = 'orbit_agent_update';

/** Neither card is answered by a workspace's "always allow": each write is its own question. */
export const WORKSPACE_WRITE_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  WORKSPACE_CREATE_APPROVAL_TOOL_NAME,
  WORKSPACE_UPDATE_APPROVAL_TOOL_NAME,
]);

/** The call however an engine or a card spells it: `orbit_agent_update`, `mcp__orbit__agent_update`, `orbit__agent_update`. */
const WORKSPACE_WRITE_TOOL_NAME = /(^|_)agent_(create|update)$/;

/** What a value reads as once it is gone from a transcript: the words a provider card has for its key. */
const VALUE_NOT_SHOWN = '(set — not shown)';

/** Whether a card of this name can hold a variable's value. */
export function holdsWorkspaceWriteValues(toolName: string): boolean {
  return WORKSPACE_WRITE_TOOL_NAME.test(toolName);
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `value` with every map under a key `env`, at any depth, replaced by what `replace` makes of it: each engine
 * nests a call's arguments its own way (`input.env`, `input.arguments.env`, `input.Arguments.env`, the server's
 * own `input.changes.env`). What holds no such map comes back as the very object it was.
 */
function withEnvReplaced(value: unknown, replace: (env: Record<string, unknown>) => [string, unknown]): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => withEnvReplaced(item, replace));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isMap(value)) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
    const next: [string, unknown] = key === 'env' && isMap(item) ? replace(item) : [key, withEnvReplaced(item, replace)];
    changed ||= next[0] !== key || next[1] !== item;
    return next;
  });
  return changed ? Object.fromEntries(entries) : value;
}

/** A card's input with its variables down to their names; any other input as it is. */
export function withoutEnvValues(input: unknown): unknown {
  return withEnvReplaced(input, (env) => ['envNames', Object.keys(env).sort()]);
}

/**
 * The same for the cards of a session that a reaper has just collected, which it does in statements
 * that write one status over many rows. Run in that transaction, so a card leaves PENDING and loses
 * its values together.
 */
export async function eraseEnvValuesOfCollectedCards(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<void> {
  const cards = await tx.approval.findMany({
    where: {
      sessionId,
      status: { not: 'PENDING' },
      OR: [{ toolName: { endsWith: 'agent_create' } }, { toolName: { endsWith: 'agent_update' } }],
    },
    select: { id: true, toolName: true, input: true },
  });
  for (const card of cards) {
    const erased = withoutEnvValues(card.input);
    if (holdsWorkspaceWriteValues(card.toolName) && erased !== card.input) {
      await tx.approval.update({ where: { id: card.id }, data: { input: erased as Prisma.InputJsonValue } });
    }
  }
}

/**
 * A tool_use event with the variables a workspace write names masked, and any other event as it is. The
 * edge of both event doors applies it, so nothing that reads a transcript afterwards — the tool call row,
 * the live stream, a session reading another's, the wiki's dossier — is handed the value. Antigravity wraps
 * its MCP calls in one tool of its own, which names the real one inside.
 */
export function withoutEnvValuesInToolUse<T>(event: T): T {
  const row = event as { type?: unknown; payload?: unknown };
  if (row?.type !== 'tool_use' || !isMap(row.payload) || !isMap(row.payload.input)) return event;
  const { name, input } = row.payload;
  const called = name === 'call_mcp_tool' ? input.ToolName : name;
  if (typeof called !== 'string' || !holdsWorkspaceWriteValues(called)) return event;
  const masked = withEnvReplaced(input, (env) => ['env', Object.fromEntries(Object.keys(env).map((key) => [key, VALUE_NOT_SHOWN]))]);
  return masked === input ? event : ({ ...row, payload: { ...row.payload, input: masked } } as T);
}
