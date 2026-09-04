import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Typography } from 'antd';
import { api } from '../api';
import { pendingDecisionsQuery } from '../lib/queries';
import { useMediaQuery } from '../lib/useMediaQuery';

/**
 * What this session is being asked to decide, pinned above the conversation.
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
 * session this rail is being read in, and that session is put through the same independence check
 * whoever is signed in. A row this session may not answer says so and keeps its buttons disabled —
 * it is still a question, it is just not this reader's to settle.
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

export interface PendingDecisionRow {
  taskId: string;
  title: string;
  criterion: { key: string; text: string } | null;
  evidenceRevision: string;
  ageSeconds: number;
  claim: string;
  gaps: string[];
  citations: PendingDecisionCitation[];
  independence: PendingDecisionIndependence;
}

export interface PendingDecisionQueue {
  decidingSessionId: string;
  count: number;
  oldestAgeSeconds: number | null;
  pending: PendingDecisionRow[];
}

/** The queue's own label. The weight goes on what the reader is looking at, not on the button. */
export const RAIL_LABEL = 'Awaiting judgment';
/** The card's heading. A question, stated as one. */
export const DECISION_HEADING = 'DECISION REQUIRED';
export const CONFIRM_LABEL = 'Confirm completion';
export const SEND_BACK_LABEL = 'Send back';

/** What a settled row says afterwards, naming the standard and the exact version answered. */
export function completionConfirmedLine(criterionKey: string | null, revision: string): string {
  return `Completion confirmed — coordinator · ${criterionKey ?? 'no stated criterion'} · rev ${revision}`;
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
  return (
    <div className="decision-card">
      <div className="decision-card-head">{DECISION_HEADING}</div>

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
        <Typography.Text type="secondary">{`Evidence rev ${row.evidenceRevision} — `}</Typography.Text>
        <Typography.Text>{row.claim}</Typography.Text>
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

      <Input.TextArea
        aria-label="What the next evidence revision must show"
        placeholder="What the next evidence revision must show (required to send back)"
        rows={2}
        value={note}
        onChange={(event) => onNote(event.target.value)}
      />

      {error ? (
        <Alert
          className="decision-card-error"
          type="error"
          showIcon
          message="That decision was not recorded"
          description={error.message}
        />
      ) : null}

      {/* Two buttons, and they answer THIS card. */}
      <div className="decision-card-actions">
        <Button
          type="primary"
          size="small"
          loading={busy}
          disabled={!row.independence.independent}
          onClick={() => onDecide('CONFIRM')}
        >
          {CONFIRM_LABEL}
        </Button>
        <Button
          size="small"
          disabled={busy || !row.independence.independent || note.trim() === ''}
          onClick={() => onDecide('SEND_BACK')}
        >
          {SEND_BACK_LABEL}
        </Button>
      </div>
    </div>
  );
}

/**
 * The rail itself: presentational, and rendered only when there is something to decide.
 *
 * It takes the whole payload as a prop and issues no request, so a static render can assert what
 * each state puts on screen — including the states that are about absence.
 */
export function DecisionRail({
  queue,
  expandedTaskId,
  narrow = false,
  note = '',
  busy = false,
  error = null,
  settled = null,
  onExpand,
  onNote = () => {},
  onDecide = () => {},
}: {
  queue: PendingDecisionQueue;
  expandedTaskId: string | null;
  narrow?: boolean;
  note?: string;
  busy?: boolean;
  error?: Error | null;
  settled?: string | null;
  onExpand: (taskId: string | null) => void;
  onNote?: (note: string) => void;
  onDecide?: (row: PendingDecisionRow, decision: 'CONFIRM' | 'SEND_BACK') => void;
}) {
  if (queue.pending.length === 0) {
    return settled ? (
      <div className="decision-rail decision-rail-settled" role="status">
        {settled}
      </div>
    ) : null;
  }
  return (
    <section className="decision-rail" aria-label={RAIL_LABEL}>
      <div className="decision-rail-head">
        <span className="decision-rail-label">{RAIL_LABEL}</span>
        <span className="decision-rail-count">{`${queue.count} waiting`}</span>
        {queue.oldestAgeSeconds === null ? null : (
          <span className="decision-rail-oldest">{`oldest ${formatAge(queue.oldestAgeSeconds)}`}</span>
        )}
      </div>
      {settled ? (
        <div className="decision-rail-settled" role="status">
          {settled}
        </div>
      ) : null}
      <ul className="decision-rail-list">
        {queue.pending.map((row) => {
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
    </section>
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

/** The wired rail: one query, one mutation, and the expansion the reader is holding open. */
export function SessionDecisionRail({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const narrow = useMediaQuery(DECISION_NARROW_QUERY);
  const [expandedTaskId, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [settled, setSettled] = useState<string | null>(null);
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
      setSettled(
        decision === 'CONFIRM'
          ? completionConfirmedLine(row.criterion?.key ?? null, row.evidenceRevision)
          : `Sent back — ${row.title} · rev ${row.evidenceRevision}`,
      );
      void qc.invalidateQueries({ queryKey: pendingDecisionsQuery(sessionId).queryKey });
    },
  });

  // A read that failed is not "nothing is waiting". Saying so in one muted line is the smallest
  // thing that keeps a reader from mistaking a broken query for an empty queue; the rail is
  // otherwise silent while the first read is in flight, so it never flashes.
  if (pending.isError) {
    return (
      <div className="decision-rail decision-rail-settled" role="status">
        {`${RAIL_LABEL}: this queue could not be read.`}
      </div>
    );
  }
  if (!pending.data) return null;
  return (
    <DecisionRail
      queue={pending.data}
      expandedTaskId={expandedTaskId}
      narrow={narrow}
      note={note}
      busy={answer.isPending}
      error={answer.isError ? (answer.error as Error) : null}
      settled={settled}
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
