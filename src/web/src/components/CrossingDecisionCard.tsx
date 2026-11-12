import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReviewCard } from './ReviewCard';
import { CardActionButton, CardActions } from './CardAction';
import { decideCrossing } from './ProjectCrossingsCard';
import type { TranscriptInsert } from './Transcript';
import { api } from '../api';
import { projectCrossingsQuery, sessionTaskMovesQuery } from '../lib/queries';
import { streamPoll } from '../lib/listBudget';
import { decisionReceiptAnchor } from '../lib/decisionReceipt';
import { CROSSING_STATE_LABEL, labelFor, type ProjectCrossingRow } from '../lib/attribution';
import {
  CROSSING_APPROVE_LABEL,
  CROSSING_LINK_ANSWERED,
  CROSSING_LINK_LIVE,
  CROSSING_NOT_RECORDED,
  CROSSING_PROVENANCE,
  CROSSING_RECORDED,
  CROSSING_REFUSE_LABEL,
  CROSSING_SHOWN_ROWS,
  CROSSING_TO_THIS_PROJECT,
  anotherEndLine,
  answeredBadge,
  approveConsequence,
  batchDecidedAt,
  batchReasons,
  batchVerdict,
  crossingBadge,
  crossingBatches,
  crossingListHead,
  crossingSummary,
  crossingTitle,
  isLive,
  moveBatchAnswer,
  moveBatches,
  notRecordedNote,
  pendingRows,
  receiptVerdict,
  requestedCriterionLine,
  showMore,
  subjectTitle,
  waitingLine,
  withdrawnCriterionLine,
  type CrossingBatch,
} from '../lib/crossingBatches';
import './CrossingDecisionCard.css';

/**
 * A batch of cross-project requests into the project this conversation coordinates, as ONE decision
 * card in the criteria card's shape (board docs/mocks/handoff-in-chat): a compact preview — the swap
 * mark, the question, its kind, how many from which project for which criteria — that opens the
 * review, where the owner answers every crossing of the batch with one press.
 *
 * Task moves come from the session's own read (`GET /sessions/:id/task-moves`), so the card is drawn
 * both in the session that asked for them and in the target project's coordinator, and one press
 * is ONE `POST /sessions/:id/task-moves/decision` with every move and its crossing key: the server
 * writes nothing if any move no longer matches, and its refusal is shown on the card. Filings and
 * dependencies still come from the project's crossings read and go through the existing decision
 * door one crossing at a time (`decideCrossing`); a crossing that door refuses keeps its reason on
 * its row, and the ones it took are not undone.
 */

/** How an answered batch is receipted. */
export type CrossingReceipt =
  | { kind: 'BY_YOU'; at: string }
  | { kind: 'ANOTHER_END' };

/** A door's refusal of one crossing, keyed by the crossing's row id. */
export type CrossingRefusals = Readonly<Record<string, Error>>;

function refusalText(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${code} ${error.message}` : error.message;
}

function CrossingItem({ row, refusal }: { row: ProjectCrossingRow; refusal: Error | undefined }) {
  const requested = requestedCriterionLine(row);
  const withdrawn = withdrawnCriterionLine(row);
  return (
    <li className="crossing-decision-item">
      <span className="crossing-decision-item-title">{subjectTitle(row)}</span>
      {requested ? <span className="crossing-decision-item-crit">{requested}</span> : null}
      {withdrawn ? <span className="crossing-decision-item-crit">{withdrawn}</span> : null}
      {row.state === 'PENDING' ? null : (
        <span className="crossing-decision-item-crit">{labelFor(CROSSING_STATE_LABEL, row.state)}</span>
      )}
      {refusal ? (
        <span className="crossing-decision-item-refused" role="alert">
          <strong>{CROSSING_NOT_RECORDED}</strong> {refusalText(refusal)}
        </span>
      ) : null}
    </li>
  );
}

function ReceiptLine({ batch, receipt }: { batch: CrossingBatch; receipt: CrossingReceipt }) {
  const verdict = batchVerdict(batch);
  return (
    <p className="crossing-decision-receipt">
      {receipt.kind === 'BY_YOU' ? (
        <>
          {`${CROSSING_RECORDED} · `}
          <span className="crossing-decision-verdict">{receiptVerdict(verdict, receipt.at)}</span>
        </>
      ) : (
        `${CROSSING_RECORDED} · ${anotherEndLine(verdict)}`
      )}
    </p>
  );
}

export function CrossingDecisionCard({
  batch,
  receipt = null,
  busy = false,
  refusals = {},
  batchRefusal = null,
  onDecide,
}: {
  batch: CrossingBatch;
  /** Null while any crossing of the batch still waits. */
  receipt?: CrossingReceipt | null;
  busy?: boolean;
  refusals?: CrossingRefusals;
  /** The server's refusal of a whole batch answer (task moves): nothing of it was written. */
  batchRefusal?: Error | null;
  onDecide: (decision: 'APPROVE' | 'DENY') => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const live = isLive(batch);
  const title = crossingTitle(batch.kind, batch.rows.length, batch.targetTitle);
  const badge = live ? crossingBadge(batch.kind) : answeredBadge(batch.kind, batchVerdict(batch));
  const summary = crossingSummary(batch);
  const refused = batch.rows.filter((row) => refusals[row.id]).length;
  const shown = all ? batch.rows : batch.rows.slice(0, CROSSING_SHOWN_ROWS);
  const hidden = batch.rows.length - shown.length;
  const reasons = batchReasons(batch);
  const preview = (
    <>
      <span className="crossing-decision-head">
        <span className="crossing-decision-icon" aria-hidden="true">⇄</span>
        <span className="crossing-decision-title">{title}</span>
        <span className="crossing-decision-badge">{badge}</span>
      </span>
      <span className="crossing-decision-summary">{summary}</span>
      {refused > 0 ? <span className="crossing-decision-refused-note">{notRecordedNote(refused)}</span> : null}
      {batchRefusal ? <span className="crossing-decision-refused-note">{CROSSING_NOT_RECORDED}</span> : null}
      <span className="crossing-decision-link">
        <span>{live ? CROSSING_LINK_LIVE : CROSSING_LINK_ANSWERED}</span>
        <span aria-hidden="true">›</span>
      </span>
    </>
  );
  return (
    <div className={`crossing-decision-wrap${live ? '' : ' is-answered'}`} data-crossing-batch={batch.id}>
      <ReviewCard
        id={batch.id}
        title={title}
        summary={summary}
        open={open}
        onOpenChange={setOpen}
        preview={{ className: `crossing-decision-preview${live ? '' : ' is-answered'}`, content: preview }}
      >
        <div className="approval-card crossing-decision">
          <div className="approval-head">{title}</div>
          <div className="approval-body crossing-decision-body">
            {live ? <p className="crossing-decision-waiting">{waitingLine(batch)}</p> : null}
            <p className="crossing-decision-provenance">{CROSSING_PROVENANCE}</p>
            <p className="crossing-decision-route"><span>From</span> {batch.sourceTitle}</p>
            <p className="crossing-decision-route"><span>To</span> {batch.targetTitle ?? CROSSING_TO_THIS_PROJECT}</p>
            <p className="crossing-decision-label">{crossingListHead(batch.kind)}</p>
            <ul className="crossing-decision-list">
              {shown.map((row) => (
                <CrossingItem key={row.id} row={row} refusal={refusals[row.id]} />
              ))}
              {hidden > 0 ? (
                <li className="crossing-decision-item">
                  <button type="button" className="crossing-decision-more" onClick={() => setAll(true)}>
                    {showMore(hidden)}
                  </button>
                </li>
              ) : null}
            </ul>
            {reasons.map((reason) => (
              <p key={reason} className="crossing-decision-quote">{`“${reason}”`}</p>
            ))}
            <p className="crossing-decision-note">{approveConsequence(batch)}</p>
            {batchRefusal ? (
              <p className="crossing-decision-item-refused" role="alert">
                <strong>{CROSSING_NOT_RECORDED}</strong> {refusalText(batchRefusal)}
              </p>
            ) : null}
            {receipt ? <ReceiptLine batch={batch} receipt={receipt} /> : null}
          </div>
          {live ? (
            <CardActions className="approval-actions crossing-decision-actions">
              <CardActionButton tone="primary" disabled={busy} onClick={() => onDecide('APPROVE')}>
                {CROSSING_APPROVE_LABEL}
              </CardActionButton>
              <CardActionButton tone="secondary" disabled={busy} onClick={() => onDecide('DENY')}>
                {CROSSING_REFUSE_LABEL}
              </CardActionButton>
            </CardActions>
          ) : null}
        </div>
      </ReviewCard>
      {receipt ? <ReceiptLine batch={batch} receipt={receipt} /> : null}
    </div>
  );
}

/** One card the pinned strip can take the reader to: a batch still waiting. */
export interface CrossingPointer {
  id: string;
  label: string;
  ageSeconds: number | null;
}

/** Answer a batch of task moves in one call, every move with its crossing key. */
export function decideTaskMoveBatch(
  sessionId: string,
  batch: CrossingBatch,
  decision: 'APPROVE' | 'DENY',
): Promise<unknown> {
  return api(`/sessions/${encodeURIComponent(sessionId)}/task-moves/decision`, {
    method: 'POST',
    body: moveBatchAnswer(batch, decision),
  });
}

/**
 * The wired cards for one conversation: the task moves it asked for or that go into the project it
 * coordinates (the session's task-moves read), the filings and dependencies into that project (the
 * project's crossings read), each batch drawn into the transcript where its first request was
 * asked, and the pointers the pinned strip counts. What this window saw waiting and what it pressed
 * are kept in-process: the one fact the reads cannot carry is whether the answer was given here or
 * at another end. `moveSignal` is what the session's row says is waiting (`taskMoveSignal`): no
 * realtime event names this read, so it is re-asked the moment that changes — a move asked, or
 * answered at the other end.
 */
export function useCrossingDecisionCards(
  sessionId: string | null | undefined,
  projectId: string | null | undefined,
  events: ReadonlyArray<{ seq: number; ts?: string }>,
  moveSignal = '',
): { inserts: TranscriptInsert[]; pointers: CrossingPointer[] } {
  const qc = useQueryClient();
  const read = useQuery({
    ...projectCrossingsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: streamPoll(20_000),
  });
  const moves = useQuery({
    ...sessionTaskMovesQuery(sessionId ?? ''),
    enabled: Boolean(sessionId),
    refetchInterval: streamPoll(20_000),
  });
  const signalRead = useRef(moveSignal);
  const refetchMoves = moves.refetch;
  useEffect(() => {
    if (signalRead.current === moveSignal) return;
    signalRead.current = moveSignal;
    if (sessionId) void refetchMoves();
  }, [moveSignal, sessionId, refetchMoves]);
  const [seenLive, setSeenLive] = useState<ReadonlySet<string>>(() => new Set());
  const [pressed, setPressed] = useState<Readonly<Record<string, string>>>({});
  const [refusals, setRefusals] = useState<CrossingRefusals>({});
  const [batchRefusals, setBatchRefusals] = useState<CrossingRefusals>({});
  const [busy, setBusy] = useState<string | null>(null);

  const batches = useMemo(
    () => [
      // Task moves are drawn from the session's read alone, so both ends draw the same batches.
      ...(projectId && read.data
        ? crossingBatches(read.data, projectId).filter((batch) => batch.kind !== 'MOVE_TASK')
        : []),
      // An older control plane has no such read; an answer that is not a list draws no moves.
      ...(sessionId && Array.isArray(moves.data) ? moveBatches(moves.data) : []),
    ].sort((a, b) => a.moment.localeCompare(b.moment)),
    [projectId, read.data, sessionId, moves.data],
  );

  useEffect(() => {
    const live = batches.filter(isLive).map((batch) => batch.id);
    if (live.length === 0) return;
    setSeenLive((previous) => {
      if (live.every((id) => previous.has(id))) return previous;
      return new Set([...previous, ...live]);
    });
  }, [batches]);

  const answer = useMutation({
    mutationFn: async ({ batch, decision }: { batch: CrossingBatch; decision: 'APPROVE' | 'DENY' }) => {
      const rows = pendingRows(batch);
      if (batch.kind === 'MOVE_TASK') {
        // One answer for the whole batch: the server takes all of it or none of it.
        const [result] = await Promise.allSettled([decideTaskMoveBatch(sessionId ?? '', batch, decision)]);
        return { batch, rows: [], results: [], refusal: result.status === 'rejected' ? result.reason : null };
      }
      const results = await Promise.allSettled(
        rows.map((row) => decideCrossing(projectId ?? '', row, decision)),
      );
      return { batch, rows, results, refusal: null };
    },
    onMutate: ({ batch }) => setBusy(batch.id),
    onSuccess: ({ batch, rows, results, refusal }) => {
      setBatchRefusals((previous) => {
        const next: Record<string, Error> = { ...previous };
        if (refusal) next[batch.id] = refusal instanceof Error ? refusal : new Error(String(refusal));
        else delete next[batch.id];
        return next;
      });
      // Nothing was written: the card stays waiting, and this window did not answer it.
      if (!refusal) setPressed((previous) => ({ ...previous, [batch.id]: new Date().toISOString() }));
      setRefusals((previous) => {
        const next: Record<string, Error> = { ...previous };
        results.forEach((result, index) => {
          const id = rows[index].id;
          if (result.status === 'rejected') {
            next[id] = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
          } else {
            delete next[id];
          }
        });
        return next;
      });
      // Returned, so the card stays busy until the reads have caught up with the presses.
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['project', projectId ?? ''] }),
        qc.invalidateQueries({ queryKey: ['session-task-moves', sessionId ?? ''] }),
      ]);
    },
    onSettled: () => setBusy(null),
  });

  const inserts = useMemo(() => {
    return batches.flatMap((batch): TranscriptInsert[] => {
      const anchor = decisionReceiptAnchor(events, batch.moment);
      if (anchor === null) return [];
      let receipt: CrossingReceipt | null = null;
      if (!isLive(batch)) {
        const at = batchDecidedAt(batch) ?? pressed[batch.id] ?? batch.moment;
        receipt = pressed[batch.id] || !seenLive.has(batch.id)
          ? { kind: 'BY_YOU', at }
          : { kind: 'ANOTHER_END' };
      }
      return [{
        anchor,
        moment: batch.moment,
        key: batch.id,
        element: (
          <CrossingDecisionCard
            batch={batch}
            receipt={receipt}
            busy={busy === batch.id}
            refusals={refusals}
            batchRefusal={batchRefusals[batch.id] ?? null}
            onDecide={(decision) => answer.mutate({ batch, decision })}
          />
        ),
      }];
    });
    // `answer.mutate` is stable; the mutation object itself is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, events, pressed, seenLive, refusals, batchRefusals, busy]);

  const pointers = useMemo(
    () =>
      batches.filter(isLive).map((batch) => {
        const at = Date.parse(batch.moment);
        return {
          id: batch.id,
          label: crossingTitle(batch.kind, batch.rows.length, batch.targetTitle),
          ageSeconds: Number.isFinite(at) ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : null,
        };
      }),
    [batches],
  );

  return { inserts, pointers };
}

/** What a session's row says is waiting in task moves: the read is re-asked when it changes. */
export function taskMoveSignal(
  row: { taskMoves?: ReadonlyArray<{ handoffIds?: readonly string[] }> } | null | undefined,
): string {
  return (row?.taskMoves ?? []).flatMap((group) => group.handoffIds ?? []).join(',');
}
