import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Input, Typography } from 'antd';
import { CardActionButton, CardActions } from './CardAction';
import { api } from '../api';
import { pendingDecisionsQuery } from '../lib/queries';
import { useMediaQuery } from '../lib/useMediaQuery';

/**
 * What is TRUE right now about this session's open questions, pinned under the header.
 *
 * STATE IS PINNED; EVENTS STAY IN THE LOG
 * ---------------------------------------
 * The transcript is a record of what happened. This is not that: it is recomputed from the ledger
 * on every read, and a row leaves it because a decision now exists, not because a frame arrived.
 * Putting it in the vertical flow of the transcript put a thing that changes every turn between
 * two things that never change again, with no boundary of its own — it read as a message nobody
 * sent. So the two kinds of content are separated by kind: what is true now is pinned here and
 * does not scroll, and what HAPPENED — a decision, once made — is a line in the log where it
 * happened (`DecisionLog`, rendered inside the transcript scroller).
 *
 * ONE LINE UNTIL ASKED
 * --------------------
 * Collapsed is two numbers and nothing else. This blocks no turn, so it must not look like the
 * approval card, which does; expanding is a deliberate act. The same judgment the iOS Needs-you
 * banner was settled on: one signal and one way through to the thing, never a cascade of badges
 * saying the same fact in four places.
 *
 * NOTHING IS SHOWN TO SOMEBODY WHO CANNOT ACT ON IT
 * ------------------------------------------------
 * `NEEDS YOUR DECISION` lists rows THIS session may answer and nothing else. The server already
 * scopes its read that way; the filter here is the second half of the same rule rather than a
 * second opinion about it — it reads `independence.independent`, which is the decision door's own
 * answer carried on the row, and it is what keeps the count and the list from ever disagreeing.
 * A row a reader may not answer under a heading that says DECIDE is the same broken promise this
 * card was fixed for once already.
 *
 * TWO GROUPS, BECAUSE THE DOOR HAS TWO ANSWERS
 * --------------------------------------------
 * A card that says DECISION REQUIRED and whose primary action is refused every time it is pressed
 * is worse than no card: it teaches the reader that the screen does not know what the server will
 * do. That is what this rail was doing to evidence quoting no live stated criterion — the queue
 * listed it and the decision door refused it, both correctly and neither knowing about the other.
 * The server hands those rows over separately and only to the run that can clear them:
 * `waitingOnYou`, where this session filed the submission, so the sentence about what the next
 * revision must quote is an instruction to the reader rather than news about somebody else. No
 * other session is sent them at all. A greyed group repeating the same stall on every open window
 * was the same broadcast one heading further down — being able to see a stall is not the same as
 * being told one, and the stalled population belongs in the report that exists for it.
 *
 * ONE ROW AT A TIME, AND NO BULK ANYTHING
 * ---------------------------------------
 * There is deliberately no select-all, no checkbox, and no button that answers more than the card
 * it is inside. Judging N submissions means reading N of them: a cheap "confirm all" is precisely
 * how a judgment face decays into a rubber stamp, and the value of this criterion is entirely in
 * somebody having read the evidence. `DecisionRail.test.tsx` asserts the absence, because absence
 * is the kind of property that comes back the first time somebody is in a hurry.
 *
 * NOTHING IS DELIVERED HERE
 * -------------------------
 * The rows come from `GET /tasks/evidence-decisions/pending`, which re-derives them from the
 * ledger on every read. That is why this can be a plain query with no local list to reconcile: a
 * question answered in another window is gone from the next read, rather than lingering as a card
 * whose answer arrived on a live-only frame this tab never heard.
 *
 * THE OWNER PRESSES THE SAME BUTTON
 * ---------------------------------
 * There is no separate owner path. The two buttons post to the one decision door, naming the
 * session this strip is being read in, and that session is put through the same independence check
 * whoever is signed in.
 *
 * NOT `Mark complete`. Nothing here writes a status: a decision is a fact about one version of the
 * evidence, and DONE is derived from it.
 */

export interface PendingDecisionCitation {
  kind: string;
  ref: string;
  resolved: boolean;
  reason: string | null;
}

export interface PendingDecisionIndependence {
  independent: boolean;
  disqualification: string | null;
  requiredAction: string | null;
}

/** Whether the decision door would record ANY answer about this row — independent of who asks. */
export interface PendingDecisionDecidability {
  decidable: boolean;
  refusal: string | null;
  requiredAction: string | null;
}

export interface PendingDecisionRow {
  taskId: string;
  title: string;
  criterion: { key: string; text: string } | null;
  evidenceRevision: string;
  ageSeconds: number;
  claim: string;
  gaps: string[];
  citations: PendingDecisionCitation[];
  decidability: PendingDecisionDecidability;
  independence: PendingDecisionIndependence;
}

export interface PendingDecisionQueue {
  decidingSessionId: string;
  /** How many rows this session is asked to decide — `pending` only, never the groups summed.
   *  On the wire, and not what the strip renders: every number on screen is read off the list it
   *  sits above, so the two can never come apart. */
  count: number;
  oldestAgeSeconds: number | null;
  pending: PendingDecisionRow[];
  /** Rows waiting on a revision THIS session is the one to file. */
  waitingOnYou?: PendingDecisionRow[];
}

/** The strip's own name, for the reader of a screen reader and for a test asking "is it there". */
export const STRIP_LABEL = 'Open questions';
/** The group that asks something of this reader. Nothing else goes under it. */
export const NEEDS_DECISION_LABEL = 'NEEDS YOUR DECISION';
/** The group this reader is the one to clear, by submitting another revision. */
export const WAITING_ON_YOU_LABEL = 'WAITING ON YOU';
/** The card's heading. A question, stated as one. */
export const DECISION_HEADING = 'DECISION REQUIRED';
/** And the heading for a row no decision can be recorded about. It is a demand rather than a
 *  bulletin because the only reader who is sent one is the reader who can clear it. */
export const WAITING_ON_YOU_HEADING = 'WAITING ON YOUR NEXT REVISION';
export const CONFIRM_LABEL = 'Confirm completion';
export const SEND_BACK_LABEL = 'Send back';

/** The two numbers the collapsed line is made of, and the only two it may carry. */
export function needsDecisionCount(rows: number): string {
  return `${rows} needs your decision`;
}
export function waitingOnYouCount(rows: number): string {
  return `${rows} waiting on you`;
}

/**
 * What has to happen before this row becomes answerable, addressed to the party who can do it.
 *
 * There is one such party and this card is only ever shown to it: nothing the reader can press
 * changes the row, because the decision door checks the criterion before it looks at which
 * decision was asked for, so a send-back is refused here exactly as a confirmation is. Saying
 * "send it back" would be a fourth version of the bug this card was fixed for.
 */
export const WAITING_ON_YOU_ACTION =
  'This is your own submission, and you are the one who can clear it: submit another evidence '
  + 'revision quoting the project criterion this work serves. Until you do, no decision can be '
  + 'recorded here — not by this session and not by any other.';

/**
 * What a decision leaves behind, as a sentence in the log rather than a row that stopped existing.
 *
 * A decision is an EVENT: it happened once, at a moment, and it is still true afterwards that it
 * happened. So it does not belong in the pinned area, which says what is true NOW and is recomputed
 * every read — it belongs where the rest of the session's history is. Naming the task, the standard
 * and the exact version answered is what makes it readable a week later: `bound to rev N` is the
 * whole of the compare-and-set the door performed, in the words the door uses.
 */
export function completionConfirmedLine(
  title: string,
  criterionKey: string | null,
  revision: string,
): string {
  return `Completion confirmed — ${title} against ${criterionKey ?? 'no stated criterion'}, `
    + `bound to rev ${revision}`;
}

/** The other answer, said the same way: nothing was settled, and this version was the one answered. */
export function sentBackLine(title: string, revision: string): string {
  return `Sent back — ${title}, bound to rev ${revision}`;
}

/**
 * The decisions made in this session, in the transcript, in place.
 *
 * Rendered INSIDE the scroller, under the conversation, because that is what "an event" means
 * here: it stays where it happened and scrolls with everything else that happened. The pinned
 * strip above never shows it — a settled question is not a pending one, and a pinned area that
 * accumulated past answers would be a log that refuses to scroll.
 */
export function DecisionLog({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    // One live region for the lot, on the container: each answer announces itself as it lands
    // without turning every past one into a region of its own.
    <div className="decision-log" role="status">
      {/* Keyed by position because the list is append-only — nothing is inserted, removed or
          reordered, and two decisions can carry the same sentence only if the same version of the
          same task was answered twice, which the door refuses. */}
      {lines.map((line, index) => (
        <div className="decision-log-line" key={index}>
          {line}
        </div>
      ))}
    </div>
  );
}

/** When the revision arrived, as a reader reads it: the age, said as a moment. The card's second
 *  line used to end at the dash, because the only thing after it was a claim legacy evidence does
 *  not have; a row is entitled to say WHEN it was submitted whether or not it says what it claims. */
export function formatSubmitted(ageSeconds: number): string {
  return ageSeconds < 60 ? 'submitted just now' : `submitted ${formatAge(ageSeconds)} ago`;
}

/** Age as a reader reads it. Whole units only: a queue is not a stopwatch. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/**
 * One card's contents.
 *
 * `narrow` is the only thing that changes shape, and what it may fold is fixed: the CITATION list
 * collapses to a tally, and the declared gaps never do. Gaps are the field most likely to change
 * the answer — a submission that says what it did not establish is telling the decider where to
 * look — so a screen that hid them to save room would be hiding the reason to press the other
 * button.
 */
export function DecisionCard({
  row,
  narrow,
  note,
  busy,
  error,
  onNote,
  onDecide,
}: {
  row: PendingDecisionRow;
  narrow: boolean;
  note: string;
  busy: boolean;
  error: Error | null;
  onNote: (note: string) => void;
  onDecide: (decision: 'CONFIRM' | 'SEND_BACK') => void;
}) {
  const resolved = row.citations.filter((citation) => citation.resolved).length;
  // What the door would do, in the order it asks: a standard to measure against at all, and then
  // this reader's standing to be the one measuring. Only a row that passes both has an action that
  // could succeed, so only such a row gets one that can be pressed.
  const decidable = row.decidability.decidable;
  const answerable = decidable && row.independence.independent;
  return (
    <div className="decision-card">
      <div className="decision-card-head">
        {decidable ? DECISION_HEADING : WAITING_ON_YOU_HEADING}
      </div>

      {/* Led with, when there is one: the reason nothing on this card can be pressed, and what
          the reader has to do about it. Everything below is still shown — deciding what the next
          revision should say means reading what this one did. */}
      {decidable ? null : (
        <div className="decision-card-section">
          <Typography.Text type="warning">
            {row.decidability.refusal ?? 'no decision can be recorded about this evidence'}
          </Typography.Text>
          <div>
            <Typography.Text>{WAITING_ON_YOU_ACTION}</Typography.Text>
          </div>
        </div>
      )}

      <div className="decision-card-section">
        <Typography.Text type="secondary">Against criterion </Typography.Text>
        {row.criterion ? (
          <>
            <Typography.Text code>{row.criterion.key}</Typography.Text>
            <div className="decision-card-criterion">{row.criterion.text}</div>
          </>
        ) : (
          <Typography.Text>
            This evidence quotes no stated criterion, so there is nothing to measure it against.
          </Typography.Text>
        )}
      </div>

      <div className="decision-card-section">
        <Typography.Text type="secondary">
          {`Evidence rev ${row.evidenceRevision} · ${formatSubmitted(row.ageSeconds)} — `}
        </Typography.Text>
        {row.claim === '' ? (
          // Evidence from before the envelope has no claim field at all. The line says so rather
          // than trailing off after the dash, which is what it did on the screenshot that started
          // this: a card of blanks reads as a broken render, not as an older submission.
          <Typography.Text type="secondary">this revision states no claim</Typography.Text>
        ) : (
          <Typography.Text>{row.claim}</Typography.Text>
        )}
      </div>

      <div className="decision-card-section">
        <Typography.Text type="secondary">
          {`Citations: ${resolved} of ${row.citations.length} resolved`}
        </Typography.Text>
        {/* Narrow screens fold THIS, and only this. */}
        {narrow ? null : (
          <ul className="decision-card-citations">
            {row.citations.map((citation) => (
              <li key={`${citation.kind}:${citation.ref}`}>
                <Typography.Text code>{citation.ref}</Typography.Text>{' '}
                <Typography.Text type={citation.resolved ? 'success' : 'warning'}>
                  {citation.resolved ? `${citation.kind} resolved` : (citation.reason ?? 'unresolved')}
                </Typography.Text>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Never folded, at any width. */}
      <div className="decision-card-section decision-card-gaps">
        <Typography.Text type="secondary">Declared gaps</Typography.Text>
        {row.gaps.length === 0 ? (
          <div>
            <Typography.Text>The submitter declared no gaps.</Typography.Text>
          </div>
        ) : (
          <ul className="decision-card-gap-list">
            {row.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="decision-card-section">
        <Typography.Text type="secondary">
          {row.independence.independent
            ? 'Independent: this session did not do this work.'
            : `You cannot answer this one: ${row.independence.disqualification ?? 'this session took part in this work'}.`}
        </Typography.Text>
      </div>

      {/* A note is what a send-back carries. A row that cannot be sent back is not given a box to
          write one in — an input whose only consumer is a refused request is a third way of
          promising something that will not happen. */}
      {decidable ? (
        <Input.TextArea
          aria-label="What the next evidence revision must show"
          placeholder="What the next evidence revision must show (required to send back)"
          rows={2}
          value={note}
          onChange={(event) => onNote(event.target.value)}
        />
      ) : null}

      {error ? (
        <Alert
          className="decision-card-error"
          type="error"
          showIcon
          message="That decision was not recorded"
          description={error.message}
        />
      ) : null}

      {/* Two buttons, and they answer THIS card. Same component and same sizes as the approval
          card's actions (`CardAction.tsx`), and the same rule: enabled only when the request they
          would send is one the server would accept. `Confirm completion` is pressable exactly when
          the door would take a CONFIRM — which is the property this card exists to have. */}
      <CardActions className="decision-card-actions">
        <CardActionButton
          tone="primary"
          disabled={busy || !answerable}
          onClick={() => onDecide('CONFIRM')}
        >
          {CONFIRM_LABEL}
        </CardActionButton>
        <CardActionButton
          tone="secondary"
          disabled={busy || !answerable || note.trim() === ''}
          onClick={() => onDecide('SEND_BACK')}
        >
          {SEND_BACK_LABEL}
        </CardActionButton>
      </CardActions>
    </div>
  );
}

/**
 * One group's rows, each opening into its card.
 *
 * Extracted so both groups share one row renderer: a group that grew its own would be a second
 * place for "what a row shows" to drift, and the difference between the groups is which rows are
 * in them and what the card says, never how a row reads.
 */
function DecisionRows({
  group,
  expandedTaskId,
  narrow,
  note,
  busy,
  error,
  onExpand,
  onNote,
  onDecide,
}: {
  group: PendingDecisionRow[];
  expandedTaskId: string | null;
  narrow: boolean;
  note: string;
  busy: boolean;
  error: Error | null;
  onExpand: (taskId: string | null) => void;
  onNote: (note: string) => void;
  onDecide: (row: PendingDecisionRow, decision: 'CONFIRM' | 'SEND_BACK') => void;
}) {
  return (
    <ul className="decision-rail-list">
      {group.map((row) => {
        const open = row.taskId === expandedTaskId;
        return (
          <li className="decision-rail-row" key={row.taskId}>
            <button
              className="decision-rail-summary"
              type="button"
              aria-expanded={open}
              onClick={() => onExpand(open ? null : row.taskId)}
            >
              <span className="decision-rail-task">{row.title}</span>
              <span className="decision-rail-criterion">
                {row.criterion ? row.criterion.key : 'no stated criterion'}
              </span>
              <span className="decision-rail-rev">{`rev ${row.evidenceRevision}`}</span>
              <span className="decision-rail-age">{formatAge(row.ageSeconds)}</span>
            </button>
            {open ? (
              <DecisionCard
                row={row}
                narrow={narrow}
                note={note}
                busy={busy}
                error={error}
                onNote={onNote}
                onDecide={(decision) => onDecide(row, decision)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The strip itself: presentational, pinned, and one line until somebody asks for more.
 *
 * It takes the whole payload as a prop and issues no request, so a static render can assert what
 * each state puts on screen — including the states that are about absence.
 *
 * `NEEDS YOUR DECISION` is built from the rows this session may answer and from nothing else, and
 * the count on the collapsed line is the length of that same array. One array, so the number a
 * reader decides to stop on cannot promise more than the list under it delivers — and a row this
 * reader may not answer can never appear under a heading that says it should.
 */
export function DecisionStrip({
  queue,
  open,
  expandedTaskId,
  narrow = false,
  note = '',
  busy = false,
  error = null,
  onToggle,
  onExpand,
  onNote = () => {},
  onDecide = () => {},
}: {
  queue: PendingDecisionQueue;
  /** Expanded is a deliberate act; the default is the one line. */
  open: boolean;
  expandedTaskId: string | null;
  narrow?: boolean;
  note?: string;
  busy?: boolean;
  error?: Error | null;
  onToggle: (open: boolean) => void;
  onExpand: (taskId: string | null) => void;
  onNote?: (note: string) => void;
  onDecide?: (row: PendingDecisionRow, decision: 'CONFIRM' | 'SEND_BACK') => void;
}) {
  // The door's own answer, carried on the row and read here rather than re-derived: a row this
  // session may not answer is not a question put to this session.
  const decisions = queue.pending.filter((row) => row.independence.independent);
  // Oldest first is the order the server sends, so the age this group leads with is the first row's
  // rather than the payload's `oldestAgeSeconds`. Same reason the count comes from `decisions`:
  // every number on screen is read off the list under it, so there is no second value to drift.
  const yours = queue.waitingOnYou ?? [];
  if (decisions.length === 0 && yours.length === 0) return null;

  const rowsFor = (group: PendingDecisionRow[]) => (
    <DecisionRows
      group={group}
      expandedTaskId={expandedTaskId}
      narrow={narrow}
      note={note}
      busy={busy}
      error={error}
      onExpand={onExpand}
      onNote={onNote}
      onDecide={onDecide}
    />
  );

  return (
    <div className="decision-strip" aria-label={STRIP_LABEL}>
      {/* The collapsed state, and the whole of it: at most two numbers, on one line, with no
          control that answers anything. It blocks no turn and must not look like the approval card,
          which does. */}
      <button
        className="decision-strip-line"
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        {decisions.length === 0 ? null : (
          <span className="decision-strip-dot" aria-hidden="true" />
        )}
        {decisions.length === 0 ? null : (
          <span className="decision-strip-count">{needsDecisionCount(decisions.length)}</span>
        )}
        {decisions.length === 0 || yours.length === 0 ? null : (
          <span className="decision-strip-sep" aria-hidden="true">·</span>
        )}
        {yours.length === 0 ? null : (
          <span className="decision-strip-count decision-strip-quiet">
            {waitingOnYouCount(yours.length)}
          </span>
        )}
        <span className="decision-strip-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="decision-strip-body">
          {/* The questions for a decider, and the only group that asks the reader for anything. */}
          {decisions.length === 0 ? null : (
            <section className="decision-rail-group" aria-label={NEEDS_DECISION_LABEL}>
              <div className="decision-rail-head">
                <span className="decision-rail-label">{NEEDS_DECISION_LABEL}</span>
                <span className="decision-rail-oldest">
                  {`oldest ${formatAge(decisions[0].ageSeconds)}`}
                </span>
              </div>
              {rowsFor(decisions)}
            </section>
          )}

          {/* The submissions this session is the one to fix, and the only undecidable rows that
              reach any session at all. Not greyed, because the sentence about the next revision is
              an instruction to the reader rather than news about somebody else. */}
          {yours.length === 0 ? null : (
            <section className="decision-rail-group decision-rail-mine" aria-label={WAITING_ON_YOU_LABEL}>
              <div className="decision-rail-head">
                <span className="decision-rail-label">{WAITING_ON_YOU_LABEL}</span>
                <span className="decision-rail-count">{`${yours.length} to resubmit`}</span>
              </div>
              {rowsFor(yours)}
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The write. One row, one version, one answer — the revision is what makes it a compare-and-set. */
export function decideEvidence(
  row: PendingDecisionRow,
  decidingSessionId: string,
  decision: 'CONFIRM' | 'SEND_BACK',
  note: string,
): Promise<unknown> {
  return api(`/tasks/${encodeURIComponent(row.taskId)}/evidence/decision`, {
    method: 'POST',
    body: {
      decidingSessionId,
      evidenceRevision: row.evidenceRevision,
      decision,
      note: note.trim() === '' ? undefined : note.trim(),
    },
  });
}

/** Where a card runs out of room for the per-citation list. Below this the tally stands in for it;
 *  the gaps are never what gives way. */
export const DECISION_NARROW_QUERY = '(max-width: 640px)';

/**
 * The wired strip: one query, one mutation, the fold, and the expansion the reader is holding open.
 *
 * `onDecided` is how an answer becomes an EVENT rather than a disappearance. The strip says what is
 * true now, so a settled question simply leaves it on the next read; the sentence describing what
 * was decided is handed up and rendered in the transcript, in place, by `DecisionLog`. A settled
 * line kept HERE would be a pinned area slowly filling with history.
 */
export function SessionDecisionStrip({
  sessionId,
  onDecided,
}: {
  sessionId: string;
  onDecided?: (line: string) => void;
}) {
  const qc = useQueryClient();
  const narrow = useMediaQuery(DECISION_NARROW_QUERY);
  const [open, setOpen] = useState(false);
  const [expandedTaskId, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const pending = useQuery({
    ...pendingDecisionsQuery(sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: 20_000,
  });
  const answer = useMutation({
    mutationFn: ({ row, decision }: { row: PendingDecisionRow; decision: 'CONFIRM' | 'SEND_BACK' }) =>
      decideEvidence(row, sessionId, decision, note),
    onSuccess: (_result, { row, decision }) => {
      setExpanded(null);
      setNote('');
      onDecided?.(
        decision === 'CONFIRM'
          ? completionConfirmedLine(row.title, row.criterion?.key ?? null, row.evidenceRevision)
          : sentBackLine(row.title, row.evidenceRevision),
      );
      void qc.invalidateQueries({ queryKey: pendingDecisionsQuery(sessionId).queryKey });
    },
  });

  // A read that failed is not "nothing is waiting". Saying so in one muted line is the smallest
  // thing that keeps a reader from mistaking a broken query for an empty queue; the strip is
  // otherwise silent while the first read is in flight, so it never flashes.
  if (pending.isError) {
    return (
      <div className="decision-strip decision-strip-unread" role="status">
        {`${STRIP_LABEL}: this queue could not be read.`}
      </div>
    );
  }
  if (!pending.data) return null;
  return (
    <DecisionStrip
      queue={pending.data}
      open={open}
      expandedTaskId={expandedTaskId}
      narrow={narrow}
      note={note}
      busy={answer.isPending}
      error={answer.isError ? (answer.error as Error) : null}
      onToggle={(next) => {
        setOpen(next);
        // Folding it away closes whatever was open inside it: a card held open behind a fold is a
        // note the reader cannot see they are still writing.
        if (!next) {
          answer.reset();
          setNote('');
          setExpanded(null);
        }
      }}
      onExpand={(taskId) => {
        answer.reset();
        // A note is written about ONE submission. Carrying it to the next card open would put
        // words the reader wrote about other work into a rejection of this one.
        setNote('');
        setExpanded(taskId);
      }}
      onNote={setNote}
      onDecide={(row, decision) => answer.mutate({ row, decision })}
    />
  );
}
