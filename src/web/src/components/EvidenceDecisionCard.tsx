import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { api } from '../api';
import { decisionReceiptAnchor } from '../lib/decisionReceipt';
import { pendingDecisionsQuery, taskEvidenceQuery } from '../lib/queries';
import { CardActionButton, CardActions } from './CardAction';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';
// The word this card's second action uses. Imported rather than re-declared, and read inside the
// component rather than bound at module scope: `OwnerConfirmationCard` reaches this module for
// `decisionReceiptTime`, so a top-level alias would be evaluated while that binding is still in
// its temporal dead zone depending on which of the two a bundle enters first. Same arrangement,
// and the same reason, as the settlement card's.
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import {
  decisionRowKey,
  type PendingDecisionQueue,
  type PendingDecisionRow,
  type RecordedDecisionRow,
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
 * AND ONE PLACE TO TYPE
 * ---------------------
 * The send-back's reason is an ordinary message to this conversation, and the composer at the
 * bottom of the screen already is one. So the second action grows no box: it arms that composer
 * (`WorkspaceView`'s `replyTo`), the bar there names what the next send answers, and that send
 * reaches this door as SEND_BACK + note instead of starting a turn. The card stays through it,
 * with `Confirm done` still live. The words the button uses are the ones the four other cards
 * that make this handoff use, because it is one control doing one thing.
 *
 * ONE ENTRY FOR ONE QUESTION
 * --------------------------
 * This is the only place on the web a verdict about evidence is pressed. `ApprovalPanel` takes no
 * AskUserQuestion for one — a question offering `Confirm completion` / `Send back` is an ordinary
 * question form — and the pinned strip points here instead of answering (`DecisionRail.tsx`). Two
 * entries for one question raced on 2026-09-09, and the loser came back
 * `EVIDENCE_JUDGMENT_ALREADY_DECIDED`.
 */

/** The card's heading. */
export const DECISION_ASK_HEADING = 'Does this evidence settle the task?';
/** 'Confirm done' submits on the click itself. The generic form's pick-then-Submit exists for a form
 *  with several questions and several picks per question; in a two-way judgment it buys nothing
 *  but one more click between a reader and the thing they already decided. */
export const DECISION_CONFIRM_ACTION = 'Confirm done';
/** What the RECORD calls the second answer: the receipt line and the `Decision recorded` line quote
 *  it (`Send back · rev 2 · 09:31`). Deliberately not what the BUTTON says — the button says
 *  `Chat about this`, the word the four other cards that hand their reply to the composer use
 *  (`OWNER_SEND_BACK_ACTION`), because it is one control doing one thing. The record keeps the
 *  answer's own name, as the confirmation card's does (`Asked for more`). */
export const DECISION_SEND_BACK_ACTION = 'Send back';
/** What the composer's bar says it is about to send back, ahead of the task's own title. */
export const DECISION_SENDING_BACK_PREFIX = 'Sending back: ';
/** What the armed composer asks for. The door refuses a SEND_BACK carrying no note and writes
 *  nothing at all, and that note is what the next revision has to answer — so the box asks for
 *  exactly that, in the words the door's own refusal action uses. */
export const DECISION_SEND_BACK_LABEL = 'What does the next version have to show?';
/** What the second action promises, printed under the buttons rather than hidden in its tooltip: a
 *  touch screen has no hover, and a reader who cannot see this cannot tell whether pressing it
 *  closes the task. Two facts, and no third: where the sentence goes, and that nothing is settled
 *  by it. It is the same sentence the confirmation card prints, for its own door. */
export const DECISION_SEND_BACK_HINT =
  'Your next message is sent back as the reason — the only thing the next attempt can aim at. '
  + 'The task stays open.';
/** The gaps that did not fit, counted rather than dropped: they are the body of this card. */
export const decisionGapsMore = (rest: number): string => `${rest} more`;
/** Evidence from before the envelope has no claim at all; the line says so rather than rendering
 *  a blank where the card's lead should be. */
export const DECISION_NO_CLAIM = 'This version of the evidence states no claim.';
export const DECISION_NO_CRITERION = 'no acceptance criterion cited';
export const DECISION_NO_GAPS = 'the submitter declares nothing missing';
/** The heading over the criterion's own text. The question this card asks is whether this evidence
 *  settles THAT sentence, and a key is not a sentence — so the text leads the card and the key
 *  stays in the meta line, where identity belongs. */
export const DECISION_CRITERION_HEADING = 'WHAT IT HAS TO SATISFY';
/** The submitter's own account, folded to one line with its length: the longest field on the card
 *  and the least decisive, kept whole and one press away. */
export const decisionClaimFold = (chars: number): string =>
  `the submitter’s full account (${chars} characters)`;
export const DECISION_CLAIM_HIDE = 'Hide the account';

/** How many gaps the card shows before it starts counting. Three is what fits on a phone above the
 *  actions; the rest are one press away and the count is never hidden. */
const DECISION_GAPS_SHOWN = 3;
/** Where a claim stops being shown at rest. A claim is one sentence in the good case and a
 *  thousand-word implementation log in the bad one (measured: 1941 characters, 16× this number),
 *  and the bad one must not push the standard, the gaps and the actions off the screen — so past
 *  this length the account folds to a line saying how much of it there is. */
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
      text: 'the criterion it cites is still the live one',
      detail: row.decidability.decidable
        ? (row.criterion ? `${row.criterion.key} · ${row.criterion.text}` : null)
        : row.decidability.refusal,
    },
    {
      ok: row.citations.length > 0 && unresolved.length === 0,
      text: `${resolved.length}/${row.citations.length} citations resolved`,
      detail:
        unresolved.length === 0
          ? null
          : unresolved.map((citation) => `${citation.ref}: ${citation.reason ?? 'unresolved'}`).join('\n'),
    },
    {
      ok: row.independence.independent,
      text: 'the decider is independent of this submission',
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
      {/* The sentence being judged, in its own words and first. A reader asked whether this
          evidence settles a criterion cannot answer from the criterion's KEY, which is all this
          card used to carry — the text was two disclosures down, inside a machine check's detail. */}
      <div className="decision-ask-standard">
        <div className="decision-ask-standard-head">{DECISION_CRITERION_HEADING}</div>
        <div className="decision-ask-standard-text">
          {row.criterion ? (
            row.criterion.text
          ) : (
            <span className="decision-ask-quiet">{DECISION_NO_CRITERION}</span>
          )}
        </div>
      </div>

      {/* The body of the card. What the submitter says they did NOT establish is the part most
          likely to change the answer, so a narrow screen gives up everything folded below it
          before it gives up any of this — and what does not fit is COUNTED rather than dropped,
          one press from being read. */}
      <div className="decision-ask-gaps">
        <div className="decision-ask-gaps-head">
          {row.gaps.length === 0
            ? DECISION_NO_GAPS
            : `WHAT THIS EVIDENCE DOES NOT ESTABLISH · ${row.gaps.length}`}
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
              {gapsOpen ? 'Show less' : decisionGapsMore(restGaps.length)}
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
          {`${held} checked for you`}
          {held === checks.length ? '' : ` · ${checks.length - held} did not hold`}
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

      {/* The submitter's own account, last and folded when it is long. It used to lead the card,
          which put a paragraph of implementation detail between the reader and the gaps — the part
          most likely to change the answer — and the actions. A short one is still read where it
          stands; a long one is a line naming its own length. */}
      <div className="decision-ask-account">
        {claim === '' ? (
          <span className="decision-ask-quiet">{DECISION_NO_CLAIM}</span>
        ) : longClaim ? (
          <>
            <button
              type="button"
              className="decision-ask-toggle"
              aria-expanded={claimOpen}
              onClick={() => setClaimOpen(!claimOpen)}
            >
              {claimOpen ? DECISION_CLAIM_HIDE : decisionClaimFold(claim.length)}
              <span className="decision-ask-caret" aria-hidden="true">{claimOpen ? '▴' : '▾'}</span>
            </button>
            {claimOpen && <div className="decision-ask-claim">{claim}</div>}
          </>
        ) : (
          <div className="decision-ask-claim">{claim}</div>
        )}
      </div>

      <div className="decision-ask-meta">
        {`${row.taskId} · rev ${row.evidenceRevision} · `}
        {row.criterion ? row.criterion.key : DECISION_NO_CRITERION}
      </div>
    </>
  );
}

/**
 * The two verdicts: confirm on one press, or say why it is going back — through the composer.
 *
 * There is no third: a press goes to the door, and not deciding yet is simply not pressing.
 *
 * WHY THE SECOND ONE OWNS NO BOX
 * ------------------------------
 * The reason is an ordinary message to this conversation, and the composer at the bottom of the
 * screen already is one. So `Chat about this` grows no textarea here: it arms that composer, the
 * bar there names what the next send answers, and that send reaches the decision door as
 * SEND_BACK + note instead of starting a turn. The door's "no note, no write" rule becomes the
 * composer's own refusal to send an empty line. Two places on screen taking the same sentence is
 * what this avoids — and it is the handoff the other four cards make.
 */
export function EvidenceDecisionActions({
  disabled,
  onConfirm,
  onChatAbout,
}: {
  /** Whether no answer from here could succeed right now. Every control below follows it. */
  disabled: boolean;
  onConfirm: () => void;
  /** Hand the reply to the composer; the reason is whatever is sent next. */
  onChatAbout: () => void;
}): JSX.Element {
  return (
    <>
      <CardActions className="decision-ask-actions">
        <CardActionButton tone="primary" disabled={disabled} onClick={onConfirm}>
          {DECISION_CONFIRM_ACTION}
        </CardActionButton>
        <CardActionButton tone="secondary" disabled={disabled} onClick={onChatAbout}>
          {OWNER_SEND_BACK_ACTION}
        </CardActionButton>
      </CardActions>
      {/* Under the buttons and not inside the second one's tooltip, for the reason the
          confirmation card gives: a touch screen never shows a hover. */}
      <div className="decision-ask-hint">{DECISION_SEND_BACK_HINT}</div>
    </>
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
  'Orbit drew this card from the pending read; no agent typed it into the conversation. The task '
  + 'title, the claim and the gaps are the record’s own words. The buttons are Orbit’s, and a '
  + 'press goes straight to the decision door with your own sign-in, through no agent.';

/** The heading a card that can no longer be answered carries instead of `DECISION_ASK_HEADING`. */
export const EVIDENCE_DECISION_STALE_HEADING = 'This evidence is no longer waiting on you';
/** And the one for a card this browser could not re-derive just now. */
export const EVIDENCE_DECISION_UNREAD_HEADING = 'This card could not be re-read just now';
/** And the one for a card this reader has just answered. */
export const EVIDENCE_DECISION_RECORDED_HEADING = 'Decision recorded';

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
        `Superseded: this task has submitted version ${standing.replacement.evidenceRevision} of its `
        + `evidence since, and the door decides only the latest — any decision about version `
        + `${standing.address.evidenceRevision} would be refused (${EVIDENCE_DECISION_SUPERSEDED}). `
        + `Nothing was recorded here; version ${standing.replacement.evidenceRevision} has its own card.`
      );
    case 'ALREADY_DECIDED':
      return (
        'Already answered: this version is no longer pending, its decision was recorded somewhere '
        + `else, and a decision sent from this card would be refused (${EVIDENCE_DECISION_ALREADY_DECIDED}). `
        + 'This card recorded nothing for you, and cannot change what was.'
      );
    case 'UNREAD':
      return (
        'The pending read did not come back just now, so this card cannot say what it is asking. '
        + 'It keeps no copy of the evidence — every line is re-derived from the read — and a decision '
        + 'the door might refuse is not offered. The evidence itself is unaffected.'
      );
  }
}

/** A refusal of a press, said as staleness when that is what the door's code means. */
export function evidenceDecisionRefusal(error: Error): { stale: boolean; title: string } {
  // Duck-typed: `api()` rejects with an `ApiError` carrying the body's `code`, and nothing else
  // about the error class matters here.
  const code = (error as { code?: unknown }).code;
  if (code === EVIDENCE_DECISION_ALREADY_DECIDED) {
    return { stale: true, title: 'Not recorded: already answered elsewhere — this card is out of date' };
  }
  if (code === EVIDENCE_DECISION_SUPERSEDED) {
    return { stale: true,
      title: 'Not recorded: a newer version superseded this one — this card is out of date' };
  }
  return { stale: false, title: 'Not recorded' };
}

/** What an answer given from this card leaves on it: the door's receipt, in the card's own words. */
export function evidenceDecisionRecordedLine(result: EvidenceDecisionResult): string {
  const action =
    result.decision === 'CONFIRM' ? DECISION_CONFIRM_ACTION : DECISION_SEND_BACK_ACTION;
  const line = `Recorded: ${action} · rev ${result.evidenceRevision}`;
  return result.note ? `${line} — ${result.note}` : line;
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
  onConfirm,
  onChatAbout,
}: {
  standing: EvidenceDecisionStanding;
  /** A press from this card is on its way to the door. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  /** The door's receipt for an answer given from this card, once there is one. */
  recorded?: EvidenceDecisionResult | null;
  /** `Confirm done` presses the door from here. The other answer does not: it arms the composer,
   *  and the door is pressed by the send that follows. */
  onConfirm: () => void;
  onChatAbout: () => void;
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
              onConfirm={onConfirm}
              onChatAbout={onChatAbout}
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

/**
 * One card and its own press: busy, refused and recorded belong to the card that was pressed.
 *
 * The press it makes is `Confirm done` only. A send-back is pressed at the composer, one level up,
 * so its busy, its refusal and its receipt belong to that press — this card is armed and left
 * standing, and its own confirm stays live.
 */
function EvidenceDecisionSlot({
  sessionId,
  standing,
  onSendBack,
}: {
  sessionId: string;
  standing: EvidenceDecisionStanding;
  /** Hand this version back to the composer to say why. */
  onSendBack: (row: PendingDecisionRow) => void;
}): JSX.Element {
  const qc = useQueryClient();
  const answer = useMutation({
    mutationFn: (row: PendingDecisionRow) => sendEvidenceDecision(row, sessionId, 'CONFIRM'),
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
      onConfirm={() => {
        if (standing.state !== 'DECIDABLE') return;
        answer.mutate(standing.row);
      }}
      onChatAbout={() => {
        if (standing.state !== 'DECIDABLE') return;
        onSendBack(standing.row);
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
  onSendBack,
}: {
  /** The session a press decides FROM, and the one the pending read is scoped to. */
  sessionId: string;
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  /** Arm the bottom composer to send this version back, given the row it is about: it is handed
   *  the row, and the send that follows presses the door with the typed reason. The card stays
   *  put, with its own `Confirm done` still live — pressing that is the other way out. */
  onSendBack: (row: PendingDecisionRow) => void;
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
  // A version this conversation has decided is drawn in the transcript as its receipt, at the
  // moment it was decided (`EvidenceDecisionReceipt`), so its card goes — the one just pressed
  // included, which would otherwise sit under that receipt saying the same thing.
  const receipted = new Set((queue?.decided ?? []).map(decisionRowKey));
  const addresses = [
    ...seen,
    ...evidenceDecisionCardRows(queue, projectId)
      .filter((row) => !known.has(decisionRowKey(row)))
      .map((row) => ({ taskId: row.taskId, evidenceRevision: row.evidenceRevision })),
  ].filter((address) => !receipted.has(decisionRowKey(address)));
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
          onSendBack={onSendBack}
        />
      ))}
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE RECEIPT
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/** A receipt's heading when a run of this session, rather than the owner, recorded the decision. */
export const EVIDENCE_DECISION_AGENT_RECORDED_HEADING = 'An agent recorded a decision';
/** The fold over the evidence a receipt answered, and what it says while that is read. */
export const DECISION_RECEIPT_OPEN = 'Show the claim and the gaps';
export const DECISION_RECEIPT_LOADING = 'Reading…';
export const DECISION_RECEIPT_UNREAD = 'This version of the evidence could not be read back just now.';
export const DECISION_RECEIPT_REASON = 'the reason it was sent back';

/** When a receipt says it was decided: the clock on the day it happened, the date as well after. */
export function decisionReceiptTime(decidedAt: string, now: Date = new Date()): string {
  const at = new Date(decidedAt);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** The receipt's line: which answer, to which version, and when. */
export function decisionReceiptLine(decided: RecordedDecisionRow, now?: Date): string {
  const action = decided.decision === 'CONFIRM' ? DECISION_CONFIRM_ACTION : DECISION_SEND_BACK_ACTION;
  return `${action} · rev ${decided.evidenceRevision} · ${decisionReceiptTime(decided.decidedAt, now)}`;
}

/** The claim and gaps of the revision a receipt answered, read out of its stored envelope. */
function receiptFacts(evidence: Record<string, unknown> | undefined): { claim: string; gaps: string[] } {
  const claim = evidence?.claim;
  const gaps = evidence?.gaps;
  return {
    claim: typeof claim === 'string' ? claim.trim() : '',
    gaps: Array.isArray(gaps) ? gaps.filter((gap): gap is string => typeof gap === 'string') : [],
  };
}

/**
 * What a decision recorded from this conversation leaves in it, drawn where the decision was made.
 *
 * WHY THIS IS NOT THE CARD
 * ------------------------
 * A card's question leaves the pending read the moment it is answered, and the card remembered it
 * only for as long as the page did — so a reload took the decision out of the conversation
 * altogether. A receipt is drawn from the decision row (`decided` on the same read), which every
 * reload and every device reads back, and it is folded to one line because it is a record now, not
 * a question. The evidence it answered is fetched only when it is opened: receipts ride every poll
 * of the pending read, and the claim and gaps do not need to.
 */
export function EvidenceDecisionReceipt({ decided }: { decided: RecordedDecisionRow }): JSX.Element {
  const [open, setOpen] = useState(false);
  const revisions = useQuery({ ...taskEvidenceQuery(decided.taskId), enabled: open });
  const answered = revisions.data?.find((each) => each.revision === decided.evidenceRevision);
  const facts = answered ? receiptFacts(answered.evidence) : null;
  return (
    <div
      className="approval-card decision-ask evidence-decision evidence-decision-receipt"
      data-decision-receipt={decisionRowKey(decided)}
    >
      <div className="approval-head decision-ask-head">
        <span className="evidence-decision-receipt-mark" aria-hidden="true">✓</span>
        <span className="evidence-decision-heading">
          {decided.decidedByType === 'AGENT'
            ? EVIDENCE_DECISION_AGENT_RECORDED_HEADING
            : EVIDENCE_DECISION_RECORDED_HEADING}
        </span>
        <span className="criteria-provenance" title={EVIDENCE_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions decision-ask-body">
        <section className="decision-ask-q">
          <div className="decision-ask-chip">{decided.title}</div>
          <div className="decision-ask-picked">{decisionReceiptLine(decided)}</div>
          {decided.note ? (
            <div className="decision-ask-picked">{`${DECISION_RECEIPT_REASON}：${decided.note}`}</div>
          ) : null}
          <button
            type="button"
            className="decision-ask-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Show less' : `${DECISION_RECEIPT_OPEN} ▾`}
          </button>
          {!open ? null : revisions.isPending ? (
            <div className="decision-ask-quiet">{DECISION_RECEIPT_LOADING}</div>
          ) : facts === null ? (
            <p className="evidence-decision-stale">{DECISION_RECEIPT_UNREAD}</p>
          ) : (
            <>
              <div className="decision-ask-claim">
                {facts.claim === '' ? (
                  <span className="decision-ask-quiet">{DECISION_NO_CLAIM}</span>
                ) : (
                  facts.claim
                )}
              </div>
              <div className="decision-ask-gaps">
                <div className="decision-ask-gaps-head">
                  {facts.gaps.length === 0
                  ? DECISION_NO_GAPS
                  : `WHAT THIS EVIDENCE DOES NOT ESTABLISH · ${facts.gaps.length}`}
                </div>
                {facts.gaps.length > 0 && (
                  <ul className="decision-ask-gaps-list">
                    {facts.gaps.map((gap, k) => (
                      <li key={k}>{gap}</li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
