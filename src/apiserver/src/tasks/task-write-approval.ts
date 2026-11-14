import { toUuid } from '@orbit/shared';
import { ForbiddenException } from '@nestjs/common';

import { canonicalJson } from '../projects/canonical-json';
import type { PrismaService } from '../prisma/prisma.service';
import {
  DAG_CHANGE_CARD_TOOL,
  TASK_BATCH_CARD_TOOL,
  TASK_CREATE_CARD_TOOL,
} from './verifier-write-authority';

/**
 * The card that authorises an in-session task write, and the server's half of reading it.
 *
 * POLICY BY CALLER, NOT BY DOOR
 * =============================
 * An agent reaches the same writes over MCP and over the in-session CLI, and before this the
 * approval was enforced where each surface happened to remember it. `task_create` and
 * `task_create_batch` asked (runner-go `askBeforeTaskCreate` / `askBeforeBatch`) on both surfaces,
 * but `orbit task-list propose-dag --apply` did not ask at all, and nothing on the server required
 * any of them: a caller holding the runner credential could POST the write route directly. So the
 * rule lived in the interface that happened to ask instead of in the control plane the write
 * reaches, which is the definition of a bypass waiting for a second door.
 *
 * The rule here is stated once, about WHO is writing. The runner's machine credential is an
 * agent's credential: every consequential task write it makes must name the acting session and be
 * the one an answered confirmation card was raised for, and there is NO card-free write on it —
 * not with a session, not without one. The card-free door belongs to a PERSON's credential
 * (`orbit login` or a personal access token, on the user routes), which has no agent to card: that
 * is the owner's own act, recorded as theirs.
 *
 * WHY THE SESSION IS REQUIRED, NOT OPTIONAL
 * =========================================
 * `x-orbit-session-id` is attribution, not authentication: the CLI reads it from its environment,
 * and a process that unsets it looks exactly like a headless one while holding the same machine
 * credential — which every engine the runner spawns can read from `~/.orbit`. So "no session
 * named" may not mean "the owner at their terminal"; it may mean "an agent that took the header
 * off". The control plane answers both the same way. A headless process that must file work acts
 * as the account owner with a personal access token, which is a credential an engine does not
 * hold. The named session must also be one this runner hosts, for this account, and not ended: a
 * forged id, another conversation's, another runner's, a trashed one and a completed one all name
 * no agent that can be acting now (`docs/orbit-agent-contract.md` §2.4, §4.5).
 *
 * WHAT MATCHES IS THE WRITE, NOT THE CARD'S EXISTENCE
 * ===================================================
 * "This session has an approved card" is not the question. A card approved for one change is not a
 * standing permission to make another, so the comparison is over a canonical projection of the
 * write: the batch's items, the single create's body, or the DAG's list and edges. Ids are compared
 * by the row they resolve to, never by spelling — the card stores the caller's base62 and the DTO
 * arrives with uuids (`project-integration-approval.ts` has the same two-spellings problem).
 *
 * Two things are dropped because the SERVER puts them on the card: the preview it computes for the
 * human (`cardInput` in `runner-api.controller.ts`), and `acceptsStartAfterCreate`, which is the
 * asker's declaration about the card rather than part of the write. `runAt` is the one field a
 * write may gain after the card: the owner's "Create and start" answer turns it into a due
 * schedule, and the approval's own `startAfterCreate` records that this is exactly what happened.
 *
 * The card is NOT consumed. Re-sending what the owner already read is a retry — a lost response, an
 * engine restart — and burning the card would turn that into a write that can never be repeated
 * without interrupting them with a question they already answered
 * (`findMergeCheckApproval` makes the same call).
 */

/** The stable refusal code, and the actions that clear it. */
export const TASK_WRITE_NEEDS_OWNER_CARD_CODE = 'TASK_WRITE_NEEDS_OWNER_CARD';
export const TASK_WRITE_NEEDS_OWNER_CARD_ACTION = 'ASK_THROUGH_THE_SAME_TOOL';
export const TASK_WRITE_NEEDS_SESSION_ACTION = 'USE_A_PERSONAL_ACCESS_TOKEN';

/** Session statuses a write may no longer be made under: the conversation is over. */
const ENDED_SESSION_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/**
 * How many of a session's answered cards of one kind are read looking for the covering one.
 *
 * The card that authorises a write was answered immediately before that write — the runner blocks
 * on the answer and then sends it — so the covering card is the newest one in every ordinary case,
 * and a retry hours later still sits well inside this window. The bound exists so a session that
 * has asked thousands of times (this deployment has had one) cannot make every later write re-read
 * its whole history; past it, the card is not found and the agent is told to ask again, which is
 * fail-closed rather than a bypass.
 */
const APPROVAL_LOOKBACK = 200;

/** The write a session is about to make, in the shape the card comparison reads. */
export type SessionTaskWrite =
  | { toolName: typeof TASK_CREATE_CARD_TOOL; create: unknown }
  | { toolName: typeof TASK_BATCH_CARD_TOOL; tasks: readonly unknown[] }
  | { toolName: typeof DAG_CHANGE_CARD_TOOL; listId: string; ops: readonly unknown[] };

/**
 * The fields of a task body (or a DAG op) that name another row. Compared as the row they name:
 * one end spells them base62 and the other uuid, and which row an id names is the question.
 */
const ID_FIELDS: ReadonlySet<string> = new Set([
  'assigneeId',
  'attachmentIds',
  'dependsOnTaskId',
  'dependsOnTaskIds',
  'fixesOpenItemId',
  'listId',
  'parentTaskId',
  'projectId',
  'supersedesTaskId',
  'taskId',
  'verifiesTaskId',
]);

/** Keys the server adds to a stored card, or the asker declares about the card — never the write. */
const CARD_ONLY_FIELDS: ReadonlySet<string> = new Set(['preview', 'acceptsStartAfterCreate']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idAsSpelled(value: string): string {
  try {
    return toUuid(value);
  } catch {
    return value;
  }
}

/** The same value with every id-named field resolved to the row it names, recursively. */
export function resolveIds(value: unknown, field?: string): unknown {
  if (typeof value === 'string') return field && ID_FIELDS.has(field) ? idAsSpelled(value) : value;
  if (Array.isArray(value)) return value.map((item) => resolveIds(item, field));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // `undefined` is the DTO's absent: a class-transformer instance carries optional properties
    // that were never sent, and the stored card never had them. Absent and null stay distinct.
    if (item === undefined) continue;
    out[key] = resolveIds(item, key);
  }
  return out;
}

/** What a single create writes, as one comparable string. */
function createKey(body: unknown, startedAfterApproval: boolean): string {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(isRecord(body) ? body : {})) {
    if (CARD_ONLY_FIELDS.has(key) || value === undefined) continue;
    // The owner's "Create and start" answer writes the due schedule into the body AFTER the card
    // was filed. The approval's own column is what makes that difference expected (`create`).
    if (key === 'runAt' && startedAfterApproval) continue;
    fields[key] = value;
  }
  return canonicalJson(resolveIds(fields));
}

/** Whether one stored card authorises this single create. */
export function cardCoversCreate(
  card: { input: unknown; startAfterCreate: boolean },
  body: unknown,
): boolean {
  return createKey(card.input, card.startAfterCreate) === createKey(body, card.startAfterCreate);
}

/** Whether one stored card authorises this batch, item for item. */
export function cardCoversBatch(cardInput: unknown, tasks: readonly unknown[]): boolean {
  const named = isRecord(cardInput) && Array.isArray(cardInput.tasks) ? cardInput.tasks : [];
  return canonicalJson(resolveIds(named)) === canonicalJson(resolveIds(tasks));
}

/** Whether one stored card authorises this restructure: the same list, and the same edges. */
export function cardCoversDag(cardInput: unknown, listId: string, ops: readonly unknown[]): boolean {
  if (!isRecord(cardInput) || typeof cardInput.listId !== 'string') return false;
  if (idAsSpelled(cardInput.listId) !== idAsSpelled(listId)) return false;
  const named = Array.isArray(cardInput.ops) ? cardInput.ops : [];
  return canonicalJson(resolveIds(named)) === canonicalJson(resolveIds(ops));
}

function cardCovers(
  card: { input: unknown; startAfterCreate: boolean },
  write: SessionTaskWrite,
): boolean {
  switch (write.toolName) {
    case TASK_CREATE_CARD_TOOL:
      return cardCoversCreate(card, write.create);
    case TASK_BATCH_CARD_TOOL:
      return cardCoversBatch(card.input, write.tasks);
    default:
      return cardCoversDag(card.input, write.listId, write.ops);
  }
}

/**
 * The answered card that authorises this write, or null when there is none.
 *
 * ALLOWED only. A PENDING card is a question nobody has answered, a DENIED or ABANDONED one is an
 * answer that says no, and neither authorises anything. Unlike the skip-merge-check card, an
 * auto-allowed one (`decidedById: null`) DOES count: the create cards have a product policy that
 * answers them — a workspace's standing grant, a coordinator's task in an unstarted or Automatic
 * project — and the owner set that policy. What this gate guarantees is that no session write
 * reaches the database that no card answered at all.
 */
export async function findTaskWriteApproval(
  prisma: Pick<PrismaService, 'approval'>,
  sessionId: string,
  write: SessionTaskWrite,
): Promise<{ approvalId: string } | null> {
  const cards = await prisma.approval.findMany({
    where: { sessionId, toolName: write.toolName, status: 'ALLOWED' },
    select: { id: true, input: true, startAfterCreate: true },
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    take: APPROVAL_LOOKBACK,
  });
  const covering = cards.find((card) => cardCovers(card, write));
  return covering ? { approvalId: covering.id } : null;
}

/**
 * Refuse a session write that no answered card covers. The message names the tool that raises the
 * card, because the caller's next move is that tool and not a different door.
 */
export function taskWriteNeedsOwnerCardBody(write: SessionTaskWrite) {
  const asking =
    write.toolName === TASK_BATCH_CARD_TOOL
      ? 'task_create_batch'
      : write.toolName === DAG_CHANGE_CARD_TOOL
        ? 'tasklist_propose_dag'
        : 'task_create';
  const what =
    write.toolName === TASK_BATCH_CARD_TOOL
      ? 'create tasks in batch'
      : write.toolName === DAG_CHANGE_CARD_TOOL
        ? 'restructure a task list’s dependencies'
        : 'create a task';
  return {
    code: TASK_WRITE_NEEDS_OWNER_CARD_CODE,
    kind: 'REFUSAL',
    requiredAction: TASK_WRITE_NEEDS_OWNER_CARD_ACTION,
    message:
      `a session may ${what} only on the account owner's answered confirmation card, and no `
      + 'answered card for this exact write was found in this conversation. Nothing was written. '
      + `${asking} puts the card in front of them and performs the write once they answer`
      + (write.toolName === TASK_BATCH_CARD_TOOL
        ? '; a dry run answers where the plan would land without asking anybody.'
        : '.'),
  };
}

/**
 * Refuse a machine-credential write that names no usable acting session. Same code as an uncarded
 * write — it is the same rule about the same credential — with the action a headless caller can
 * actually take: act as the account owner with a personal access token.
 */
export function taskWriteNeedsSessionBody() {
  return {
    code: TASK_WRITE_NEEDS_OWNER_CARD_CODE,
    kind: 'REFUSAL',
    requiredAction: TASK_WRITE_NEEDS_SESSION_ACTION,
    message:
      'a task write on this machine’s runner credential must name the acting session it is made '
      + 'for, and no usable session was named — it is missing, unknown, another account’s, '
      + 'another runner’s, or the conversation has ended. Nothing was written. Inside a session '
      + 'the MCP tools and the CLI name it for you; a headless process has no session to act for, '
      + 'so it must act as the account owner with a personal access token (`ORBIT_USER_TOKEN`, or '
      + '`orbit login`), which is the owner’s own act and needs no card.',
  };
}

/**
 * True when this write may proceed: a usable acting session and a covering answered card. Throws
 * the refusal otherwise. There is deliberately no "no session" exemption — the machine credential
 * is the agent's credential, and a write that sheds its session is an agent hiding, not an owner
 * typing (`docs/orbit-agent-contract.md` §4.5).
 */
export async function assertSessionTaskWriteHasCard(
  prisma: Pick<PrismaService, 'approval' | 'session'>,
  input: { ownerId: string; runnerId: string; sessionId?: string; write: SessionTaskWrite },
): Promise<void> {
  const sessionId = input.sessionId?.trim();
  if (!sessionId || !UUID_RE.test(sessionId)) throw new ForbiddenException(taskWriteNeedsSessionBody());
  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      ownerId: input.ownerId,
      assignedRunnerId: input.runnerId,
      deletedAt: null,
      status: { notIn: [...ENDED_SESSION_STATUSES] },
    },
    select: { id: true },
  });
  if (!session) throw new ForbiddenException(taskWriteNeedsSessionBody());
  if (await findTaskWriteApproval(prisma, sessionId, input.write)) return;
  throw new ForbiddenException(taskWriteNeedsOwnerCardBody(input.write));
}
