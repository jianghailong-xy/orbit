import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { CardActionButton, CardActions } from './CardAction';
import { api } from '../api';
import { pendingCriteriaDecisionsQuery } from '../lib/queries';

/**
 * The card that asks the account owner whether this project's ruler may move, in the conversation
 * the question was delivered to.
 *
 * WHY THIS CARD CARRIES A PROVENANCE MARK
 * ---------------------------------------
 * The whole security argument is that THIS CARD IS NOT THE AGENT'S TYPING. A coordinator session
 * cannot approve a loosening of its own project's criteria — the door refuses every call that
 * carries an acting session — so the only way the ruler moves is a person pressing something the
 * SERVER authorised. But a transcript is a place where an agent's words appear, and an agent can
 * write a paragraph that reads exactly like a decision card. So the mark is not decoration: it is
 * the one visible difference between "Orbit is asking you" and "something in the conversation is
 * asking you", and a reader has to be able to make that difference at a glance. Everything above
 * the actions is a field of the server's derived row or a statement about the mechanism; nothing
 * on this card is composed from anything an agent said.
 *
 * THE BUTTONS GO STRAIGHT TO THE DOOR, WITH THE READER'S OWN CREDENTIAL
 * --------------------------------------------------------------------
 * `api()` is the browser's authenticated fetch, so a press is the ACCOUNT OWNER answering
 * `POST /projects/:id/acceptance/criteria-decisions/:intentId` and nothing is relayed through the
 * agent — which is the same rule stated from the other side: the party asking for a looser ruler
 * must not be the party that moves it. The proposal's one-time `commitToken` is the second key and
 * rides with the press; the proposer never receives it.
 *
 * NOTHING IS FROZEN INTO THE FRAME EXCEPT THE ADDRESS
 * ---------------------------------------------------
 * A delivered card is a frame that exists for as long as the conversation does, and the question
 * it was about can be answered in another window, displaced by a newer proposal, or stranded by a
 * ruler that moved underneath it. So this card keeps ONE thing across renders — the proposal's id,
 * which is what was delivered — and reads everything else out of `readPendingCriteriaDecisions` on
 * every render. `criteriaDecisionStanding` below is the whole of that: the three stale states are
 * conclusions about the derived read rather than local state somebody has to remember to clear.
 *
 * A consequence worth stating, because it looks like a bug until it is read as the design: a card
 * that has gone stale shows NO diff. The derived read drops a proposal the moment it is settled or
 * displaced, so the proposed criteria are genuinely not published any more, and a card that still
 * displayed them would be displaying a frozen copy — the exact thing this card does not keep. What
 * is left is the address, what happened to it, and two buttons that cannot be pressed.
 */

/** One criterion as the proposal states it. `id` is null for one the proposal is adding. */
export interface ProposedCriterion {
  id: string | null;
  ordinal: number;
  text: string;
  verificationMethod: string;
  completionCriterionOverrideReason: string | null;
}

/** Whether the door would record a decision about this proposal right now — the server's answer. */
export interface CriteriaDecisionDecidability {
  decidable: boolean;
  /** The door's own refusal code, null when decidable. */
  refusal: string | null;
  /** What would clear it, in the vocabulary the refusal carries. */
  requiredAction: string | null;
}

/**
 * One held proposal, as `readPendingCriteriaDecisions` publishes it to the owner.
 *
 * `commitToken` is on the OWNER's read of this row and on no other: it is the proposal's one-time
 * key, and the session that filed the proposal is never given it.
 */
export interface PendingCriteriaDecisionRow {
  intentId: string;
  projectId: string;
  commitToken: string;
  actionDigest: string;
  filedAt: string;
  ageSeconds: number;
  /** The seal of the standard set this proposal was composed against. */
  baselineSeal: string;
  /** The seal standing now. Equal to `baselineSeal` exactly when the proposal is decidable. */
  currentSeal: string;
  proposed: ProposedCriterion[];
  /** The proposal this one displaced, or null when it displaced nothing. */
  supersededIntentId: string | null;
  decidability: CriteriaDecisionDecidability;
}

/** The derived read: every proposal of one project that is still a question, oldest first. */
export interface PendingCriteriaDecisionQueue {
  readAt: string;
  projectId: string;
  count: number;
  oldestAgeSeconds: number | null;
  decidableCount: number;
  pending: PendingCriteriaDecisionRow[];
}

/** What the door returns once it has answered one — read back, not recomputed here. */
export interface CriteriaDecisionResult {
  intentId: string;
  decision: CriteriaDecision;
  decidedAt: string;
  baseSeal: string;
  resultingSeal: string;
  /** True for an APPROVE and only an APPROVE: whether any criterion actually moved. */
  applied: boolean;
}

/** The two answers the door takes. There is deliberately no third that leaves it pending. */
export type CriteriaDecision = 'APPROVE' | 'REJECT';

/** The door's refusal codes, in the door's spelling, so the card can say which one it would meet. */
export const CRITERIA_DECISION_BASE_SEAL_MOVED = 'PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED';
export const CRITERIA_DECISION_ALREADY_SETTLED = 'PROJECT_CRITERIA_DECISION_ALREADY_SETTLED';

/** The mark. Short, and the only thing on the card claiming who wrote it. */
export const PROVENANCE_LABEL = 'FROM ORBIT';
export const PROVENANCE_TITLE =
  'Orbit composed this card and authorised its buttons. An agent asked for the change; nothing an '
  + 'agent typed can appear here, and pressing a button here does not go through one.';

export const CRITERIA_DECISION_HEADING =
  'A weakening change to this project’s ruler needs your decision';
/** The heading a card that can no longer be answered carries instead. */
export const CRITERIA_DECISION_STALE_HEADING = 'This decision is no longer yours to make';
/** And the one for a card that cannot say: this browser has not managed the read. */
export const CRITERIA_DECISION_UNREAD_HEADING = 'This card could not be re-read just now';
export const APPROVE_LABEL = 'Approve & re-seal';
export const REFUSE_LABEL = 'Refuse';

/**
 * What is NOT at stake, said on the card because it is the thing readers get wrong.
 *
 * A held proposal changes nothing while it is held: the criteria on record are the ones in force,
 * and the session that proposed the change was told to go on working against them. So refusing
 * stops the ruler from moving and stops nothing else — which is what makes `Refuse` an ordinary
 * answer rather than a way of blocking somebody's work.
 */
export const NOTHING_IS_ON_HOLD =
  'Nothing is on hold. The criteria on record are the ones in force and the session that proposed '
  + 'this was told to keep working against them, so refusing stops the ruler from moving, not the '
  + 'work.';

/** A seal as a reader compares it: enough to tell two apart, never the whole 64 characters. */
export function shortSeal(seal: string): string {
  return seal === '' ? '(unreadable)' : seal.slice(0, 12);
}

/**
 * Where one delivered card stands RIGHT NOW, derived from the read and from nothing else.
 *
 * The four terminal shapes a delivered proposal can be in, and how each is read off the queue:
 *
 *   * DECIDABLE — the row is in the read and the server says the door would take an answer.
 *   * BASE_SEAL_MOVED — the row is in the read and the server says it would not: the ruler this
 *     proposal was composed against is not the one in force. The read returns it precisely so this
 *     can be explained rather than left as a card that vanished.
 *   * SUPERSEDED — the row is gone AND a proposal still pending names it as the one it displaced.
 *     Read off the supersession link rather than off timestamps, for the same reason the server
 *     does: two proposals can share a moment.
 *   * ALREADY_SETTLED — the row is gone and nothing pending claims to have displaced it. Somebody
 *     answered it, at another end, and the door would now refuse this card with its own code.
 *
 * `UNREAD` is the fifth and is not a state of the proposal at all — it is the state of this
 * browser: the read has not come back. A card that cannot re-derive itself must not offer an
 * action, because it has no idea whether that action would succeed.
 */
export type CriteriaDecisionStanding =
  | { state: 'DECIDABLE'; intentId: string; row: PendingCriteriaDecisionRow }
  | { state: 'BASE_SEAL_MOVED'; intentId: string; row: PendingCriteriaDecisionRow }
  | { state: 'SUPERSEDED'; intentId: string; replacement: PendingCriteriaDecisionRow }
  | { state: 'ALREADY_SETTLED'; intentId: string }
  | { state: 'UNREAD'; intentId: string };

export function criteriaDecisionStanding(
  queue: PendingCriteriaDecisionQueue | null | undefined,
  intentId: string,
): CriteriaDecisionStanding {
  if (!queue) return { state: 'UNREAD', intentId };
  const row = queue.pending.find((pending) => pending.intentId === intentId) ?? null;
  if (row) {
    return row.decidability.decidable
      ? { state: 'DECIDABLE', intentId, row }
      : { state: 'BASE_SEAL_MOVED', intentId, row };
  }
  const replacement =
    queue.pending.find((pending) => pending.supersededIntentId === intentId) ?? null;
  if (replacement) return { state: 'SUPERSEDED', intentId, replacement };
  return { state: 'ALREADY_SETTLED', intentId };
}

/** Whether the door would take an answer to this card: true for exactly one of the five. */
export function isAnswerable(standing: CriteriaDecisionStanding): boolean {
  return standing.state === 'DECIDABLE';
}

/**
 * Why this card cannot be answered, addressed to the reader looking at its dead buttons.
 *
 * Each sentence names the refusal the door would give, because that is the fact — a reader told
 * only "you cannot" has been told the button is broken, and a reader told which refusal can go and
 * look at what happened.
 */
export function staleExplanation(standing: CriteriaDecisionStanding): string | null {
  switch (standing.state) {
    case 'DECIDABLE':
      return null;
    case 'BASE_SEAL_MOVED': {
      const { row } = standing;
      return (
        `The base seal moved. This proposal was composed against ${shortSeal(row.baselineSeal)} and `
        + `the standard set in force is now ${shortSeal(row.currentSeal)}, so the decision door `
        + `refuses every answer to it with `
        + `${row.decidability.refusal ?? CRITERIA_DECISION_BASE_SEAL_MOVED}. Nothing was applied. `
        + `What clears it is ${row.decidability.requiredAction ?? 'a proposal against the current '
          + 'standard set'} — by the party that proposed it, which is not you.`
      );
    }
    case 'SUPERSEDED':
      return (
        'Superseded. A later proposal against this project replaced this one, and a project holds '
        + 'at most one pending proposal at a time, so what you would be approving here is not what '
        + 'anybody is asking for any more. Nothing was applied. The replacement is the proposal '
        + `now waiting for a decision, composed against ${shortSeal(standing.replacement.baselineSeal)}.`
      );
    case 'ALREADY_SETTLED':
      return (
        'Already answered. This proposal is no longer one of the project’s pending ones — the '
        + 'answer was recorded at another end, and a decision sent from this card now would be '
        + `refused with ${CRITERIA_DECISION_ALREADY_SETTLED}. Nothing on this card was applied by `
        + 'you, and nothing here can change what was.'
      );
    case 'UNREAD':
      return (
        'This card could not be re-read just now, so what it is asking about cannot be shown. It '
        + 'holds no copy of the proposal: everything on it is derived on each render, and an '
        + 'action nobody can say the door would accept is not offered. The proposal itself is '
        + 'untouched by this.'
      );
  }
}

/**
 * The card's heading, which says which of three things the reader is looking at: a question, a
 * question somebody else has already settled, or a card this browser could not re-derive.
 */
export function headingFor(standing: CriteriaDecisionStanding): string {
  if (standing.state === 'DECIDABLE') return CRITERIA_DECISION_HEADING;
  if (standing.state === 'UNREAD') return CRITERIA_DECISION_UNREAD_HEADING;
  return CRITERIA_DECISION_STALE_HEADING;
}

/** The proposed set, numbered as the server numbers it, with the additions marked. */
function ProposedCriteria({ proposed }: { proposed: ProposedCriterion[] }): JSX.Element {
  return (
    <ol className="criteria-decision-proposed">
      {proposed.map((criterion, index) => (
        <li key={criterion.id ?? `new-${index}`}>
          <span className="criteria-decision-text">{criterion.text}</span>
          <span className="criteria-decision-method">{criterion.verificationMethod}</span>
          {criterion.id === null ? (
            <span className="criteria-decision-new">new in this proposal</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The card. Presentational: it takes the standing and issues no request, so a static render can
 * assert what each of the five states puts on screen.
 *
 * The actions are `CardAction`'s, under `CardAction`'s one rule — an action that cannot succeed is
 * `disabled` rather than lit-and-refused — and `Approve & re-seal` is the primary tone, which
 * loses its fill as well as its strength while it is disabled. A stale card is the state that rule
 * was written for: it looks like the live one and can do none of what the live one can.
 */
export function CriteriaDecisionCard({
  standing,
  busy = false,
  error = null,
  onDecide,
}: {
  standing: CriteriaDecisionStanding;
  busy?: boolean;
  error?: Error | null;
  onDecide: (decision: CriteriaDecision) => void;
}): JSX.Element {
  const answerable = isAnswerable(standing);
  const stale = staleExplanation(standing);
  const row =
    standing.state === 'DECIDABLE' || standing.state === 'BASE_SEAL_MOVED' ? standing.row : null;
  return (
    <div className="approval-card criteria-decision" id={`criteria-decision-${standing.intentId}`}>
      <div className="approval-head criteria-decision-head">
        <span className="criteria-decision-heading">{headingFor(standing)}</span>
        {/* The mark, and the reason it exists is in its own title rather than in a footnote
            somebody has to find: this card is the server's, and the agent's turn is not where it
            came from. */}
        <span className="criteria-provenance" title={PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>

      <div className="approval-body criteria-decision-body">
        {row ? (
          <>
            <div className="criteria-decision-kv">
              <span className="criteria-decision-k">Base seal</span>
              <span className="criteria-decision-v">
                <code>{shortSeal(row.baselineSeal)}</code>
                {row.baselineSeal === row.currentSeal
                  ? ' · unchanged since this was drafted'
                  : ` · the set in force is now ${shortSeal(row.currentSeal)}`}
              </span>
            </div>
            <div className="criteria-decision-kv">
              <span className="criteria-decision-k">Proposed</span>
              <span className="criteria-decision-v">
                {`${row.proposed.length} criteria, as this project’s standard set`}
              </span>
            </div>
            <ProposedCriteria proposed={row.proposed} />
            <p className="criteria-decision-hold">{NOTHING_IS_ON_HOLD}</p>
          </>
        ) : standing.state === 'UNREAD' ? null : (
          // Deliberately blank of content: see the file header. A settled or displaced proposal is
          // not published any more, and this card kept no copy of it.
          <p className="criteria-decision-gone">
            {'This card holds the proposal’s address and nothing else — what it was asking about '
              + 'is no longer published by the pending read.'}
          </p>
        )}
      </div>

      {/* Above the dead row, so it reads as the reason the buttons are dead. */}
      {stale ? <p className="approval-stale">{stale}</p> : null}

      {error ? (
        <Alert
          className="criteria-decision-error"
          type="error"
          showIcon
          message="That decision was not recorded"
          description={error.message}
        />
      ) : null}

      <CardActions className="approval-actions criteria-decision-actions">
        <CardActionButton
          tone="primary"
          disabled={busy || !answerable}
          onClick={() => onDecide('APPROVE')}
        >
          {APPROVE_LABEL}
        </CardActionButton>
        <CardActionButton
          tone="secondary"
          disabled={busy || !answerable}
          onClick={() => onDecide('REJECT')}
        >
          {REFUSE_LABEL}
        </CardActionButton>
        {/* The second key, named but never shown: what the reader is being told is that the press
            carries one, which is why an agent quoting this card cannot reproduce it. */}
        <span className="criteria-decision-bound">
          {`intent ${standing.intentId.slice(0, 8)} · ${
            answerable ? 'commit token bound' : 'no key of this card is live'
          }`}
        </span>
      </CardActions>
    </div>
  );
}

/**
 * The request one press makes, as data, so what goes to the door can be asserted without a network.
 *
 * Three bindings and they are not the same kind of thing: `commitToken` says WHAT is being decided
 * (the proposal's own one-time key), the credential `api()` carries says WHO decided, and
 * `baseSeal` says WHEN — the version of the standard set this answer was composed against, which
 * is why the door has a separate refusal for it.
 */
export function criteriaDecisionRequest(
  row: PendingCriteriaDecisionRow,
  decision: CriteriaDecision,
): { path: string; body: { commitToken: string; decision: CriteriaDecision; baseSeal: string } } {
  return {
    path:
      `/projects/${encodeURIComponent(row.projectId)}/acceptance/criteria-decisions/`
      + `${encodeURIComponent(row.intentId)}`,
    body: { commitToken: row.commitToken, decision, baseSeal: row.baselineSeal },
  };
}

/** The write, with the reader's own credential — no agent between the press and the door. */
export function decideCriteriaChange(
  row: PendingCriteriaDecisionRow,
  decision: CriteriaDecision,
): Promise<CriteriaDecisionResult> {
  const request = criteriaDecisionRequest(row, decision);
  return api<CriteriaDecisionResult>(request.path, { method: 'POST', body: request.body });
}

/**
 * What a decision leaves behind in the transcript: the event, said where it happened.
 *
 * The seals are the whole of the compare-and-set the door performed, in the door's own words, so a
 * reader a week later can tell which version was answered — and, for a refusal, that the version
 * did not move.
 */
export function criteriaApprovedLine(result: CriteriaDecisionResult): string {
  return (
    `You approved the weakening — the ruler moved, seal ${shortSeal(result.baseSeal)} → `
    + `${shortSeal(result.resultingSeal)}`
  );
}

export function criteriaRefusedLine(result: CriteriaDecisionResult): string {
  return (
    `You refused the weakening — nothing was applied, seal stays ${shortSeal(result.baseSeal)}`
  );
}

export function criteriaDecisionLine(result: CriteriaDecisionResult): string {
  return result.decision === 'APPROVE' ? criteriaApprovedLine(result) : criteriaRefusedLine(result);
}

/**
 * The wired cards: one per proposal this window has been shown, each re-derived on every render.
 *
 * WHY THE WINDOW REMEMBERS THE ADDRESS AND NOTHING ELSE
 * ----------------------------------------------------
 * A card is a delivery: it appeared in this conversation because a proposal was filed, and it stays
 * there afterwards the way any delivered thing does. If the cards were built from `pending` alone
 * they would silently VANISH the moment the question was answered in another window — which is
 * indistinguishable, to somebody halfway through reading one, from a render that broke. So the ids
 * seen here are kept, and only the ids: the content, the decidability and the three ways a card
 * goes stale are all conclusions about the read as it stands right now.
 *
 * Reloading the page forgets them, which is correct — a settled question needs no card.
 */
export function SessionCriteriaDecisionCard({
  projectId,
  onDecided,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  onDecided?: (line: string) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const [seen, setSeen] = useState<string[]>([]);
  const pending = useQuery({
    ...pendingCriteriaDecisionsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const queue = pending.data ?? null;
  useEffect(() => {
    if (!queue) return;
    const arrived = queue.pending.map((row) => row.intentId);
    setSeen((previous) => {
      const fresh = arrived.filter((intentId) => !previous.includes(intentId));
      return fresh.length === 0 ? previous : [...previous, ...fresh];
    });
  }, [queue]);

  const answer = useMutation({
    mutationFn: ({ row, decision }: { row: PendingCriteriaDecisionRow; decision: CriteriaDecision }) =>
      decideCriteriaChange(row, decision),
    onSuccess: (result) => {
      // The card that was answered HERE gives way to the line describing what it did: what is true
      // now is a fact about the criteria, and what happened is an event in this conversation. Left
      // on screen it would go stale into "answered at another end", which is the one reading of
      // its own answer this window can be sure is wrong.
      setSeen((previous) => previous.filter((intentId) => intentId !== result.intentId));
      onDecided?.(criteriaDecisionLine(result));
      void qc.invalidateQueries({
        queryKey: pendingCriteriaDecisionsQuery(projectId ?? '').queryKey,
      });
    },
  });

  if (!projectId || seen.length === 0) return null;
  return (
    <>
      {seen.map((intentId) => {
        const standing = criteriaDecisionStanding(pending.isError ? null : queue, intentId);
        return (
          <CriteriaDecisionCard
            key={intentId}
            standing={standing}
            busy={answer.isPending}
            error={answer.isError ? (answer.error as Error) : null}
            onDecide={(decision) => {
              if (standing.state !== 'DECIDABLE') return;
              answer.mutate({ row: standing.row, decision });
            }}
          />
        );
      })}
    </>
  );
}
