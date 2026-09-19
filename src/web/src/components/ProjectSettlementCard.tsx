import { useEffect, useId, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { api } from '../api';
import { CardActionButton, CardActions } from './CardAction';
import { PROVENANCE_LABEL, PROVENANCE_TITLE } from './CriteriaDecisionCard';
// The words this card's second action uses, and for the reason `AcceptanceConfirmationCard` gives
// at its own import of them: read inside the component rather than bound at module scope, so
// whichever of these modules a bundle enters first, no alias is evaluated in another's temporal
// dead zone.
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

/**
 * The settlement question at the other end of the one `AcceptanceConfirmationCard` asks: the work
 * filed under this project has met every criterion it states, no task under it is IN_PROGRESS, and
 * the project is still OPEN — so is this project done?
 *
 * NOTHING HERE STATES A FACT THIS READ DOES NOT CARRY. The card and the reply it arms were both
 * written against a "nothing is running" clause the project document cannot back; see
 * `settlementMeta` and `tasksByStatus` for what replaced it and why.
 *
 * WHY IT IS A CARD IN THE COORDINATOR CONVERSATION
 * ------------------------------------------------
 * `project.status` is the account owner's write and no session's: `refuseProjectStatusWrite`
 * (`apiserver/src/projects/coordinator-authority.ts`) answers `PROJECT_STATUS_NOT_SESSION_WRITABLE`
 * to any request carrying an acting session, and lets through exactly one shape — the browser's own
 * credential with no session named. The owner is often IN this conversation at the moment the last
 * criterion settles, and until now the conversation's last sentence could only say the decision was
 * theirs to make somewhere else. This card is that somewhere else: it presses the same idempotent
 * `PATCH /projects/:id` the project page's "Record as done" presses, from the browser, with no agent
 * between the press and the door. That the project page keeps its own entry is deliberate — the two
 * are the same write, not a first-press-wins race.
 *
 * WHAT IS NOT ON THE PRIMARY ACTION
 * ---------------------------------
 * A criterion with no merge receipt does not disable anything. "No receipt" says Orbit holds no
 * proof that the work landed, which is not a finding that it did not — the count is something the
 * reader has to be told, not something that takes the decision off them, exactly as the project
 * page's dialog has it. For the same reason there is no verdict anywhere on this card: migration
 * 0229 deleted the project acceptance judgment, so nothing here may read as a conclusion Orbit
 * reached.
 *
 * DELIVERED ONCE, RE-DERIVED ON EVERY RENDER
 * ------------------------------------------
 * The card appears on the first render the condition holds and stays for as long as this
 * conversation is on screen, the way a native delivered card does: recorded done at another end, it
 * goes stale IN PLACE, with both actions disabled and the reason above them, rather than vanishing
 * mid-read. Nothing about the project is kept across renders — it is read again each time.
 *
 * WHY THE CRITERIA ARE FOLDED AND THE OTHER CARD'S ARE NOT
 * -------------------------------------------------------
 * The start card unfolds its whole set because a person is agreeing to THESE conditions, and a
 * folded list is an invitation to sign what was never opened. Here the set has already been met and
 * what the reader is checking is the fact column beside each line, so three rows make the point and
 * the rest are one press away.
 */

/** The card's heading: what the card is about, not whether it has been answered. */
export const SETTLEMENT_HEADING = 'Is this project done?';
/** The primary action. One press records the owner's claim about the goal at the project door. */
export const SETTLEMENT_CONFIRM_ACTION = 'Confirm the project is done';
/** The secondary action's own explanation, under the row it sits in. */
export const SETTLEMENT_CHAT_HINT =
  '“Chat about this” hands the card’s own facts to the composer below, so you can say what is '
  + 'still missing instead of confirming.';
/** The one paragraph the card keeps: what a press claims, and what it does not do. */
export const SETTLEMENT_EXPLAINS =
  'Nothing decides this for you. Confirming it is a claim you are making about the goal, not a '
  + 'conclusion Orbit reached — so here is everything Orbit can put beside it. Confirming the '
  + 'project done neither closes nor stops the work still filed under it.';
/** Already recorded at another end: the card stays rather than disappearing mid-read, and says
 *  that nothing here was pressed. */
export const SETTLEMENT_STALE =
  'This project was recorded as done at another end. Nothing here was pressed.';
/** What a press made here leaves where its actions were. */
export const SETTLEMENT_CONFIRMED = 'Confirmed done · by you, from this conversation.';
export const SETTLEMENT_CONFIRMED_NOTE =
  'The project is recorded DONE; the work filed under it is untouched.';
/** The reading toggle once the rest of the set is shown. */
export const SETTLEMENT_SHOW_LESS = 'Show less';
/** What a press the door did not take says, over the door's own message. */
export const SETTLEMENT_NOT_RECORDED = 'The project was not recorded as done';
/** What the composer's bar says it is about to talk about, ahead of the project's own title, and
 *  what the armed composer asks for. A message, not an answer: no door is waiting on it. */
export const SETTLEMENT_CHAT_PREFIX = 'Talking about this project: ';
export const SETTLEMENT_CHAT_PLACEHOLDER = 'What is still missing?';
/** How many criterion rows are on the card before the rest are folded away. */
export const SETTLEMENT_PREVIEW = 3;

/** One stated criterion, plus the two facts the project read offers about the work filed under it.
 *  `satisfied` is ABSENT for a criterion the derivation did not answer for — an omission rather
 *  than a `false`, because "nobody answered" and "the clauses do not hold" are different states, and
 *  only `true` counts as met. `landing` has no third value: `UNKNOWN` means no merge receipt proves
 *  the work reached the default branch, which is the absence of evidence and never a finding that
 *  the work is absent (`project-criterion-landing` omits `NOT_LANDED` from its type on purpose). */
export interface SettlementCriterion {
  id: string;
  ordinal: number;
  text: string;
  satisfied?: boolean;
  landing: 'LANDED' | 'UNKNOWN';
}

/** As much of the project document as this card reads: what the meta line names it by, the status
 *  the condition turns on, the stated criteria with their two facts, and the task tally. */
export interface SettlementProjectDocument {
  title: string;
  /** Absent from a read that did not say where the project stands, which is not an OPEN one. */
  status?: string;
  acceptanceCriteriaItems?: SettlementCriterion[];
  /** Statuses with no tasks are absent from the server's tally entirely, so an empty object means
   *  "no tasks" rather than "counts unavailable" — which is why the sentence below is dropped from
   *  a document that carried no tally at all, and not from one whose tally is empty.
   *
   *  `IN_PROGRESS` here is also the only running count this read can honestly offer. The project
   *  document carries no `buckets`: those are produced by the list rollup and the panorama read
   *  (`project-list-rollup.ts`, `project-panorama.ts`), and `GET /projects/:id` attaches neither —
   *  its own `buckets.running` would be `undefined` on every render, which reads as "nothing is
   *  running" and would put this card up over live work. */
  tasksByStatus?: Record<string, number>;
}

/** The reading toggle's label. It carries the count because the count is what the reader is
 *  deciding about: this many stated conditions, all of them met. */
export function settlementReadLabel(count: number): string {
  return `Show all ${count} criteria`;
}

/** Whether this project is waiting for the owner's own answer, read off the project document:
 *  OPEN, criteria stated, every one of them met by the work filed under it, and no task
 *  IN_PROGRESS.
 *
 *  The middle condition is deliberately strict: a project with a criterion nobody has answered for
 *  is asked nothing here and goes to the project page instead. `satisfied` must be `true` — the
 *  field being absent is "nobody answered", which is not a yes. */
export function settlementHeldOnProject(
  project: SettlementProjectDocument | null | undefined,
): boolean {
  if (!project || project.status !== 'OPEN') return false;
  const criteria = project.acceptanceCriteriaItems ?? [];
  if (criteria.length === 0) return false;
  if (!criteria.every((criterion) => criterion.satisfied === true)) return false;
  // The status, not the work state: `buckets.running` also counts an OPEN task with live work,
  // and it is not in this read. This is the count the document carries, and it is the one the
  // card may state.
  return (project.tasksByStatus?.IN_PROGRESS ?? 0) === 0;
}

/** Which project, and the one fact that puts the question: every stated criterion has been met by
 *  the work filed under it.
 *
 *  It carried a third clause, "nothing is running under it", until 2026-09-19. The document this
 *  line is built from cannot back it — see `tasksByStatus` above — and a card that says nothing is
 *  running while a task runs under it is worse than one that says less. What is still open under
 *  the project is the tally's line, counted off the same document, in its own sentence. */
export function settlementMeta(project: SettlementProjectDocument): string {
  return `${project.title} · every stated criterion has been met by the work filed under it`;
}

/** What the server can say about ONE criterion, in the order the two facts have to be read: what
 *  settled, then whether anything proves it landed. The landing half is never phrased as a finding
 *  about the work — there is no receipt, and that is all it says. */
export function settlementCriterionFacts(criterion: SettlementCriterion): string {
  const settlement =
    criterion.satisfied === true
      ? 'Settled'
      : criterion.satisfied === false
        ? 'Not settled'
        : 'No settlement answer';
  const landing = criterion.landing === 'LANDED' ? 'Landed' : 'No receipt';
  return `${settlement} · ${landing}`;
}

/** The two task statuses that END a task — FAILED is deliberately not one of them, since it is a
 *  run's own report that it stopped short and the work under it is still outstanding. */
const SETTLED_TASK_STATUSES: ReadonlyArray<string> = ['DONE', 'CANCELLED'];

/** How much work is still outstanding under the project, from the tally the document carries. */
function unfinishedTasks(byStatus: Record<string, number>): number {
  return Object.entries(byStatus)
    .filter(([status]) => !SETTLED_TASK_STATUSES.includes(status))
    .reduce((total, [, count]) => total + count, 0);
}

/**
 * The tally under the criteria: the set in numbers, then what is still open under it when there is
 * anything to say. The second sentence is dropped whole when both of its counts are zero and when
 * the document carried no tally — a line reading "0 tasks still unsettled, 0 ended FAILED" is a
 * claim of its own and not a way of saying nothing.
 */
export function settlementTally(project: SettlementProjectDocument): string {
  const criteria = project.acceptanceCriteriaItems ?? [];
  const settled = criteria.filter((criterion) => criterion.satisfied === true).length;
  const noReceipt = criteria.filter((criterion) => criterion.landing === 'UNKNOWN').length;
  const line =
    `${criteria.length} stated criteria · ${settled} settled by the work filed under them · `
    + `${noReceipt} with no merge receipt`;
  if (!project.tasksByStatus) return line;
  const unsettled = unfinishedTasks(project.tasksByStatus);
  const failed = project.tasksByStatus.FAILED ?? 0;
  if (unsettled === 0 && failed === 0) return line;
  return `${line} · ${unsettled} task still unsettled, ${failed} ended FAILED`;
}

/**
 * What the next send carries ahead of the typed message: the card's own facts, as the reader is
 * looking at them.
 *
 * The other three armed replies answer a call that is blocking on them, so their door already knows
 * what the reply is about. This one starts an ordinary turn at an idle agent, which knows none of
 * it — so the criteria with the two facts beside each and the tally ride with the message rather
 * than being looked up.
 */
export function projectSettlementContext(project: SettlementProjectDocument): string {
  const criteria = [...(project.acceptanceCriteriaItems ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const numbered = criteria
    .map((criterion) => `${criterion.ordinal}. ${criterion.text} — ${settlementCriterionFacts(criterion)}`)
    .join('\n');
  return (
    `About “${project.title}” — every one of its ${criteria.length} stated criteria has been met by `
    + `the work filed under it:\n\n${numbered}\n\n`
    + settlementTally(project)
  );
}

/**
 * Records the owner's claim at the project door. `PATCH /projects/:id` through the ordinary API
 * helper, which carries the browser's bearer token and nothing that names a session: that is the one
 * shape `refuseProjectStatusWrite` lets through, and the reason this card exists in a conversation
 * rather than as an agent tool.
 */
export function recordProjectDone(projectId: string): Promise<{ id: string }> {
  return api<{ id: string }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: { status: 'DONE' },
  });
}

/**
 * The card. Presentational apart from which criterion rows are folded: it issues no request, so a
 * render can assert what each state puts on screen.
 *
 * Two actions and a reading toggle, and the toggle is neither of them — it writes nothing and is
 * never disabled. The primary is disabled only while a press is in flight, or once the project has
 * been recorded at another end: never because the evidence beside it is incomplete.
 */
export function ProjectSettlementCard({
  project,
  confirmed = false,
  busy = false,
  error = null,
  onConfirm,
  onChatAbout,
}: {
  /** The project as the read returned it. */
  project: SettlementProjectDocument;
  /** A press made HERE has been recorded. The receipt replaces the actions. */
  confirmed?: boolean;
  /** A press from this card is on its way to the door, or the re-read after a refusal is. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  onConfirm: () => void;
  /** Hands the card's own facts to the bottom composer. The card stays and `onConfirm` stays
   *  live. */
  onChatAbout: () => void;
}): JSX.Element {
  const listId = useId();
  const [allShown, setAllShown] = useState(false);
  const criteria = [...(project.acceptanceCriteriaItems ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  // A press made here is not one made "at another end", which is the one reading of its own answer
  // this card can be sure is wrong.
  const stale = !confirmed && project.status !== 'OPEN';
  const rows = allShown ? criteria : criteria.slice(0, SETTLEMENT_PREVIEW);
  return (
    <div className="approval-card project-settlement">
      <div className="approval-head project-settlement-head">
        <span className="project-settlement-heading">{SETTLEMENT_HEADING}</span>
        <span className="criteria-provenance" title={PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions project-settlement-body">
        <div className="project-settlement-meta">{settlementMeta(project)}</div>
        {stale ? <p className="project-settlement-stale">{SETTLEMENT_STALE}</p> : null}
        {/* Three rows by default and the facts beside each: what the reader is checking is the fact
            column, not a definition they wrote themselves, so the rest are one press away. */}
        {criteria.length > 0 ? (
          <>
            <ol id={listId} className="project-settlement-criteria">
              {rows.map((criterion) => (
                <li key={criterion.id}>
                  <span className="project-settlement-no">{criterion.ordinal}</span>
                  <span className="project-settlement-text" title={criterion.text}>
                    {criterion.text}
                  </span>
                  <span className="project-settlement-facts">
                    {settlementCriterionFacts(criterion)}
                  </span>
                </li>
              ))}
            </ol>
            {criteria.length > SETTLEMENT_PREVIEW ? (
              <button
                type="button"
                className="project-settlement-read"
                aria-expanded={allShown}
                aria-controls={listId}
                onClick={() => setAllShown((shown) => !shown)}
              >
                {allShown ? SETTLEMENT_SHOW_LESS : settlementReadLabel(criteria.length)}
              </button>
            ) : null}
            <div className="project-settlement-tally">{settlementTally(project)}</div>
          </>
        ) : null}
        <p className="project-settlement-explains">{SETTLEMENT_EXPLAINS}</p>
        {error ? (
          <Alert
            className="project-settlement-error"
            type="error"
            showIcon
            message={SETTLEMENT_NOT_RECORDED}
            description={error.message}
          />
        ) : null}
        {confirmed ? (
          <div className="project-settlement-recorded">
            <div>{SETTLEMENT_CONFIRMED}</div>
            <div className="project-settlement-recorded-note">{SETTLEMENT_CONFIRMED_NOTE}</div>
          </div>
        ) : null}
      </div>
      {confirmed ? null : (
        <>
          <CardActions className="approval-actions project-settlement-actions">
            <CardActionButton tone="primary" disabled={busy || stale} onClick={onConfirm}>
              {SETTLEMENT_CONFIRM_ACTION}
            </CardActionButton>
            <CardActionButton tone="secondary" disabled={stale} onClick={onChatAbout}>
              {OWNER_SEND_BACK_ACTION}
            </CardActionButton>
          </CardActions>
          <p className="project-settlement-hint">{SETTLEMENT_CHAT_HINT}</p>
        </>
      )}
    </div>
  );
}

/**
 * The wired card for one conversation: at most one, delivered the first time a project is held on
 * this card's condition and re-derived from the project read on every render after that.
 *
 * The project is read under the project page's own `['project', id]`, so the card, the status tag
 * and the list entries all move on one invalidation. A press is made with the browser's credential
 * and no session header, and the write is followed by the two invalidations the project page's own
 * press makes — the card then re-derives, and `delivered` keeps it on screen as its receipt.
 *
 * Nothing puts the card down. A project that was recorded DONE somewhere else while this card was
 * open goes stale in place; the way past this one is to confirm it or to say what is still missing.
 */
export function SessionProjectSettlementCard({
  projectId,
  onChatAbout,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  /** Arms the bottom composer to talk about this card, given what the next send should carry as
   *  context. Nothing here is a door, and the card stays put. */
  onChatAbout?: (talk: { projectId: string; projectTitle: string; facts: string }) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = projectId ?? '';
  const [delivered, setDelivered] = useState(false);
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () => api<SettlementProjectDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // This card reads one document where its sibling reads two, so a read that has not answered yet
  // is not an answer: there is nothing to draw the card from, and nothing is drawn.
  const document = documentRead.data ?? null;
  const held = settlementHeldOnProject(document);
  useEffect(() => {
    if (held) setDelivered(true);
  }, [held]);
  // Delivered once and re-derived after: the card a reader has already seen stays where it was put,
  // including the case where the project was settled at another end while they were reading it.
  const shown = delivered || held;
  const confirm = useMutation({
    mutationFn: () => recordProjectDone(project),
    // The same two invalidations the project page's own press makes: every card on this key redraws
    // from the re-read, and the list entries follow a project that just became DONE into another
    // section.
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', project] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  if (!shown || document === null) return null;
  return (
    <ProjectSettlementCard
      project={document}
      confirmed={confirm.isSuccess}
      busy={confirm.isPending}
      error={confirm.isError ? confirm.error : null}
      onConfirm={() => {
        if (confirm.isPending || confirm.isSuccess) return;
        confirm.mutate();
      }}
      onChatAbout={() =>
        onChatAbout?.({
          projectId: project,
          projectTitle: document.title,
          facts: projectSettlementContext(document),
        })
      }
    />
  );
}
