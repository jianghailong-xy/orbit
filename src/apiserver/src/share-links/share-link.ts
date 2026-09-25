import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RunEventType } from '@orbit/shared';

/**
 * What a public link is, independent of how it is stored or served: its root kinds, its layers and
 * their defaults, its lifecycle states, the one answer a dead link gives, and what "Tool output
 * off" removes from a transcript. docs/share-links-design.md §1, §3 and §4 are the contract.
 */

export type ShareRootKind = 'SESSION' | 'TASK' | 'PROJECT';

export type ShareLayer = 'taskPages' | 'commentsAndFiles' | 'conversations' | 'toolOutput';

export type ShareInclude = Partial<Record<ShareLayer, boolean>>;

/**
 * The layers each kind of link has, with the value a layer takes when the owner never chose one
 * (contract §1). Overview is not here: it is always included and cannot be turned off. Tool output
 * defaults on everywhere; on a task or a project link it only matters once Conversations is on.
 */
export const LAYER_DEFAULTS: Readonly<Record<ShareRootKind, Readonly<ShareInclude>>> = {
  SESSION: { toolOutput: true },
  TASK: { commentsAndFiles: false, conversations: false, toolOutput: true },
  PROJECT: { taskPages: true, commentsAndFiles: false, conversations: false, toolOutput: true },
};

/** The kind's layers with what is stored laid over their defaults. A stored key the kind does not
 *  have, or one that is not a boolean, is not a choice anybody made through this API and is ignored. */
export function resolveInclude(kind: ShareRootKind, stored: unknown): Required<ShareInclude> {
  const choices = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const resolved: ShareInclude = {};
  for (const [layer, fallback] of Object.entries(LAYER_DEFAULTS[kind]) as [ShareLayer, boolean][]) {
    const chosen = choices[layer];
    resolved[layer] = typeof chosen === 'boolean' ? chosen : fallback;
  }
  return resolved as Required<ShareInclude>;
}

/**
 * The choices to store once `patch` is applied to `stored`: only keys somebody chose, so a default
 * the contract later changes still reaches every link nobody touched. A layer the kind does not
 * have is refused rather than stored — a project's `taskPages` on a session link would otherwise
 * sit in the row claiming a choice the page can never honour.
 */
export function mergeInclude(
  kind: ShareRootKind,
  stored: unknown,
  patch: ShareInclude | undefined,
): ShareInclude {
  const layers = LAYER_DEFAULTS[kind];
  const next: ShareInclude = {};
  const current = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  for (const layer of Object.keys(layers) as ShareLayer[]) {
    if (typeof current[layer] === 'boolean') next[layer] = current[layer] as boolean;
  }
  for (const [layer, value] of Object.entries(patch ?? {}) as [string, unknown][]) {
    if (value === undefined) continue;
    if (!(layer in layers)) {
      throw new BadRequestException(`include.${layer} does not apply to a ${kind.toLowerCase()} link`);
    }
    next[layer as ShareLayer] = value as boolean;
  }
  return next;
}

export type ShareLinkState = 'ACTIVE' | 'PAUSED' | 'ENDED';
/** Why a link is not ACTIVE: ended by its owner or by its expiry, or paused by the trash. */
export type ShareLinkStateReason = 'TURNED_OFF' | 'EXPIRED' | 'IN_TRASH';

/**
 * Where a link stands. Ended wins over paused: a link that was turned off, or ran past its expiry,
 * stays ended whatever happens to its root, while one whose session is in the trash comes back
 * when the session is restored (contract §3). Expiry is lazy — a link can be past `expiresAt` with
 * no `revokedAt` yet, and reads exactly as one that was settled.
 */
export function linkState(
  link: { revokedAt: Date | null; revokedReason: string | null; expiresAt: Date | null },
  rootInTrash: boolean,
  now: Date,
): { state: ShareLinkState; reason: ShareLinkStateReason | null } {
  if (link.revokedAt) {
    return { state: 'ENDED', reason: link.revokedReason === 'EXPIRED' ? 'EXPIRED' : 'TURNED_OFF' };
  }
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return { state: 'ENDED', reason: 'EXPIRED' };
  if (rootInTrash) return { state: 'PAUSED', reason: 'IN_TRASH' };
  return { state: 'ACTIVE', reason: null };
}

/**
 * The one answer a token that opens nothing gets, whatever the reason: never issued, turned off,
 * expired, or a session in the trash. One message on purpose — a visitor must not be able to tell
 * a paused link from a dead one, or a dead one from a guess (contract §3).
 */
export const LINK_NOT_FOUND = 'shared link not found';

export function linkNotFound(): NotFoundException {
  return new NotFoundException(LINK_NOT_FOUND);
}

/** The fields of a `background_task` event that say what happened to the process rather than what
 *  it ran or printed. Everything else — the command, its output and output path, the summary line
 *  Claude writes about it — is tool output. */
const BACKGROUND_TASK_KEPT = ['shellId', 'toolUseId', 'status', 'kind', 'tool', 'exitCode'] as const;

/**
 * An event as a link with Tool output off shows it (contract §1: "only messages and tool names").
 * A `tool_use` keeps its name and the ids that pair it with its result and its parent; its input
 * goes. A `tool_result` keeps whether it failed and those ids; its content goes. A `background_task`
 * keeps its lifecycle fields (BACKGROUND_TASK_KEPT). Every field is chosen, not removed, so a field
 * an engine adds later stays hidden until somebody decides it is not tool output. Other events pass
 * unchanged. `truncated` goes with the body it described: there is nothing left to expand.
 */
export function withoutToolOutput<E extends { type: string; payload: unknown; truncated?: true }>(event: E): E {
  const payload = event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
  const keep = (fields: readonly string[]) => {
    const kept: Record<string, unknown> = {};
    for (const field of fields) if (field in payload) kept[field] = payload[field];
    return kept;
  };
  let redacted: Record<string, unknown>;
  switch (event.type) {
    case RunEventType.TOOL_USE:
      redacted = keep(['id', 'name', 'parentToolUseId']);
      break;
    case RunEventType.TOOL_RESULT:
      redacted = keep(['toolUseId', 'isError', 'parentToolUseId']);
      break;
    case RunEventType.BACKGROUND_TASK:
      redacted = keep(BACKGROUND_TASK_KEPT);
      break;
    default:
      return event;
  }
  const { truncated: _described, ...rest } = event;
  return { ...rest, payload: redacted } as E;
}
