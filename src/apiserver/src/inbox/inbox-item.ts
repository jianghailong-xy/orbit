import { SessionDispatchOrigin } from '@prisma/client';
import { InboxApprovalKind, InboxSessionRole } from '@orbit/shared';

/**
 * The three derivations an inbox card is made of, kept pure and apart from the query so the
 * rules can be read — and tested — without a database.
 *
 * ("Inbox" here is the human's: the things waiting on a person. Unrelated to the session inbox
 * in `common/session-inbox-fence.ts`, which is the runner's message queue for one session.)
 */

/** How much of a summary line an inbox card gets. A plan runs to thousands of characters and
 *  the inbox lists every waiting approval in the account at once, so the whole input is never
 *  what a list wants — the card links to the session for that. */
const SUMMARY_MAX = 200;

/** claude routes plan confirmation and its own question tool through the same permission tool
 *  as any gated call, so the tool name is the only thing that separates them. Mirrors the web
 *  ApprovalPanel's split exactly (`isPlan`, `isQuestion`); the two must not disagree about what
 *  a card is. */
export function approvalKind(toolName: string): InboxApprovalKind {
  if (toolName === 'ExitPlanMode') return 'plan';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'permission';
}

/**
 * Why the session doing the asking exists.
 *
 * `coordinates` is the answer to "is this session some project's coordinator", which cannot be
 * read off the session — the pointer lives on Project, and there is deliberately no
 * `Session.projectId` column to shortcut it.
 *
 * Order is the definition, not an implementation detail: a coordinator is a coordinator even if
 * it also carries a task, and a verification task's session was dispatched by the coordinator
 * like any other, so `execution` has to be asked last of the three.
 */
export function sessionRole(
  session: {
    dispatchOrigin: SessionDispatchOrigin;
    task: { verifiesTaskId: string | null } | null;
  },
  coordinates: boolean,
): InboxSessionRole {
  if (coordinates) return 'coordinator';
  if (session.task?.verifiesTaskId) return 'verification';
  if (session.dispatchOrigin === SessionDispatchOrigin.PROJECT_COORDINATOR) return 'execution';
  return 'user';
}

/** One line naming what is being asked. '' when the input carries nothing worth showing — a
 *  card falls back to the tool name rather than to a line of JSON. */
export function approvalSummary(toolName: string, input: unknown): string {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (toolName === 'ExitPlanMode') return line(fields.plan);
  if (toolName === 'AskUserQuestion') {
    const first = Array.isArray(fields.questions) ? fields.questions[0] : undefined;
    const q = first && typeof first === 'object' ? (first as Record<string, unknown>) : {};
    return line(q.question) || line(q.header);
  }
  // The argument that IS the request, for the tools a human actually gets asked about: the
  // command for Bash, the file for Read/Edit/Write, the url for WebFetch, the pattern for
  // Grep/Glob. `description` is the fallback the Agent tool and several MCP tools carry.
  return (
    line(fields.command) ||
    line(fields.file_path) ||
    line(fields.url) ||
    line(fields.pattern) ||
    line(fields.description)
  );
}

/** First line, trimmed and capped. Multi-line values are the norm here (a plan, a heredoc
 *  command), and a card shows one line. */
function line(value: unknown): string {
  if (typeof value !== 'string') return '';
  const first = value.trim().split('\n', 1)[0].trim();
  return first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX)}…` : first;
}
