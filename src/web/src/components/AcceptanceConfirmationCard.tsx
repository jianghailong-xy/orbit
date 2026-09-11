import { useEffect, useId, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  confirmAcceptanceCriteria,
  readAcceptanceConfirmation,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import { CardActionButton, CardActions } from './CardAction';
import { PROVENANCE_LABEL, shortSeal } from './CriteriaDecisionCard';

/**
 * The settlement question, asked in the conversation it was delivered to: is this set of criteria,
 * together, what "done" means for the project?
 *
 * WHY IT IS A CARD IN THE COORDINATOR CONVERSATION
 * ------------------------------------------------
 * `CONFIRM_ACCEPTANCE_CRITERIA` is HUMAN_ONLY, and once every criterion is met it is the last thing
 * the project's DONE projection waits on. Its door refuses any request that carries an acting
 * session and takes the browser's own credential, so the answer is pressed here, straight at
 * `POST /projects/:id/acceptance/confirmation`, with no agent between the press and the door. This
 * is the browser's half of what iOS and macOS draw as `AcceptanceConfirmationCard`
 * (`ApprovalCards.swift`), and it carries the provenance mark the other two cards Orbit draws into
 * a conversation carry, for their reason: a transcript is where an agent's words appear.
 *
 * THE NATIVE CARD'S CONDITION, STATES AND WORDS
 * ---------------------------------------------
 * `settlementHeldOnConfirmation` is `ConsoleModel.settlementHeldOnConfirmation`: the standing can
 * be answered, the criteria are not empty, and every one of them is met by its work. That is
 * knowingly weaker than the server's `PROJECT_ACCEPTANCE_LANDED`, which also wants merge receipts,
 * so the card can arrive a little early and never late — and confirming early binds a version that
 * any later edit ends. The sentences are OrbitKit's `AcceptanceConfirmations`, copied by hand, and
 * `AcceptanceConfirmationCopyParityTests.swift` reads them back out of this file: the two clients
 * share no compiler, so a sentence re-worded at one end only turns nothing else red.
 *
 * DELIVERED ONCE, RE-DERIVED ON EVERY RENDER
 * ------------------------------------------
 * The card appears on the first render the condition holds and stays for as long as this
 * conversation is on screen, the way a native delivered card does: confirmed at another end, it
 * goes stale IN PLACE, with the button disabled and the reason above it, rather than vanishing
 * mid-read. Nothing about the set is kept across renders — the standing and the criteria are read
 * again each time — and a read that failed is not an answer: the card says it could not be
 * re-read and offers nothing to confirm, which is OrbitKit's rule for a standing it does not have.
 */

/** The card's heading: the question itself (`AcceptanceConfirmations.title`). */
export const ACCEPTANCE_CONFIRMATION_TITLE = 'Confirm what done means?';
export const ACCEPTANCE_CONFIRM_LABEL = 'Confirm — this is what done means';
/** Writes nothing: it puts the question down for as long as this conversation is on screen. */
export const ACCEPTANCE_NOT_YET_LABEL = 'Not yet';
/** The reading toggle once it is open, in `ApprovalCards.swift`'s own words. */
export const ACCEPTANCE_HIDE_CRITERIA_LABEL = 'Hide the criteria';
/** The provenance as the meta line spells it: OrbitKit's `CriteriaDecisions.provenanceLabel`. */
export const ACCEPTANCE_PROVENANCE = 'From Orbit';
export const ACCEPTANCE_PROVENANCE_TITLE =
  'Orbit composed this card from the project’s own reads and authorised its button. Nothing an '
  + 'agent typed can appear here, and confirming here does not go through one.';
/** How a stale standing's first line opens; a confirmation on record adds the seal it named. */
export const CONFIRMATION_CHANGED_SINCE =
  'The criteria changed after they were confirmed, so that confirmation no longer stands.';
export const CONFIRMATION_EDIT_ENDS_IT =
  'Editing any criterion ends this confirmation and Orbit will ask again.';
export const CONFIRMATION_UNREAD_EXPLANATION =
  'This card could not be re-read just now, so the version it would confirm cannot be named — and '
  + 'a confirmation that names no version is not one. The criteria themselves are untouched by this.';
/** What a press the door did not take says, over the door's own message. */
export const CONFIRMATION_NOT_RECORDED = 'That confirmation was not recorded';

/** One stated criterion, as much of it as this card reads — the narrow view OrbitKit's
 *  `ProjectCriteriaDocument` takes of the same document. `satisfied` is absent when the read
 *  declined to answer, which is not a yes. */
export interface ConfirmationCriterion {
  id: string;
  ordinal: number;
  text: string;
  satisfied?: boolean;
}

interface ConfirmationCriteriaDocument {
  acceptanceCriteriaItems?: ConfirmationCriterion[];
}

/** One line of the body: something that holds, or the one thing that does not. The open line is
 *  the question being asked, not a failure, which is why it is a question mark and not a cross. */
export interface AcceptanceConfirmationCheck {
  ok: boolean;
  text: string;
}

/** The reading toggle's label. It carries the count because the count is the thing confirmed: a
 *  person is agreeing that THESE N conditions, together, express the goal. */
export function acceptanceReadLabel(count: number): string {
  return count === 1 ? `Read the ${count} criterion` : `Read the ${count} criteria`;
}

/** Who is asking, about which version, and what is held on the answer. */
export function acceptanceConfirmationMeta(standing: StandardSetConfirmationStanding | null): string {
  if (!standing) return `${ACCEPTANCE_PROVENANCE} — the standing could not be read just now.`;
  const count = standing.currentVersion.material.length;
  const seal = shortSeal(standing.currentVersion.digest);
  return (
    `${ACCEPTANCE_PROVENANCE} — the set of ${count} at seal ${seal}. `
    + `Settlement is held on this.`
  );
}

/** The body: what holds, and the one thing that does not. The second line is never dropped — it
 *  is the mechanism, and the reason the card exists: nobody derives DONE from criteria alone. */
export function acceptanceConfirmationChecks(
  standing: StandardSetConfirmationStanding,
): AcceptanceConfirmationCheck[] {
  const count = standing.currentVersion.material.length;
  const rows: AcceptanceConfirmationCheck[] = [];
  switch (standing.state) {
    case 'UNCONFIRMED':
      rows.push({
        ok: false,
        text: `Nobody has confirmed that these ${count} express this project’s goal.`,
      });
      break;
    case 'STALE': {
      const prior = standing.confirmation;
      rows.push({
        ok: false,
        text: prior
          ? `${CONFIRMATION_CHANGED_SINCE} It named seal ${shortSeal(prior.criteriaDigest)}.`
          : CONFIRMATION_CHANGED_SINCE,
      });
      break;
    }
    case 'CONFIRMED':
      rows.push({
        ok: true,
        text:
          `These ${count} were confirmed to express this project’s goal, and the wording that `
          + `stands now is the wording that was confirmed.`,
      });
      break;
  }
  rows.push(
    standing.state === 'CONFIRMED'
      ? { ok: true, text: CONFIRMATION_EDIT_ENDS_IT }
      : {
          ok: false,
          text:
            `Orbit will not derive DONE until you say this set of ${count} is what `
            + `“done” means here.`,
        },
  );
  return rows;
}

/** Whether the confirm button may be pressed. Both un-confirmed states offer it, and it always
 *  sends the version standing NOW; a standing that could not be read offers nothing, because
 *  nobody can say which version a press would confirm. */
export function acceptanceConfirmationAnswerable(
  standing: StandardSetConfirmationStanding | null,
): boolean {
  return standing !== null && standing.state !== 'CONFIRMED';
}

/** Why the button is dead, or null while it is live: a reader looking at a disabled action is told
 *  which fact made it so. */
export function acceptanceConfirmationStaleExplanation(
  standing: StandardSetConfirmationStanding | null,
): string | null {
  if (!standing) return CONFIRMATION_UNREAD_EXPLANATION;
  if (standing.state !== 'CONFIRMED' || standing.confirmation === null) return null;
  const seal = shortSeal(standing.confirmation.criteriaDigest);
  return (
    `Already confirmed, at another end, for seal ${seal} — the version standing now. `
    + `There is nothing left to answer here; editing any criterion ends that confirmation `
    + `and Orbit will ask again.`
  );
}

/** What a confirmation pressed on this card leaves where its actions were. */
export function acceptanceConfirmedLine(standing: StandardSetConfirmationStanding): string {
  const count = standing.currentVersion.material.length;
  const seal = shortSeal(standing.currentVersion.digest);
  return `You confirmed the standard set — ${count} criteria at seal ${seal}`;
}

/**
 * Whether the owner's confirmation is the LAST thing settlement is waiting on, read off the
 * confirmation standing and the project document — null for either one that could not be read.
 *
 * The confirmation is lazy on purpose: asked at the last moment rather than the first, so a card
 * offered while half the criteria are unmet would be a standing interruption in every coordinator
 * conversation from the day the project was created.
 */
export function settlementHeldOnConfirmation(
  standing: StandardSetConfirmationStanding | null,
  criteria: ConfirmationCriterion[] | null,
): boolean {
  if (!acceptanceConfirmationAnswerable(standing)) return false;
  if (criteria === null || criteria.length === 0) return false;
  return criteria.every((criterion) => criterion.satisfied === true);
}

/**
 * The card. Presentational apart from whether its criteria are open: it issues no request, so a
 * render can assert what each standing puts on screen.
 *
 * The confirm action is `CardAction`'s, under its one rule — an action that cannot succeed is
 * `disabled` rather than lit-and-refused. `Not yet` and the reading toggle write nothing and are
 * never disabled, as on the native card: putting a question down, or reading what it is about, is
 * available whatever the server says about it.
 */
export function AcceptanceConfirmationCard({
  standing,
  criteria,
  busy = false,
  error = null,
  recorded = null,
  onConfirm,
  onSetAside,
}: {
  /** The confirmation standing, or null when it could not be read. */
  standing: StandardSetConfirmationStanding | null;
  /** The stated criteria, or null when the project document could not be read. */
  criteria: ConfirmationCriterion[] | null;
  /** A press from this card is on its way to the door, or the re-read after a refusal is. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  /** The door's answer to a confirmation pressed HERE, once there is one. */
  recorded?: StandardSetConfirmationStanding | null;
  onConfirm: () => void;
  onSetAside: () => void;
}): JSX.Element {
  const listId = useId();
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const answerable = acceptanceConfirmationAnswerable(standing);
  // A confirmation given here is not one given "at another end", which is the one reading of its
  // own answer this card can be sure is wrong.
  const stale = recorded ? null : acceptanceConfirmationStaleExplanation(standing);
  const items = [...(criteria ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <div className="approval-card settlement-card">
      <div className="approval-head settlement-card-head">
        <span className="settlement-card-heading">{ACCEPTANCE_CONFIRMATION_TITLE}</span>
        <span className="criteria-provenance" title={ACCEPTANCE_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions settlement-card-body">
        <div className="settlement-card-meta">{acceptanceConfirmationMeta(standing)}</div>
        {standing ? (
          <ul className="settlement-card-checks">
            {acceptanceConfirmationChecks(standing).map((check) => (
              <li key={check.text} className={check.ok ? 'is-held' : 'is-open'}>
                <span className="settlement-card-mark" aria-hidden>
                  {check.ok ? '✓' : '?'}
                </span>
                <span>{check.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {stale ? <p className="settlement-card-stale">{stale}</p> : null}
        {/* The set itself. Load-bearing rather than decorative: this card sits alone in a
            transcript, and confirming a set the reader cannot read is exactly the "signed unread"
            the version digest exists to prevent. */}
        {criteriaOpen && items.length > 0 ? (
          <ol id={listId} className="settlement-card-criteria">
            {items.map((item) => (
              <li key={item.id} value={item.ordinal}>
                {item.text}
              </li>
            ))}
          </ol>
        ) : null}
        {error ? (
          <Alert
            className="settlement-card-error"
            type="error"
            showIcon
            message={CONFIRMATION_NOT_RECORDED}
            description={error.message}
          />
        ) : null}
        {recorded ? (
          <div className="settlement-card-recorded">{acceptanceConfirmedLine(recorded)}</div>
        ) : null}
      </div>
      {recorded ? null : (
        <CardActions className="approval-actions settlement-card-actions">
          <CardActionButton tone="primary" disabled={busy || !answerable} onClick={onConfirm}>
            {ACCEPTANCE_CONFIRM_LABEL}
          </CardActionButton>
          {/* Absent while the criteria could not be read: a control that would open nothing is
              not one. */}
          {items.length > 0 ? (
            <CardActionButton
              tone="secondary"
              expanded={criteriaOpen}
              controls={criteriaOpen ? listId : undefined}
              onClick={() => setCriteriaOpen((open) => !open)}
            >
              {criteriaOpen ? ACCEPTANCE_HIDE_CRITERIA_LABEL : acceptanceReadLabel(items.length)}
            </CardActionButton>
          ) : null}
          <CardActionButton tone="secondary" onClick={onSetAside}>
            {ACCEPTANCE_NOT_YET_LABEL}
          </CardActionButton>
        </CardActions>
      )}
    </div>
  );
}

/**
 * The wired card for one conversation: at most one, delivered the first time settlement is held on
 * the owner's confirmation, and re-derived from both reads on every render after that.
 *
 * The standing is read under `acceptanceConfirmationKey` and the criteria under the project page's
 * own `['project', id]`, so a confirmation pressed on either surface redraws the other from the
 * door's answer. A press sends `currentVersion.digest` from the read the card is drawn from; the
 * door refuses a version that moved in between, and the answer to that refusal is to read the set
 * again — so a refusal re-reads, and the card stays busy until that read has landed.
 */
export function SessionAcceptanceConfirmationCard({
  projectId,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = projectId ?? '';
  const [delivered, setDelivered] = useState(false);
  const [setAside, setSetAside] = useState(false);
  const standingRead = useQuery({
    queryKey: acceptanceConfirmationKey(project),
    queryFn: () => readAcceptanceConfirmation(project),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () =>
      api<ConfirmationCriteriaDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // A read that failed is not an answer, whatever an earlier read said.
  const standing = standingRead.isError ? null : (standingRead.data ?? null);
  const criteria = documentRead.isError
    ? null
    : (documentRead.data?.acceptanceCriteriaItems ?? null);
  const held = settlementHeldOnConfirmation(standing, criteria);
  useEffect(() => {
    if (held) setDelivered(true);
  }, [held]);

  const confirm = useMutation({
    mutationFn: (criteriaDigest: string) => confirmAcceptanceCriteria(project, criteriaDigest),
    // The door returns the standing it just wrote: every surface on this key redraws from that.
    onSuccess: (next) => {
      qc.setQueryData(acceptanceConfirmationKey(project), next);
    },
    // Returned rather than fired off, so the button stays disabled until the read it re-derives
    // from has caught up with the refusal.
    onError: () => qc.invalidateQueries({ queryKey: acceptanceConfirmationKey(project) }),
  });

  if (setAside || !(delivered || held)) return null;
  return (
    <AcceptanceConfirmationCard
      standing={standing}
      criteria={criteria}
      busy={confirm.isPending}
      error={confirm.isError ? confirm.error : null}
      recorded={confirm.isSuccess ? confirm.data : null}
      onConfirm={() => {
        if (standing === null || !acceptanceConfirmationAnswerable(standing)) return;
        confirm.mutate(standing.currentVersion.digest);
      }}
      onSetAside={() => setSetAside(true)}
    />
  );
}
