import type { OwnerItemKind, OwnerItemPushKind } from '@orbit/shared';
import { OWNER_ITEM_PUSH_KINDS } from '@orbit/shared';
import { CoordinatorQuestion, ownerItemKind } from '../projects/project-open-item';
import { FusePausedPayload, fusePausedWhy } from '../projects/project-fuse';

/** The item as the push reads it — the row's own columns, plus what a promotion adds. */
export interface OwnerItemAlertInput {
  kind: string;
  assignee: string;
  assigneeReason: string;
  /** The item's own title, written when it was opened. */
  title: string;
  payload: unknown;
  waitingSince: Date;
  escalatedAt: Date | null;
  /** What the project is called, for the "which project" half of every body. */
  projectTitle: string | null;
  /** The candidate a `PROMOTION_APPROVAL` is about; null for every other kind. */
  promotion: { sourceRef: string; upstreamRef: string; taskCount: number } | null;
}

/** What an owner item says on a lock screen, or null for "this is nobody's phone's business". */
export interface OwnerItemAlert {
  /** Which of the four this is, in the words the chips and the clients route by (§7.6 V12). */
  kind: OwnerItemPushKind;
  title: string;
  body: string;
}

/**
 * Longest body worth pushing. A notification is a glance: the card carries the whole question, the
 * whole reason a fuse blew and the whole list of tasks a merge would land, and all three are longer
 * than a lock screen shows. Same bound as `agentAlert`, for the same reason.
 */
const MAX_BODY_CHARS = 200;

/**
 * What to say about an owner item, and whether to say anything at all
 * (`docs/project-integration-line-contract.md` §7.6 V12).
 *
 * Pure, so every wording below is testable without Prisma or APNs, and separate from the delivery
 * decision (registered devices, the provider token, collapsing) which `PushService` owns.
 *
 * THE NEGATIVE CASE IS THE POINT. Four kinds ring a phone, and only four (owner decision 10): the
 * merge the owner has to confirm, the question their coordinator asked them, the exception that
 * became theirs, and the pause they are the only one who can lift. An exception the coordinator is
 * still working on is not one of them — it has an assignee who is not the owner, it is on the
 * project page under "With the coordinator", and pushing it would be interrupting somebody about
 * work that is already being done. So this answers null for it, and the caller sends nothing.
 *
 * THE WORDS ARE THE WEB'S. Each title is the heading its own card carries — `ProjectProgressStatus`
 * for the four escalation headings, `CoordinatorQuestionCard` for the question, `project-fuse` for
 * the pause — because a person who reads a banner and then opens the card must find the same
 * sentence, not a second paraphrase of it.
 */
export function ownerItemAlert(item: OwnerItemAlertInput): OwnerItemAlert | null {
  const kind = ownerItemKind(item);
  if (kind === null) return null;
  const title = alertTitle(kind, item);
  const body = oneLine(withProject(alertBody(kind, item), item.projectTitle));
  if (!title || !body) return null;
  return { kind: OWNER_ITEM_PUSH_KINDS[kind], title, body };
}

function alertTitle(kind: OwnerItemKind, item: OwnerItemAlertInput): string {
  switch (kind) {
    case 'PROMOTION_APPROVAL':
      // "Merge orbit/project-x into main?" — the branches, because that is what is being decided.
      // The item's own title counts the tasks instead, and is the fallback while the candidate is
      // unreadable: a merge approval with no wording at all would ring a phone about nothing.
      return item.promotion
        ? `Merge ${shortRef(item.promotion.sourceRef)} into ${shortRef(item.promotion.upstreamRef)}?`
        : item.title;
    case 'COORDINATOR_QUESTION':
      return COORDINATOR_QUESTION_TITLE;
    case 'FUSE_PAUSED':
      return FUSE_PAUSED_TITLE;
    case 'ESCALATED':
      return escalationTitle(item);
  }
}

function alertBody(kind: OwnerItemKind, item: OwnerItemAlertInput): string {
  switch (kind) {
    case 'PROMOTION_APPROVAL': {
      const tasks = item.promotion?.taskCount ?? 0;
      return `${tasks} ${tasks === 1 ? 'task' : 'tasks'} passed checks on the combined tree`;
    }
    case 'COORDINATOR_QUESTION':
      // The question itself, not the item title: the title is the question with `Coordinator asks:`
      // in front of it, and the alert's own title already says who is asking.
      return (item.payload as CoordinatorQuestion | null)?.question?.trim() || item.title;
    case 'FUSE_PAUSED':
      // Which spend crossed and against which limit — the first clause of the card's own line.
      return fusePausedWhy(item.payload as FusePausedPayload);
    case 'ESCALATED':
      return item.title;
  }
}

/** §7.5's heading for an item that BECAME the owner's, one per way it happened. The same five
 *  sentences `escalationHeading` draws on the project page (`ProjectProgressStatus.tsx`). */
function escalationTitle(item: OwnerItemAlertInput): string {
  switch (item.assigneeReason) {
    case 'COORDINATOR_ENDED':
      return 'Now yours — the coordinator conversation ended';
    case 'CHAIN_LIMIT':
      return 'Now yours — the 3rd failure in this chain';
    case 'HANDED_OVER':
      return 'Now yours — the coordinator handed it over';
    case 'NO_COORDINATOR':
      return 'Now yours — this project has no coordinator';
    default:
      return `Now yours — no one acted on this for ${waitedBeforeEscalation(item)}`;
  }
}

/** The heading the question card carries (`CoordinatorQuestionCard.COORDINATOR_QUESTION_HEADING`). */
const COORDINATOR_QUESTION_TITLE = 'The coordinator has a question';
/** The title the pause card was opened with (`project-fuse.FUSE_PAUSED_TITLE`). */
const FUSE_PAUSED_TITLE = 'The coordinator paused itself';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long the coordinator had it before the clock took it away, read off the two instants rather
 * than off the project's window — a window changed afterwards cannot make this sentence lie.
 * Web's `waitedBeforeEscalation`, including its answer for an item with no escalation moment.
 */
function waitedBeforeEscalation(item: OwnerItemAlertInput): string {
  if (item.escalatedAt == null) return 'a while';
  return formatSpan(item.escalatedAt.getTime() - item.waitingSince.getTime());
}

/** A span short enough for a lock screen: "45s", "12m", "3h 20m", "23h", "2d 4h", "12d".
 *  The web's `formatSpan` (`src/web/src/lib/watches.ts`), so the banner and the card agree. */
function formatSpan(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < MINUTE) return `${Math.max(1, Math.floor(abs / SECOND))}s`;
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return h < 6 && m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return d < 3 && h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Which project this is about, on the end of every body: a phone shows alerts from every project
 *  at once, and four of these read identically without it. */
function withProject(body: string, projectTitle: string | null): string {
  const project = projectTitle?.trim();
  return project ? `${body} · ${project}` : body;
}

/** One line, cut at the point a lock screen stops reading. */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_BODY_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…`;
}

/** `refs/heads/x` → `x`; anything else unchanged (`shortBranchName`, without the import cycle). */
function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}
