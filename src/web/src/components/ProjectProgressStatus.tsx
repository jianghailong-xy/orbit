import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button } from 'antd';
import type {
  CoordinatorFuseUsage,
  CoordinatorWakeups,
  OpenItemAction,
  ProjectOpenItemRow,
  ProjectOpenItemsView,
} from '@orbit/shared';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { projectOpenItemsQuery } from '../lib/queries';
import { ago, formatSpan } from '../lib/watches';

/**
 * What a project still owes somebody, and what its coordinator has left to spend
 * (`docs/project-integration-line-contract.md` §7.2 V5 / V7, §7.5; mocks 2 ②③, 5 and 6 ①).
 *
 * WHY THE PAGE NEEDED THIS AT ALL. A project that had stopped moving said so nowhere. The work
 * overview counted tasks, the coordinator card said "Idle", and the reason — a merge conflict
 * nobody had picked up, a question waiting on the owner, a fuse that had paused the conversation
 * two hours ago — lived in rows no page read. So "why is this not moving" could only be answered by
 * asking the coordinator, which is how 54 coordinator conversations came to be driven by hand.
 * Every row here is one of those rows, with the two facts that make it actionable: WHO has it, and
 * HOW LONG they have had it.
 *
 * TWO SHAPES, ONE READ. The project page wants a list — the owner is catching up on a project and
 * needs the whole of it, oldest first. The coordinator's own conversation wants cards — it is a
 * transcript, and a card is how everything else the platform files there is drawn. Both are this
 * module against `GET /projects/:id/open-items`, so what the two say cannot drift: one component
 * renders an item, and the hosts decide whether it is a row or a card.
 *
 * WHAT IS DRAWN IS WHAT THE SERVER SERVES. `detailLine` is the server's own sentence about the
 * fact that opened the item, and `actions` is the set of presses that have a door on the other side
 * today (§4.8). Neither is re-derived here: a card that composed its own sentence from a payload
 * would be a second rendering of one fact, free to disagree with the row beside it, and a button
 * this file invented would be one the reader presses to no effect.
 */

/** §7.5's mark: Orbit filed this, an agent turn did not write it. The wording the criteria and
 *  question cards already carry, so the three read as one family. */
export const FROM_ORBIT = 'FROM ORBIT';
export const FROM_ORBIT_TITLE =
  'Orbit filed this from the fact that opened it. It is not something an agent turn wrote into this page.';

export const OPEN_ITEMS_HEADING = 'Open items';
export const NEEDS_YOU_GROUP = 'Needs you';
export const WITH_COORDINATOR_GROUP = 'With the coordinator';

/** The two words each group's rows use for who has the item. */
const WHO = { OWNER: 'You', COORDINATOR: 'Coordinator' } as const;

/**
 * §7.5's heading for an item that BECAME the owner's, one per way it happened.
 *
 * Each says the thing the owner has to know before deciding anything: nobody acted, the
 * conversation that had it is over, the chain ran out of attempts, or somebody put it here on
 * purpose. `DEFAULT` is absent because an item assigned to the owner from the start — a question,
 * a merge approval, a pause — is not an escalation and says so in its own title.
 */
function escalationHeading(row: ProjectOpenItemRow, now: number): string | null {
  switch (row.assigneeReason) {
    case 'ESCALATED':
      return `Now yours — no one acted on this for ${waitedBeforeEscalation(row)}`;
    case 'COORDINATOR_ENDED':
      return 'Now yours — the coordinator conversation ended';
    case 'CHAIN_LIMIT':
      return 'Now yours — the 3rd failure in this chain';
    case 'HANDED_OVER':
      return 'Now yours — the coordinator handed it over';
    case 'NO_COORDINATOR':
      return `Now yours — this project has no coordinator (waiting ${formatSpan(waitedMs(row, now))})`;
    default:
      return null;
  }
}

function waitedMs(row: Pick<ProjectOpenItemRow, 'waitingSince'>, now: number): number {
  return now - Date.parse(row.waitingSince);
}

/** How long the coordinator had it before the clock took it away — the window the project set, read
 *  off the two instants rather than off the setting, so a window that was changed afterwards cannot
 *  make this sentence lie about what happened. */
function waitedBeforeEscalation(row: ProjectOpenItemRow): string {
  if (row.escalatedAt == null) return 'a while';
  return formatSpan(Date.parse(row.escalatedAt) - Date.parse(row.waitingSince));
}

/**
 * The time under an item, in the words its group uses (§7.2 V5).
 *
 * The coordinator's items are the ones with two numbers on them, and both matter: how long it has
 * had it, and how long before it stops being its problem. The owner's items have one — except an
 * escalated one, where WHEN it arrived is what the reader is orienting by.
 */
export function waitingLabel(row: ProjectOpenItemRow, now: number): string {
  const waited = formatSpan(waitedMs(row, now));
  if (row.assignee === 'COORDINATOR') {
    if (row.escalateAt == null) return `waiting ${waited}`;
    const left = Date.parse(row.escalateAt) - now;
    return left > 0 ? `${waited} · goes to you in ${formatSpan(left)}` : `${waited} · due to come to you`;
  }
  if (row.escalatedAt != null) return `escalated ${ago(row.escalatedAt, now)}`;
  return `waiting ${waited}`;
}

/** §7.5's footer: who has it, how long, and when it stops being theirs. */
export function ownerLine(row: ProjectOpenItemRow, now: number): string {
  const waited = `waiting ${formatSpan(waitedMs(row, now))}`;
  if (row.assignee === 'OWNER') return `Owner: you · ${waited}`;
  const left = row.escalateAt == null ? null : Date.parse(row.escalateAt) - now;
  return left != null && left > 0
    ? `Owner: coordinator · ${waited} · goes to the owner in ${formatSpan(left)}`
    : `Owner: coordinator · ${waited}`;
}

/** The label each door wears. Only the four with a door behind them are ever drawn (see the module
 *  note): the server lists `RETRY` and `CANCEL_TASK` for a task item, and neither has an entry
 *  point in this client, so pressing one could do nothing but fail. */
const ACTION_LABEL: Partial<Record<OpenItemAction, string>> = {
  REVIEW: 'Review',
  ANSWER: 'Answer',
  RESUME: 'Resume',
  OPEN_COORDINATOR: 'Open coordinator',
  OPEN_TASK_SESSION: 'Open task session',
};

/** Where a press goes, or null when this row does not carry the address it would need. */
function actionHref(row: ProjectOpenItemRow, action: OpenItemAction): string | null {
  switch (action) {
    case 'REVIEW':
      // The merge card, mounted beside this list by both hosts — the same anchor the question's
      // press uses, and for the same reason: one merge, confirmed in one place (§7.5).
      return row.promotionId ? `#promotion-${row.promotionId}` : null;
    case 'ANSWER':
      // The question's own card, already on this page and in the coordinator's conversation. An
      // anchor rather than a second copy of the card: one question, answered in one place.
      return `#question-${row.itemId}`;
    case 'OPEN_COORDINATOR':
      return row.delivery.sessionId
        ? `/sessions/${encodeURIComponent(encodeId(row.delivery.sessionId))}`
        : null;
    case 'OPEN_TASK_SESSION':
      return row.sessionId
        ? `/sessions/${encodeURIComponent(encodeId(row.sessionId))}`
        : row.taskId
          ? `/tasks/${encodeURIComponent(encodeId(row.taskId))}`
          : null;
    default:
      return null;
  }
}

/** The presses this row offers here, in the server's own order and never more than it listed. */
function drawableActions(row: ProjectOpenItemRow): OpenItemAction[] {
  return row.actions.filter(
    (action) => ACTION_LABEL[action] != null && (action === 'RESUME' || actionHref(row, action) != null),
  );
}

function ItemLink({
  row,
  action,
  primary,
}: {
  row: ProjectOpenItemRow;
  action: OpenItemAction;
  /** The press the reader is expected to make. Only the owner's own rows have one: what the
   *  coordinator is handling is offered to be looked at, not to be acted on. */
  primary?: boolean;
}): JSX.Element {
  const href = actionHref(row, action) ?? '#';
  const label = ACTION_LABEL[action] ?? action;
  const className = `project-open-item-action${primary ? ' is-primary' : ''}`;
  // An in-page anchor is an anchor; a route is a Link, so it does not reload the app.
  return href.startsWith('#') ? (
    <a className={className} href={href}>
      {label}
    </a>
  ) : (
    <Link className={className} to={href}>
      {label}
    </Link>
  );
}

/** `POST /projects/:id/fuse/:episodeId/resume` — the owner's alone (§6.3 F-T4). An empty body
 *  resumes without raising anything, which is what the plain press means. */
function resumeFuse(projectId: string, episodeId: string): Promise<unknown> {
  return api(
    `/projects/${encodeURIComponent(projectId)}/fuse/${encodeURIComponent(episodeId)}/resume`,
    { method: 'POST', body: {} },
  );
}

/**
 * The pause card (mock 6 ①): why the coordinator stopped, what it cost, what is still running
 * without it, and the one press that starts it again.
 *
 * Its own component because it is the one card here with a WRITE behind it. Everything the reader
 * needs to weigh the resume is in the server's sentence — the pause writes its own `detailLine`
 * rather than borrowing the failure wording, for exactly that reason (§6.2).
 */
export function FusePauseCard({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element {
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => resumeFuse(projectId, row.fuseEpisodeId!),
    // Resumed or refused, the items are re-read: the card goes when the episode closes, and a
    // second pause — a new episode, never this row again (§6.2) — arrives as its own card.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
  return (
    <ItemCard row={row} heading={row.title} tone="owner" now={now} id={`fuse-${row.itemId}`}>
      <Button
        type="primary"
        size="small"
        loading={resume.isPending}
        disabled={row.fuseEpisodeId == null}
        onClick={() => resume.mutate()}
      >
        Resume
      </Button>
      {resume.isError ? (
        <Alert
          type="error"
          showIcon
          className="project-open-item-error"
          message="The coordinator was not resumed"
          description={(resume.error as Error).message}
        />
      ) : null}
    </ItemCard>
  );
}

/**
 * An exception the coordinator is handling: a conflict, a failed combined-tree check, an
 * integration error, or a task that failed (mock 5, left column).
 *
 * One component for four kinds, because the card is the same card: what happened, who has it, how
 * long they have had it, and when it stops being theirs. What differs between the four is the
 * server's title and its one sentence, and those arrive already written.
 */
export function OpenItemCard({
  row,
  now,
}: {
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element {
  return (
    <ItemCard row={row} heading={row.title} tone="coordinator" now={now}>
      {drawableActions(row).map((action) => (
        <ItemLink key={action} row={row} action={action} />
      ))}
    </ItemCard>
  );
}

/**
 * The same exception once it is the owner's (mock 5, right column): the heading says how it got
 * here, because that is the fact the reader is missing — an item that arrived by a clock, by a
 * conversation ending, by a chain running out or by a hand-over each ask for something different.
 */
export function EscalatedItemCard({
  row,
  now,
}: {
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element {
  const heading = escalationHeading(row, now) ?? row.title;
  return (
    <ItemCard
      row={row}
      heading={heading}
      tone="owner"
      now={now}
      // What escalated, above the sentence about it — the heading says how it got here, and this
      // says what "it" is, which the heading no longer has room for.
      subject={row.title}
    >
      {drawableActions(row).map((action) => (
        <ItemLink key={action} row={row} action={action} />
      ))}
    </ItemCard>
  );
}

/** The chrome all three share: the head with its provenance mark, the server's sentence, the
 *  actions, and the footer that says who owes an answer and by when. */
function ItemCard({
  row,
  heading,
  tone,
  now,
  id,
  subject,
  children,
}: {
  row: ProjectOpenItemRow;
  heading: string;
  /** Amber for what the owner has to act on, neutral for what the coordinator is handling — the
   *  same two colours the project page's two groups use, so a card and its row agree at a glance. */
  tone: 'owner' | 'coordinator';
  now: number;
  id?: string;
  /** The item's own title, for a card whose heading is something else. */
  subject?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`approval-card project-open-item-card is-${tone}`}
      id={id ?? `open-item-${row.itemId}`}
      data-kind={row.kind}
    >
      <div className="approval-head project-open-item-head">
        <span className="project-open-item-heading">{heading}</span>
        <span
          className={`criteria-provenance${tone === 'coordinator' ? ' prov-neutral' : ''}`}
          title={FROM_ORBIT_TITLE}
        >
          {FROM_ORBIT}
        </span>
      </div>
      <div className="approval-body is-plan project-open-item-body">
        {subject ? <p className="project-open-item-subject">{subject}</p> : null}
        {row.detailLine ? <p className="project-open-item-detail">{row.detailLine}</p> : null}
        <div className="project-open-item-actions">{children}</div>
      </div>
      <div className="project-open-item-foot">{ownerLine(row, now)}</div>
    </div>
  );
}

/** Which card an item is drawn as. The pause is its own because it writes; an item that became the
 *  owner's is its own because its heading is the story of how; everything else is the plain one. */
function ItemAsCard({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  now: number;
}): JSX.Element | null {
  if (row.kind === 'FUSE_PAUSED') {
    return <FusePauseCard projectId={projectId} row={row} now={now} />;
  }
  // A question has its own card, mounted beside this one by both hosts — drawing it again here
  // would be two cards answering one question, and only one of them could win. A merge approval is
  // the same: `ProjectPromotionCard` draws it from the candidate itself, which is where what would
  // land and what the checks came to actually live.
  if (row.kind === 'COORDINATOR_QUESTION' || row.kind === 'PROMOTION_APPROVAL') return null;
  return escalationHeading(row, now) != null ? (
    <EscalatedItemCard row={row} now={now} />
  ) : (
    <OpenItemCard row={row} now={now} />
  );
}

/**
 * Every open exception of this project, as cards, wherever a transcript wants them: the project's
 * coordinator conversation draws these under its own turns, and the project page expands the same
 * components (§7.5).
 *
 * Reads nothing without a project — an ordinary session coordinates none — and draws nothing while
 * nothing is open, so neither host has to know whether there is anything to show.
 */
export function ProjectExceptionCards({
  projectId,
  now = Date.now(),
}: {
  projectId: string | null | undefined;
  now?: number;
}): JSX.Element | null {
  const items = useQuery({
    ...projectOpenItemsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const rows = ordered(items.data);
  if (!projectId || rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <ItemAsCard key={row.itemId} projectId={projectId} row={row} now={now} />
      ))}
    </>
  );
}

/**
 * The pause first, then everything else oldest first (§7.2 V5, mock 6 ①).
 *
 * The pause is pinned because it is the only item that is ABOUT the coordinator rather than about
 * a piece of work: while it holds, every other item on this list is waiting on a conversation that
 * has stopped, and a reader who resolved them one by one without seeing it would be working around
 * the thing that stopped the project.
 */
function ordered(items: ProjectOpenItemsView | undefined): ProjectOpenItemRow[] {
  const all = [...(items?.needsYou ?? []), ...(items?.withCoordinator ?? [])];
  const paused = all.filter((row) => row.kind === 'FUSE_PAUSED');
  const rest = all
    .filter((row) => row.kind !== 'FUSE_PAUSED')
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
  return [...paused, ...rest];
}

function OpenItemRowView({ row, now }: { row: ProjectOpenItemRow; now: number }): JSX.Element {
  const actions = drawableActions(row);
  return (
    <li className={`project-open-item-row is-${row.assignee === 'OWNER' ? 'owner' : 'coordinator'}`}>
      <span className="project-open-item-dot" aria-hidden="true" />
      <div className="project-open-item-main">
        <div className="project-open-item-title" title={row.title}>
          {row.title}
        </div>
        {row.detailLine ? (
          <div className="project-open-item-line" title={row.detailLine}>
            {row.detailLine}
          </div>
        ) : null}
      </div>
      <div className="project-open-item-who">
        <span>{WHO[row.assignee]}</span>
        <time className="project-open-item-age" dateTime={row.waitingSince}>
          {waitingLabel(row, now)}
        </time>
      </div>
      <div className="project-open-item-press">
        {/* The first door the server listed is the primary one; the rest are reachable from the
            card this row expands to. A row with none says so by drawing none. */}
        {actions[0] ? (
          <ItemLink row={row} action={actions[0]} primary={row.assignee === 'OWNER'} />
        ) : null}
      </div>
    </li>
  );
}

/**
 * The project page's Open items card (mock 2 ②): what is waiting, in the two groups that say who is
 * expected to act, oldest first in both.
 *
 * The two groups are the whole point of the card. "Three things need you and two are being handled"
 * is a different project from "five things are stuck", and before this the page could not tell the
 * reader which one they were looking at.
 */
export function ProjectOpenItems({
  projectId,
  now = Date.now(),
}: {
  projectId: string | null | undefined;
  now?: number;
}): JSX.Element | null {
  const items = useQuery({
    ...projectOpenItemsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // The pause is drawn as a card above the groups and counted in neither: it is not something
  // waiting on a person the way the rows are, it is the reason some of them are waiting.
  const paused = (items.data?.needsYou ?? []).filter((row) => row.kind === 'FUSE_PAUSED');
  const needsYou = (items.data?.needsYou ?? []).filter((row) => row.kind !== 'FUSE_PAUSED');
  const withCoordinator = items.data?.withCoordinator ?? [];
  if (!projectId || paused.length + needsYou.length + withCoordinator.length === 0) return null;

  return (
    <section className="project-open-items" aria-label={OPEN_ITEMS_HEADING}>
      <header className="project-open-items-head">
        <span className="project-open-items-title">{OPEN_ITEMS_HEADING}</span>
        <span className="project-open-items-hint">
          {`${needsYou.length} need you · ${withCoordinator.length} with the coordinator · oldest first`}
        </span>
      </header>
      {paused.map((row) => (
        <FusePauseCard key={row.itemId} projectId={projectId} row={row} now={now} />
      ))}
      {needsYou.length > 0 ? (
        <>
          <div className="project-open-items-group">{NEEDS_YOU_GROUP}</div>
          <ul className="project-open-items-list">
            {needsYou.map((row) => (
              <OpenItemRowView key={row.itemId} row={row} now={now} />
            ))}
          </ul>
        </>
      ) : null}
      {withCoordinator.length > 0 ? (
        <>
          <div className="project-open-items-group">{WITH_COORDINATOR_GROUP}</div>
          <ul className="project-open-items-list">
            {withCoordinator.map((row) => (
              <OpenItemRowView key={row.itemId} row={row} now={now} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** §7.2 V7's four states for the last thing the platform sent the coordinator. `RETURNED` is the
 *  one drawn in amber: it is the only one of the four where a delivery did NOT happen. */
const WAKEUP_WORD: Record<CoordinatorWakeups['state'], string> = {
  DELIVERED: 'delivered',
  QUEUED: 'queued',
  RETURNED: 'returned',
  NONE: 'none yet',
};

/**
 * The two rows the coordinator card gained (§7.2 V7, mock 2 ③): whether the platform's last word
 * reached this conversation, and how much of today's own initiative it has left.
 *
 * Presentational, like the card that hosts it — it is handed the payload's own two objects and
 * reports nothing back. Kept here rather than in `ProjectCoordinatorCard` because both facts belong
 * to this contract and move with it, and because the card is already the longest file on the page.
 */
export function CoordinatorProgressRows({
  wakeups,
  fuse,
  now = Date.now(),
}: {
  wakeups: CoordinatorWakeups;
  fuse: CoordinatorFuseUsage;
  now?: number;
}): JSX.Element {
  const word = WAKEUP_WORD[wakeups.state] ?? wakeups.state;
  const when = wakeups.at == null
    ? null
    : wakeups.state === 'DELIVERED'
      ? `last ${ago(wakeups.at, now)}`
      : ago(wakeups.at, now);
  // Bounded at the limit: a coordinator 31 turns into a 30 limit has a full bar, not one and a
  // tenth, and the numbers beside it are what say by how much it went over.
  const filled = fuse.limit != null && fuse.limit > 0
    ? Math.min(100, Math.round((fuse.selfStartedToday / fuse.limit) * 100))
    : null;
  return (
    <>
      <div className="project-coordinator-progress" aria-label="Wake-ups">
        <span className="project-coordinator-progress-label">Wake-ups</span>
        <span className="project-coordinator-progress-value">
          <span className={wakeups.state === 'RETURNED' ? 'is-returned' : 'is-carried'}>{word}</span>
          {when ? ` · ${when}` : null}
        </span>
      </div>
      <div className="project-coordinator-progress is-stacked" aria-label="Self-started today">
        <div className="project-coordinator-progress-line">
          <span className="project-coordinator-progress-label">Self-started today</span>
          <span className="project-coordinator-progress-value">
            {fuse.limit == null
              ? `${fuse.selfStartedToday} · no limit`
              : `${fuse.selfStartedToday} of ${fuse.limit}`}
            {fuse.paused ? <span className="is-paused">{' · paused'}</span> : null}
          </span>
        </div>
        {filled !== null ? (
          <div className="project-coordinator-meter">
            <i className={fuse.paused ? 'is-paused' : undefined} style={{ width: `${filled}%` }} />
          </div>
        ) : null}
      </div>
    </>
  );
}
