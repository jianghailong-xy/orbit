import { useEffect, useId, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { api } from '../api';
import { pendingDecisionsQuery } from '../lib/queries';
import { CardActionButton, CardActions } from './CardAction';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';
import {
  decisionRowKey,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * The card that asks whether a task's submitted evidence settles it — composed by Orbit from the
 * pending read and answered at the decision door, with no agent between the two.
 *
 * WHY THIS IS NO LONGER A QUESTION AN AGENT ASKS
 * ----------------------------------------------
 * The same judgment used to reach a person as an AskUserQuestion: a submission resumed the project's
 * coordinator session, the model raised the ask, the press went back into the engine, and the model
 * then relayed it to `task_evidence_decide`. Measured on 2026-09-10 that relay alone was a p50 of
 * 15s between the press and the recorded row, and a turn that ended took its card with it. Nothing
 * in the loop needed a model: `GET /tasks/evidence-decisions/pending` already publishes the whole
 * row the question is about, and `POST /tasks/:taskId/evidence/decision` already takes the
 * browser's own credential. So this card is drawn from the one and presses the other — the shape
 * `CriteriaDecisionCard` has for the ruler.
 *
 * THE PROVENANCE MARK
 * -------------------
 * The criteria card's mark, for the criteria card's reason: a transcript is where an agent's words
 * appear, and the mark is the visible difference between Orbit asking and something in the
 * conversation asking. The title, the claim and the gaps ARE words somebody wrote into the record,
 * quoted as fields of the row; the frame around them, and what the buttons do, is Orbit's.
 *
 * NOTHING IS FROZEN INTO THE FRAME EXCEPT THE ADDRESS
 * ---------------------------------------------------
 * A card keeps one thing across renders — which version of which task's evidence it was drawn for,
 * `decisionRowKey`'s taskId@evidenceRevision, which is exactly what the door's compare-and-set is
 * against — and re-derives everything else from the read on every render
 * (`evidenceDecisionStanding`). A version answered in another window, displaced by a newer
 * revision, or not readable right now is therefore a conclusion about the read rather than local
 * state somebody has to remember to clear. The one fact the read cannot supply is this card's own
 * press, so the door's receipt for it is kept too: an answer given HERE reads as recorded, not as
 * answered somewhere else.
 *
 * THE HALF BOTH CARDS SHARE
 * -------------------------
 * The row's facts and the two verdicts are also what `ApprovalPanel`'s AskUserQuestion form draws,
 * and they live here so that, while both exist, the two cannot say different things about one row.
 * What only the form has — its position chip, the held pick, the question's full text and its third
 * answer — stays with the form.
 */

/** The card's heading. */
export const DECISION_ASK_HEADING = '需要你裁决';
/** `确认完成` submits on the click itself. The generic form's pick-then-Submit exists for a form
 *  with several questions and several picks per question; in a two-way judgment it buys nothing
 *  but one more click between a reader and the thing they already decided. */
export const DECISION_CONFIRM_ACTION = '确认完成';
export const DECISION_SEND_BACK_ACTION = '退回重做';
/** The send-back's own submit, behind the reason box rather than beside it. */
export const DECISION_SEND_ACTION = '退回';
/** Why the reason is required rather than a placeholder somebody may ignore: the decision door
 *  refuses a SEND_BACK carrying no note and writes nothing at all. The generic form could not know
 *  that, so it offered a permanently-present `Or type your own answer…` that reads like an
 *  invitation to say something rather than like the one thing that makes the button work. */
export const DECISION_NOTE_LABEL = '下一版证据要给出什么？这句话是下一次尝试唯一能瞄准的东西。';
export const DECISION_NOTE_PLACEHOLDER = '例如：把 pg spec 跑一遍，并给出改前先红的原始输出…';
/** The gaps that did not fit, counted rather than dropped: they are the body of this card. */
export const decisionGapsMore = (rest: number): string => `还有 ${rest} 条`;
/** Evidence from before the envelope has no claim at all; the line says so rather than rendering
 *  a blank where the card's lead should be. */
export const DECISION_NO_CLAIM = '这一版证据没有写下主张。';
export const DECISION_NO_CRITERION = '未引用验收条目';
export const DECISION_NO_GAPS = '提交者声明没有缺口';

/** How many gaps the card shows before it starts counting. Three is what fits on a phone above the
 *  actions; the rest are one press away and the count is never hidden. */
const DECISION_GAPS_SHOWN = 3;
/** Where a claim starts being folded. A claim is one sentence in the good case and a paragraph in
 *  the bad one, and the bad one must not push the gaps and the actions off the screen. */
const DECISION_CLAIM_CLAMP = 120;

/** One machine-checkable statement about the row, in the row's own fields. */
interface DecisionCheck {
  ok: boolean;
  text: string;
  /** What the reader would go and look at: the standard itself, or the door's words for a check
   *  that did not hold. Null when the line says everything there is. */
  detail: string | null;
}

/**
 * The three things nobody has to take on faith, folded into one line.
 *
 * Each is a structured field the server already computed, so this is a reading of the row rather
 * than an opinion about it — which is exactly why they fold and the gaps do not: a check that held
 * is a reason to stop reading, and a gap is a reason to keep going.
 */
function decisionChecks(row: PendingDecisionRow): DecisionCheck[] {
  const resolved = row.citations.filter((citation) => citation.resolved);
  const unresolved = row.citations.filter((citation) => !citation.resolved);
  return [
    {
      ok: row.decidability.decidable,
      text: '引用的验收条目仍是线上那一条',
      detail: row.decidability.decidable
        ? (row.criterion ? `${row.criterion.key} · ${row.criterion.text}` : null)
        : row.decidability.refusal,
    },
    {
      ok: row.citations.length > 0 && unresolved.length === 0,
      text: `${resolved.length}/${row.citations.length} 条引用解析成功`,
      detail:
        unresolved.length === 0
          ? null
          : unresolved.map((citation) => `${citation.ref}：${citation.reason ?? '未解析'}`).join('\n'),
    },
    {
      ok: row.independence.independent,
      text: '裁决人独立于这次提交',
      detail: row.independence.independent ? null : row.independence.disqualification,
    },
  ];
}

/** One row in the order a person decides in: what is claimed, what is admitted missing, and what
 *  was checked for them. Every visible string is a field of the row or a count of one. */
export function EvidenceDecisionFacts({ row }: { row: PendingDecisionRow }): JSX.Element {
  const [claimOpen, setClaimOpen] = useState(false);
  const [gapsOpen, setGapsOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);

  const claim = row.claim.trim();
  const longClaim = claim.length > DECISION_CLAIM_CLAMP;
  const shownGaps = row.gaps.slice(0, DECISION_GAPS_SHOWN);
  const restGaps = row.gaps.slice(DECISION_GAPS_SHOWN);
  const checks = decisionChecks(row);
  const held = checks.filter((check) => check.ok).length;

  return (
    <>
      <div className="decision-ask-claim">
        {claim === '' ? (
          <span className="decision-ask-quiet">{DECISION_NO_CLAIM}</span>
        ) : longClaim && !claimOpen ? (
          `${claim.slice(0, DECISION_CLAIM_CLAMP)}…`
        ) : (
          claim
        )}
      </div>
      {longClaim && (
        <button
          type="button"
          className="decision-ask-toggle"
          aria-expanded={claimOpen}
          onClick={() => setClaimOpen(!claimOpen)}
        >
          {claimOpen ? '收起' : '展开全文'}
        </button>
      )}
      <div className="decision-ask-meta">
        {`${row.taskId} · rev ${row.evidenceRevision} · `}
        {row.criterion ? row.criterion.key : DECISION_NO_CRITERION}
      </div>

      {/* The body of the card. What the submitter says they did NOT establish is the part most
          likely to change the answer, so a narrow screen gives up everything folded below it
          before it gives up any of this — and what does not fit is COUNTED rather than dropped,
          one press from being read. */}
      <div className="decision-ask-gaps">
        <div className="decision-ask-gaps-head">
          {row.gaps.length === 0 ? DECISION_NO_GAPS : `提交者声明的缺口 · ${row.gaps.length} 条`}
        </div>
        {row.gaps.length > 0 && (
          <ul className="decision-ask-gaps-list">
            {shownGaps.map((gap, k) => (
              <li key={k}>{gap}</li>
            ))}
          </ul>
        )}
        {restGaps.length > 0 && (
          <>
            <button
              type="button"
              className="decision-ask-toggle"
              aria-expanded={gapsOpen}
              onClick={() => setGapsOpen(!gapsOpen)}
            >
              {gapsOpen ? '收起' : decisionGapsMore(restGaps.length)}
            </button>
            {gapsOpen && (
              <ul className="decision-ask-gaps-rest">
                {restGaps.map((gap, k) => (
                  <li key={k}>{gap}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="decision-ask-checks">
        <button
          type="button"
          className="decision-ask-toggle"
          aria-expanded={checksOpen}
          onClick={() => setChecksOpen(!checksOpen)}
        >
          {`${held} 项机器已核`}
          {held === checks.length ? '' : ` · ${checks.length - held} 项没过`}
          <span className="decision-ask-caret" aria-hidden="true">{checksOpen ? '▴' : '▾'}</span>
        </button>
        {checksOpen && (
          <ul className="decision-ask-check-list">
            {checks.map((check, k) => (
              <li key={k} className={check.ok ? 'is-held' : 'is-broken'}>
                <span className="decision-ask-check-mark" aria-hidden="true">
                  {check.ok ? '✓' : '!'}
                </span>
                {check.text}
                {check.detail !== null && (
                  <div className="decision-ask-check-detail">{check.detail}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The two verdicts: confirm on one press, or send back with the reason the door requires.
 *
 * `children` lands after them in the same row, for an action only one card has — the
 * AskUserQuestion form's third answer. The system card passes none: a press there goes to the
 * door, and not deciding yet is simply not pressing.
 */
export function EvidenceDecisionActions({
  disabled,
  onConfirm,
  onSendBack,
  children,
}: {
  /** Whether no answer from here could succeed right now. Every control below follows it. */
  disabled: boolean;
  onConfirm: () => void;
  /** Called with the reason, trimmed — and never with an empty one. */
  onSendBack: (note: string) => void;
  children?: ReactNode;
}): JSX.Element {
  const noteId = useId();
  const [backOpen, setBackOpen] = useState(false);
  const [note, setNote] = useState('');
  return (
    <CardActions className="decision-ask-actions">
      <CardActionButton tone="primary" disabled={disabled} onClick={onConfirm}>
        {DECISION_CONFIRM_ACTION}
      </CardActionButton>
      <div className="decision-ask-back">
        <CardActionButton
          tone="secondary"
          disabled={disabled}
          onClick={() => setBackOpen(!backOpen)}
        >
          {DECISION_SEND_BACK_ACTION}
        </CardActionButton>
        {backOpen && (
          <div className="decision-ask-why">
            <label className="decision-ask-why-label" htmlFor={noteId}>
              {DECISION_NOTE_LABEL}
            </label>
            <textarea
              id={noteId}
              className="decision-ask-note"
              rows={3}
              placeholder={DECISION_NOTE_PLACEHOLDER}
              value={note}
              disabled={disabled}
              onChange={(event) => setNote(event.target.value)}
            />
            {/* The one rule both cards are under: an action that cannot succeed is disabled.
                A send-back with no note is refused by the door and writes nothing, so the
                control that would send it is not pressable until there is one. */}
            <CardActions className="decision-ask-send">
              <CardActionButton
                tone="secondary"
                disabled={disabled || note.trim() === ''}
                onClick={() => onSendBack(note.trim())}
              >
                {DECISION_SEND_ACTION}
              </CardActionButton>
            </CardActions>
          </div>
        )}
      </div>
      {children}
    </CardActions>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE SYSTEM CARD
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/** The two answers the door takes. There is deliberately no third that leaves it pending. */
export type EvidenceDecision = 'CONFIRM' | 'SEND_BACK';

/** What the door returns once it has recorded one — read back, not recomputed here. */
export interface EvidenceDecisionResult {
  taskId: string;
  evidenceRevision: string;
  decision: EvidenceDecision;
  note: string | null;
  decidedAt: string;
}

/** The door's two refusals that mean "this card is out of date", in the door's own spelling. */
export const EVIDENCE_DECISION_ALREADY_DECIDED = 'EVIDENCE_JUDGMENT_ALREADY_DECIDED';
export const EVIDENCE_DECISION_SUPERSEDED = 'EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED';

/** What the mark says about itself: who composed the card, whose words are quoted on it, and where
 *  a press goes. */
export const EVIDENCE_PROVENANCE_TITLE =
  '这张卡由 Orbit 按待决读直接出，不是 agent 在对话里打的字：任务标题、主张与缺口是记录里的原文。'
  + '按钮由 Orbit 授权，按下去用你自己的登录直达决定门，不经过任何 agent。';

/** The heading a card that can no longer be answered carries instead of `DECISION_ASK_HEADING`. */
export const EVIDENCE_DECISION_STALE_HEADING = '这一版证据已经不等你裁决了';
/** And the one for a card this browser could not re-derive just now. */
export const EVIDENCE_DECISION_UNREAD_HEADING = '这张卡刚才没能重新读取';
/** And the one for a card this reader has just answered. */
export const EVIDENCE_DECISION_RECORDED_HEADING = '你的裁决已记下';

/** What a card keeps across renders: the version of the evidence it was drawn for, and nothing else. */
export type EvidenceDecisionAddress = Pick<PendingDecisionRow, 'taskId' | 'evidenceRevision'>;

/**
 * The rows this session gets a card for.
 *
 * `pending` is already scoped by the server to rows this session may decide. The first two checks
 * are the second half of that rule, read off the door's own answers carried on the row exactly as
 * the rail reads them; the third is this card's own — a conversation shows the judgments of the
 * project it coordinates, and a row from another project, or from none, gets no card here.
 */
export function evidenceDecisionCardRows(
  queue: PendingDecisionQueue | null | undefined,
  projectId: string | null | undefined,
): PendingDecisionRow[] {
  if (!projectId) return [];
  return (queue?.pending ?? []).filter(
    (row) =>
      row.decidability.decidable && row.independence.independent && row.projectId === projectId,
  );
}

/**
 * Where one card stands RIGHT NOW, derived from the read and from nothing else.
 *
 *   * DECIDABLE — the version is in the read, and the read still says this session may answer it.
 *   * SUPERSEDED — it is gone, and the same task is in the read at a LATER revision. The door
 *     answers only a task's latest evidence, so every answer to this version would be refused; the
 *     later one is its own card.
 *   * ALREADY_DECIDED — it is gone and nothing later has taken its place: it was answered.
 *
 * `UNREAD` is not a state of the evidence but of this browser — the read has not come back — and a
 * card that cannot re-derive itself offers no action, because it cannot say one would succeed.
 */
export type EvidenceDecisionStanding =
  | { state: 'DECIDABLE'; address: EvidenceDecisionAddress; row: PendingDecisionRow }
  | { state: 'SUPERSEDED'; address: EvidenceDecisionAddress; replacement: PendingDecisionRow }
  | { state: 'ALREADY_DECIDED'; address: EvidenceDecisionAddress }
  | { state: 'UNREAD'; address: EvidenceDecisionAddress };

export function evidenceDecisionStanding(
  queue: PendingDecisionQueue | null | undefined,
  projectId: string | null | undefined,
  address: EvidenceDecisionAddress,
): EvidenceDecisionStanding {
  if (!queue) return { state: 'UNREAD', address };
  const rows = evidenceDecisionCardRows(queue, projectId);
  const key = decisionRowKey(address);
  const row = rows.find((each) => decisionRowKey(each) === key) ?? null;
  if (row) return { state: 'DECIDABLE', address, row };
  const replacement =
    rows.find(
      (each) =>
        each.taskId === address.taskId
        && isLaterRevision(each.evidenceRevision, address.evidenceRevision),
    ) ?? null;
  if (replacement) return { state: 'SUPERSEDED', address, replacement };
  return { state: 'ALREADY_DECIDED', address };
}

/** Revisions are decimal strings of up to 19 digits, so they are compared as digits: a `Number`
 *  would round the large ones together. */
function isLaterRevision(candidate: string, than: string): boolean {
  return candidate.length === than.length ? candidate > than : candidate.length > than.length;
}

/** Which of three things the reader is looking at: a question, one that has moved on, or a card
 *  this browser could not re-derive. */
export function evidenceDecisionHeading(standing: EvidenceDecisionStanding): string {
  if (standing.state === 'DECIDABLE') return DECISION_ASK_HEADING;
  if (standing.state === 'UNREAD') return EVIDENCE_DECISION_UNREAD_HEADING;
  return EVIDENCE_DECISION_STALE_HEADING;
}

/**
 * Why this card cannot be answered, addressed to the reader looking at its dead buttons.
 *
 * Each sentence names the refusal the door would give, because that is the fact: a reader told only
 * "you cannot" has been told the button is broken.
 */
export function evidenceDecisionStaleExplanation(standing: EvidenceDecisionStanding): string | null {
  switch (standing.state) {
    case 'DECIDABLE':
      return null;
    case 'SUPERSEDED':
      return (
        `被顶掉了：这个任务又提交了第 ${standing.replacement.evidenceRevision} 版证据，门只裁决最新的一版，`
        + `对第 ${standing.address.evidenceRevision} 版的任何裁决都会被拒绝（${EVIDENCE_DECISION_SUPERSEDED}）。`
        + `这里什么也没有记下；第 ${standing.replacement.evidenceRevision} 版有它自己的卡。`
      );
    case 'ALREADY_DECIDED':
      return (
        '已经答过了：这一版证据已不在待决里，它的裁决在别处记下了，从这张卡再发出的裁决会被拒绝'
        + `（${EVIDENCE_DECISION_ALREADY_DECIDED}）。这张卡没有替你记下任何东西，也改变不了已经记下的。`
      );
    case 'UNREAD':
      return (
        '待决读刚才没能读回来，所以这张卡说不出它此刻在问什么。卡上不存证据的副本，内容每次都从读重新推导；'
        + '说不准门会不会接受的裁决，这里就不提供。证据本身不受影响。'
      );
  }
}

/** A refusal of a press, said as staleness when that is what the door's code means. */
export function evidenceDecisionRefusal(error: Error): { stale: boolean; title: string } {
  // Duck-typed: `api()` rejects with an `ApiError` carrying the body's `code`, and nothing else
  // about the error class matters here.
  const code = (error as { code?: unknown }).code;
  if (code === EVIDENCE_DECISION_ALREADY_DECIDED) {
    return { stale: true, title: '没有记下：这一版证据已经在别处答过了，这张卡已过期' };
  }
  if (code === EVIDENCE_DECISION_SUPERSEDED) {
    return { stale: true, title: '没有记下：这一版证据已被更新的一版顶掉，这张卡已过期' };
  }
  return { stale: false, title: '这次裁决没有记下' };
}

/** What an answer given from this card leaves on it: the door's receipt, in the card's own words. */
export function evidenceDecisionRecordedLine(result: EvidenceDecisionResult): string {
  const action =
    result.decision === 'CONFIRM' ? DECISION_CONFIRM_ACTION : DECISION_SEND_BACK_ACTION;
  const line = `已记下「${action}」 · rev ${result.evidenceRevision}`;
  return result.note ? `${line}：${result.note}` : line;
}

/**
 * The card. Presentational: it takes the standing and issues no request, so a static render can
 * assert what each state puts on screen.
 *
 * The actions are `CardAction`'s, under its one rule — an action that cannot succeed is `disabled`
 * rather than lit-and-refused — and every state but DECIDABLE is one where none can. The sentence
 * saying why sits above the dead row, so it reads as the reason the row is dead.
 */
export function EvidenceDecisionCard({
  standing,
  busy = false,
  error = null,
  recorded = null,
  onDecide,
}: {
  standing: EvidenceDecisionStanding;
  /** A press from this card is on its way to the door. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  /** The door's receipt for an answer given from this card, once there is one. */
  recorded?: EvidenceDecisionResult | null;
  onDecide: (decision: EvidenceDecision, note?: string) => void;
}): JSX.Element {
  const row = standing.state === 'DECIDABLE' ? standing.row : null;
  const stale = recorded ? null : evidenceDecisionStaleExplanation(standing);
  const refusal = error ? evidenceDecisionRefusal(error) : null;
  return (
    // Where the rail's pointer lands: `revealDecisionCard` looks for this key, computed from its own
    // copy of the same row, so there is no map between the two to fall out of step.
    <div
      className="approval-card decision-ask evidence-decision"
      data-decision-row={decisionRowKey(standing.address)}
    >
      <div className="approval-head decision-ask-head">
        <span className="evidence-decision-heading">
          {recorded ? EVIDENCE_DECISION_RECORDED_HEADING : evidenceDecisionHeading(standing)}
        </span>
        <span className="criteria-provenance" title={EVIDENCE_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions decision-ask-body">
        <section className="decision-ask-q">
          {row ? (
            <>
              <div className="decision-ask-chip">{row.title}</div>
              <EvidenceDecisionFacts row={row} />
            </>
          ) : (
            // The address and nothing else: a version that has left the read is not published any
            // more, and this card kept no copy of what it said.
            <div className="decision-ask-meta">
              {`${standing.address.taskId} · rev ${standing.address.evidenceRevision}`}
            </div>
          )}
          {stale ? <p className="evidence-decision-stale">{stale}</p> : null}
          {error && refusal ? (
            <Alert
              className="evidence-decision-error"
              type={refusal.stale ? 'warning' : 'error'}
              showIcon
              message={refusal.title}
              description={error.message}
            />
          ) : null}
          {recorded ? (
            <div className="decision-ask-picked">{evidenceDecisionRecordedLine(recorded)}</div>
          ) : (
            <EvidenceDecisionActions
              disabled={busy || row === null}
              onConfirm={() => onDecide('CONFIRM')}
              onSendBack={(note) => onDecide('SEND_BACK', note)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** The body the door takes. `note` rides with a send-back and with nothing else. */
export interface EvidenceDecisionRequestBody {
  decidingSessionId: string;
  evidenceRevision: string;
  decision: EvidenceDecision;
  note?: string;
}

/**
 * The request one press makes, as data, so what goes to the door can be asserted without a network.
 *
 * Three bindings, and they are not the same kind of thing: `decidingSessionId` says where the answer
 * is given FROM — the door runs its independence check on that session, so an account owner gets no
 * shorter path than a coordinator does — the credential `api()` carries says WHO, and
 * `evidenceRevision` says WHICH version was read, which is the compare-and-set the door refuses
 * once that version is not the latest.
 */
export function evidenceDecisionRequest(
  row: EvidenceDecisionAddress,
  decidingSessionId: string,
  decision: EvidenceDecision,
  note?: string,
): { path: string; body: EvidenceDecisionRequestBody } {
  const reason = note?.trim() ?? '';
  return {
    path: `/tasks/${encodeURIComponent(row.taskId)}/evidence/decision`,
    body: {
      decidingSessionId,
      evidenceRevision: row.evidenceRevision,
      decision,
      ...(decision === 'SEND_BACK' && reason !== '' ? { note: reason } : {}),
    },
  };
}

/** The write, with the reader's own credential — no agent between the press and the door. */
export function sendEvidenceDecision(
  row: EvidenceDecisionAddress,
  decidingSessionId: string,
  decision: EvidenceDecision,
  note?: string,
): Promise<EvidenceDecisionResult> {
  const request = evidenceDecisionRequest(row, decidingSessionId, decision, note);
  return api<EvidenceDecisionResult>(request.path, { method: 'POST', body: request.body });
}

/** One card and its own press: busy, refused and recorded belong to the card that was pressed. */
function EvidenceDecisionSlot({
  sessionId,
  standing,
}: {
  sessionId: string;
  standing: EvidenceDecisionStanding;
}): JSX.Element {
  const qc = useQueryClient();
  const answer = useMutation({
    mutationFn: ({
      row,
      decision,
      note,
    }: {
      row: PendingDecisionRow;
      decision: EvidenceDecision;
      note?: string;
    }) => sendEvidenceDecision(row, sessionId, decision, note),
    // Re-read whichever way the door answered: a recorded decision leaves the queue, and a refusal
    // for staleness means the queue has moved. Returned rather than fired off, so the card stays
    // busy until the read it derives from has caught up with the press.
    onSettled: () =>
      qc.invalidateQueries({ queryKey: pendingDecisionsQuery(sessionId).queryKey }),
  });
  return (
    <EvidenceDecisionCard
      standing={standing}
      busy={answer.isPending}
      error={answer.isError ? answer.error : null}
      recorded={answer.isSuccess ? answer.data : null}
      onDecide={(decision, note) => {
        if (standing.state !== 'DECIDABLE') return;
        answer.mutate({ row: standing.row, decision, note });
      }}
    />
  );
}

/**
 * The wired cards: one per version of evidence this conversation has been shown, each re-derived on
 * every render.
 *
 * WHY THE CONVERSATION REMEMBERS ADDRESSES
 * ----------------------------------------
 * Built from `pending` alone, a card would VANISH the moment its version was answered in another
 * window or displaced by a newer one — indistinguishable, to somebody halfway through reading it,
 * from a render that broke. So the addresses shown here are kept, and only the addresses. A row in
 * the read is drawn on the render it arrives in rather than one render later; remembering it is for
 * after it leaves.
 *
 * Reloading the page forgets them, which is correct: a settled question needs no card.
 */
export function SessionEvidenceDecisionCard({
  sessionId,
  projectId,
}: {
  /** The session a press decides FROM, and the one the pending read is scoped to. */
  sessionId: string;
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
}): JSX.Element | null {
  const [seen, setSeen] = useState<EvidenceDecisionAddress[]>([]);
  const pending = useQuery({
    ...pendingDecisionsQuery(sessionId),
    enabled: Boolean(sessionId) && Boolean(projectId),
    refetchInterval: 20_000,
  });
  const queue = pending.data ?? null;
  useEffect(() => {
    const arrived = evidenceDecisionCardRows(queue, projectId);
    if (arrived.length === 0) return;
    setSeen((previous) => {
      const known = new Set(previous.map(decisionRowKey));
      const fresh = arrived
        .filter((row) => !known.has(decisionRowKey(row)))
        .map((row) => ({ taskId: row.taskId, evidenceRevision: row.evidenceRevision }));
      return fresh.length === 0 ? previous : [...previous, ...fresh];
    });
  }, [queue, projectId]);

  if (!projectId) return null;
  const known = new Set(seen.map(decisionRowKey));
  const addresses = [
    ...seen,
    ...evidenceDecisionCardRows(queue, projectId)
      .filter((row) => !known.has(decisionRowKey(row)))
      .map((row) => ({ taskId: row.taskId, evidenceRevision: row.evidenceRevision })),
  ];
  if (addresses.length === 0) return null;
  // A read that failed is not an empty queue: every card derives UNREAD from it rather than
  // concluding its version was answered.
  const read = pending.isError ? null : queue;
  return (
    <>
      {addresses.map((address) => (
        <EvidenceDecisionSlot
          key={decisionRowKey(address)}
          sessionId={sessionId}
          standing={evidenceDecisionStanding(read, projectId, address)}
        />
      ))}
    </>
  );
}
