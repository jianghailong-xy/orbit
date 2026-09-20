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
// The words this card's second action uses. Imported rather than re-declared, and read inside the
// component rather than bound at module scope: `OwnerConfirmationCard` reaches this module again
// through `DecisionRail`, and a top-level alias would be evaluated while that binding is still in
// its temporal dead zone depending on which of the three a bundle enters first.
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

/**
 * The settlement question, asked in the conversation it was delivered to, at the moment it can
 * still change something: this is the plan — these N conditions — so shall the project start?
 *
 * WHY IT IS A CARD IN THE COORDINATOR CONVERSATION
 * ------------------------------------------------
 * `CONFIRM_ACCEPTANCE_CRITERIA` is HUMAN_ONLY, and the same press that records the confirmation
 * turns the project on (`project-acceptance.service.ts`: `coordinatorEnabled` is written by no
 * other hand). Its door refuses any request that carries an acting session and takes the browser's
 * own credential, so the answer is pressed here, straight at
 * `POST /projects/:id/acceptance/confirmation`, with no agent between the press and the door. This
 * is the browser's half of what iOS and macOS draw as `AcceptanceConfirmationCard`
 * (`ApprovalCards.swift`), and it carries the provenance mark the other two cards Orbit draws into
 * a conversation carry, for their reason: a transcript is where an agent's words appear.
 *
 * WHY IT ARRIVES BEFORE THE WORK AND NOT AFTER IT
 * -----------------------------------------------
 * `settlementHeldOnConfirmation` used to wait until every criterion was met by its work, and that
 * is the moment the question is worth least: answering "no" then annuls work already done, so the
 * card could only ever be agreed with, and 20 of the 28 projects that reached DONE had gone round
 * it entirely. It is asked now at the one moment the answer is cheap — the plan is written and
 * nothing has run — so `satisfied` no longer enters the condition at all: an OPEN project, a set
 * that is not empty, at least one task filed under it, and a standing nobody has confirmed. The
 * criteria are on the card unfolded, because a digest can prove WHICH version was signed and never
 * that it was read.
 *
 * The sentences are OrbitKit's `AcceptanceConfirmations`, copied by hand, and
 * `AcceptanceConfirmationCopyParityTests.swift` reads them back out of this file: the two clients
 * share no compiler, so a sentence re-worded at one end only turns nothing else red.
 *
 * DELIVERED ONCE, RE-DERIVED ON EVERY RENDER
 * ------------------------------------------
 * The card appears on the first render the condition holds and stays for as long as this
 * conversation is on screen, the way a native delivered card does: started at another end, it goes
 * stale IN PLACE, with the button disabled and the reason above it, rather than vanishing mid-read.
 * Nothing about the set is kept across renders — the standing and the project are read again each
 * time — and a read that failed is not an answer: the card says it could not be re-read and offers
 * nothing to start, which is OrbitKit's rule for a standing it does not have. Editing any criterion
 * ends the confirmation, and the card comes back for the new version on the same condition.
 *
 * WHAT THE PINNED STRIP IS TOLD
 * -----------------------------
 * Whether this card is on screen and its question is still unanswered (`onOpenQuestion`), which is
 * what iOS's needs-you bar counts. The card reports it rather than the strip reading the standing
 * again, because being on screen is this card's own state: delivered once, and still there —
 * stale — after the set was confirmed at another end.
 */

/** The card's heading: what the card is about, not whether it has been answered
 *  (`AcceptanceConfirmations.title`). */
export const ACCEPTANCE_CONFIRMATION_TITLE = 'When is this project done?';
/** The primary action. One press: it records the confirmation AND starts the project, because
 *  saying what would settle a project is what authorises work on it. */
export const ACCEPTANCE_START_LABEL = 'Start the project';
/** The reading toggle once the criteria are shown whole. */
export const ACCEPTANCE_SHOW_LESS_LABEL = 'Show less';
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
/** Where the project stands, as the meta line's third field says it: read off `coordinatorEnabled`
 *  — the column that decides whether Orbit hands this project's tasks out, and which
 *  `project-acceptance.service.ts` writes by no other hand — and off nothing else. Confirming turns
 *  it on for a project started since that was wired, and says nothing whatever about one that was
 *  already dispatching work when it landed. */
export const ACCEPTANCE_NOT_STARTED = 'not started';
export const ACCEPTANCE_STARTED = 'started';
/** …and what that field says when the project itself could not be read. A failed read is not an
 *  answer, and guessing "not started" at a project that is handing work out is the one thing this
 *  field was taken off the standing to stop saying. */
export const ACCEPTANCE_START_NOT_READ = 'start not read';
/** Where the CONFIRMATION stands, as the meta line's fourth field says it. The other question
 *  entirely, and the only one the standing answers: whether anybody has said what done means here,
 *  and whether that is still the plan. */
export const ACCEPTANCE_CONFIRMED = 'confirmed';
export const ACCEPTANCE_CHANGED_SINCE_CONFIRMED = 'changed since it was confirmed';
export const ACCEPTANCE_NOBODY_SAID_DONE = 'nobody has said what done means';
/** What the composer's bar says it is about to talk about, ahead of the project's own title. */
export const ACCEPTANCE_PLAN_CHANGE_PREFIX = 'Talking about this plan: ';
/** What the armed composer asks for. A message, not an answer: no door is waiting on it. */
export const ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER = 'What should done mean instead?';
export const CONFIRMATION_UNREAD_EXPLANATION =
  'This card could not be re-read just now, so the version it would confirm cannot be named — and '
  + 'a confirmation that names no version is not one. The criteria themselves are untouched by this.';
/** What a press the door did not take says, over the door's own message. */
export const CONFIRMATION_NOT_RECORDED = 'That confirmation was not recorded';

/**
 * What the next send carries ahead of the typed message: the plan as it stands, named by its seal.
 *
 * The other three armed replies answer a call that is blocking on them, so their door already knows
 * what the reply is about. This one starts an ordinary turn at an idle agent, which knows none of
 * it — so the version being discussed rides with the message rather than being looked up, and the
 * seal is in it so a reply about a set that has since moved can be told apart from one about this
 * one.
 */
export function acceptancePlanChangeContext(plan: {
  projectTitle: string;
  criteriaDigest: string;
  criteria: string[];
}): string {
  const numbered = plan.criteria.map((text, index) => `${index + 1}. ${text}`).join('\n');
  return (
    `About the acceptance criteria of “${plan.projectTitle}” — the ${plan.criteria.length} that `
    + `stand now, at seal ${shortSeal(plan.criteriaDigest)}, which nobody has confirmed and which `
    + `no work has started against:\n\n${numbered}`
  );
}

/** One stated criterion, as much of it as this card reads — the narrow view OrbitKit's
 *  `ProjectCriteriaDocument` takes of the same document. `satisfied` is absent when the read
 *  declined to answer, which is not a yes. */
export interface ConfirmationCriterion {
  id: string;
  ordinal: number;
  text: string;
  satisfied?: boolean;
}

/** As much of the project document as this card reads: the stated criteria, the title the meta
 *  line names it by, the status the card's own condition turns on, and whether the project has
 *  been started. */
export interface ConfirmationProjectDocument {
  title?: string;
  status?: string;
  /** Whether Orbit is handing this project's tasks out. `/projects/:id` carries it already —
   *  `withCoordination` spreads the column through in `...rest` — so the meta line's "started"
   *  costs this card no request of its own. Absent from a read that did not say, which is not a
   *  "no": it is the one thing this field must never be read as. */
  coordinatorEnabled?: boolean;
  /** How many tasks this project holds, off the same read's own `_count.tasks` — the total the
   *  project list shows, not a second count of this card's. Absent is read as none, which is where
   *  this field parts company with the one above: `coordinatorEnabled` LABELS the project and has a
   *  third word for a read that did not answer, while this one GATES an action, and a gate nobody
   *  can establish stays shut (`acceptanceConfirmationAnswerable` above, for the same reason). */
  _count?: { tasks?: number };
  acceptanceCriteriaItems?: ConfirmationCriterion[];
}

/** The reading toggle's label. It carries the count because the count is the thing confirmed: a
 *  person is agreeing that THESE N conditions, together, express the goal. */
export function acceptanceReadLabel(count: number): string {
  return `Read all ${count} in full`;
}

/** Which project, how many conditions, whether it has been started, whether anybody has said what
 *  done means, and which version of them — in that order. The seal is last because it answers a
 *  question nobody has until they have read the rest: it names the version a press binds, and
 *  proves nothing about having read it.
 *
 *  TWO FIELDS BECAUSE THEY ARE TWO FACTS
 *  -------------------------------------
 *  One field used to answer both, off the standing alone: unconfirmed was printed "not started".
 *  That holds only for a project created since confirming became the press that starts one — for
 *  the projects that were already here it is simply a different question, and on 2026-09-18 seven
 *  OPEN projects were handing work out with no confirmation ever recorded. The card said "not
 *  started" about every one of them. So `started` is read off the project and `asked` off the
 *  standing, and neither is inferred from the other. */
export function acceptanceConfirmationMeta(
  standing: StandardSetConfirmationStanding | null,
  started: boolean | null,
  projectTitle: string,
): string {
  if (!standing) return `${projectTitle} — the standing could not be read just now.`;
  const count = standing.currentVersion.material.length;
  const stands =
    started === null
      ? ACCEPTANCE_START_NOT_READ
      : started
        ? ACCEPTANCE_STARTED
        : ACCEPTANCE_NOT_STARTED;
  const asked =
    standing.state === 'CONFIRMED'
      ? ACCEPTANCE_CONFIRMED
      : standing.state === 'STALE'
        ? ACCEPTANCE_CHANGED_SINCE_CONFIRMED
        : ACCEPTANCE_NOBODY_SAID_DONE;
  return (
    `${projectTitle} · ${count} criteria · ${stands} · ${asked} · seal ${shortSeal(standing.currentVersion.digest)}`
  );
}

/** The one paragraph the card keeps: what starting binds the project to, and what ends it. It is
 *  never dropped — it is the mechanism, and the reason this card is asked before the work rather
 *  than after it. A stale standing says first why it is being asked a second time. */
export function acceptanceStartExplanation(
  count: number,
  standing: StandardSetConfirmationStanding | null,
): string {
  const again = standing?.state === 'STALE' ? `${CONFIRMATION_CHANGED_SINCE} ` : '';
  return (
    `${again}Once this starts, Orbit derives done from these ${count} and from nothing else. `
    + CONFIRMATION_EDIT_ENDS_IT
  );
}

/** Whether the confirm button may be pressed. Both un-confirmed states offer it, and it always
 *  sends the version standing NOW; a standing that could not be read offers nothing, because
 *  nobody can say which version a press would confirm. */
export function acceptanceConfirmationAnswerable(
  standing: StandardSetConfirmationStanding | null,
): boolean {
  return standing !== null && standing.state !== 'CONFIRMED';
}

/** Whether this card is still asking something — OrbitKit's `AcceptanceConfirmations.isOpen`, and
 *  what the pinned line counts. The standing is the whole of it, and deliberately: what is open is
 *  the QUESTION, and only a confirmation answers that. Whether the project has been started is the
 *  other fact the meta line carries, and a project already running has this question open all the
 *  same. A standing that could not be read leaves it open, because a failed read is this device's
 *  problem and not an answer. */
export function acceptanceConfirmationStillOpen(
  standing: StandardSetConfirmationStanding | null,
): boolean {
  return standing === null || standing.state !== 'CONFIRMED';
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

/** What a press on this card leaves where its actions were. */
export function acceptanceConfirmedLine(standing: StandardSetConfirmationStanding): string {
  const count = standing.currentVersion.material.length;
  const seal = shortSeal(standing.currentVersion.digest);
  return `You started the project on ${count} criteria at seal ${seal}`;
}

/**
 * Whether this project is waiting to be started on a plan nobody has confirmed, read off the
 * confirmation standing and the project document — null for either one that could not be read.
 *
 * Four facts and no fifth: the project is OPEN, it states criteria, it holds at least one task, and
 * the set standing now has not been confirmed. `satisfied` is deliberately absent — waiting for
 * every criterion to be met put the question at the moment it could only be agreed with, which is
 * what this card was moved for. No quiet period is needed either side of a write:
 * `project_update(acceptanceCriteriaItems)` replaces the whole set in one statement
 * (`criteria-pending-decisions.ts`), so a read never catches a plan half-written.
 *
 * THE TASK COUNT IS THE FOURTH BECAUSE "START" IS A VERB THAT NEEDS AN OBJECT. `project_create`
 * returns before the coordinator has filed a single task, and the plan is written at that moment
 * and there is nothing yet to hand out — so the first version of this condition, which asked for
 * OPEN and criteria and nothing else, put a `Start the project` button in front of the agent while
 * it was still deciding how to split the work, and a press on it would have started nothing. The
 * count is `_count.tasks`: everything filed under the project, settled work included, because the
 * question here is whether there is any work at all and which of it may run is the dispatcher's,
 * not this card's.
 */
export function settlementHeldOnConfirmation(
  standing: StandardSetConfirmationStanding | null,
  project: ConfirmationProjectDocument | null,
): boolean {
  if (!acceptanceConfirmationAnswerable(standing)) return false;
  if (project === null || project.status !== 'OPEN') return false;
  if ((project.acceptanceCriteriaItems ?? []).length === 0) return false;
  return (project._count?.tasks ?? 0) > 0;
}

/**
 * The card. Presentational apart from whether its criteria are shown whole: it issues no request,
 * so a render can assert what each standing puts on screen.
 *
 * TWO ACTIONS, AND THE READING TOGGLE IS NEITHER OF THEM
 * -----------------------------------------------------
 * Start, and talk about it first. Both are `CardAction`'s, at its sizes, under its one rule — an
 * action that cannot succeed is `disabled` rather than lit-and-refused — and neither carries a
 * subtitle, which is what once made one of these buttons two lines tall beside a one-line
 * neighbour. The criteria are on the card already, so opening them whole is a reading control and
 * sits with the text it unfolds rather than in the action row; it writes nothing and is never
 * disabled, as on the native card.
 */
export function AcceptanceConfirmationCard({
  standing,
  criteria,
  projectTitle,
  started,
  busy = false,
  error = null,
  recorded = null,
  onStart,
  onChatAbout,
}: {
  /** The confirmation standing, or null when it could not be read. */
  standing: StandardSetConfirmationStanding | null;
  /** The stated criteria, or null when the project document could not be read. */
  criteria: ConfirmationCriterion[] | null;
  /** What the meta line calls the project this plan belongs to. */
  projectTitle: string;
  /** Whether the project is handing its tasks out, or null when the project document could not be
   *  read. Not derived from `standing`: that is the whole point of this field. */
  started: boolean | null;
  /** A press from this card is on its way to the door, or the re-read after a refusal is. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  /** The door's answer to a press made HERE, once there is one. */
  recorded?: StandardSetConfirmationStanding | null;
  onStart: () => void;
  /** Hands the reply to the bottom composer. The card stays and `onStart` stays live. */
  onChatAbout: () => void;
}): JSX.Element {
  const listId = useId();
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const answerable = acceptanceConfirmationAnswerable(standing);
  // A press made here is not one made "at another end", which is the one reading of its own answer
  // this card can be sure is wrong.
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
        <div className="settlement-card-meta">
          {acceptanceConfirmationMeta(standing, started, projectTitle)}
        </div>
        {stale ? <p className="settlement-card-stale">{stale}</p> : null}
        {/* The set itself, open. Load-bearing rather than decorative: a folded list is an
            invitation to sign what was never opened, and the version digest proves only WHICH
            wording was signed. Each condition is clamped to two lines so N of them stay one
            card; the toggle under them takes the clamp off. */}
        {items.length > 0 ? (
          <>
            <ol
              id={listId}
              className={criteriaOpen ? 'settlement-card-criteria is-open' : 'settlement-card-criteria'}
            >
              {items.map((item) => (
                <li key={item.id} value={item.ordinal}>
                  <span className="settlement-card-criterion">{item.text}</span>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="settlement-card-read"
              aria-expanded={criteriaOpen}
              aria-controls={listId}
              onClick={() => setCriteriaOpen((open) => !open)}
            >
              {criteriaOpen ? ACCEPTANCE_SHOW_LESS_LABEL : acceptanceReadLabel(items.length)}
            </button>
          </>
        ) : null}
        <p className="settlement-card-explains">
          {acceptanceStartExplanation(items.length, standing)}
        </p>
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
          <CardActionButton tone="primary" disabled={busy || !answerable} onClick={onStart}>
            {ACCEPTANCE_START_LABEL}
          </CardActionButton>
          {/* The same control, and the same word for it, as the other three cards that hand a
              reply to the composer. Dead only where there is no version to talk about: a standing
              that could not be read names none. */}
          <CardActionButton tone="secondary" disabled={standing === null} onClick={onChatAbout}>
            {OWNER_SEND_BACK_ACTION}
          </CardActionButton>
        </CardActions>
      )}
    </div>
  );
}

/**
 * The wired card for one conversation: at most one, delivered the first time an unstarted project
 * states a plan nobody has confirmed, and re-derived from both reads on every render after that.
 *
 * The standing is read under `acceptanceConfirmationKey` and the project under the project page's
 * own `['project', id]`. A press sends `currentVersion.digest` from the read the card is drawn
 * from; the door refuses a version that moved in between, and the answer to that refusal is to read
 * the set again — so a refusal re-reads, and the card stays busy until that read has landed.
 *
 * Nothing puts the card down. A third action used to do that, while the question was asked at the
 * end of a project, where putting it down meant "let me answer once the work settles"; asked before
 * anything has run it would mean waiting for nothing, so the way past this card is to start the
 * project or to say what should change first.
 */
export function SessionAcceptanceConfirmationCard({
  projectId,
  onOpenQuestion,
  onChatAbout,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  /** Told whether this card is on screen and the project is still unstarted each time that
   *  changes, and `false` when the card goes: what the pinned strip points at
   *  (`DecisionRail.tsx`). A stable function. */
  onOpenQuestion?: (open: boolean) => void;
  /** Arms the bottom composer to talk about this plan, given what the next send should carry as
   *  context. Nothing here is a door, and the card stays put. Called from a press only, so unlike
   *  `onOpenQuestion` it need not be stable. */
  onChatAbout?: (plan: {
    projectId: string;
    criteriaDigest: string;
    projectTitle: string;
    criteria: string[];
  }) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = projectId ?? '';
  const [delivered, setDelivered] = useState(false);
  const standingRead = useQuery({
    queryKey: acceptanceConfirmationKey(project),
    queryFn: () => readAcceptanceConfirmation(project),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () =>
      api<ConfirmationProjectDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // A read that failed is not an answer, whatever an earlier read said.
  const standing = standingRead.isError ? null : (standingRead.data ?? null);
  const document = documentRead.isError ? null : (documentRead.data ?? null);
  const criteria = document?.acceptanceCriteriaItems ?? null;
  const held = settlementHeldOnConfirmation(standing, document);
  useEffect(() => {
    if (held) setDelivered(true);
  }, [held]);
  // On screen and still asking: the delivered card iOS's needs-you bar counts while
  // `AcceptanceConfirmations.isOpen`. `shown` is exactly what the render below draws, so the strip
  // is told about the card a reader can reach and not about the reads behind it.
  const shown = delivered || held;
  const openHere = shown && acceptanceConfirmationStillOpen(standing);
  useEffect(() => {
    onOpenQuestion?.(openHere);
  }, [onOpenQuestion, openHere]);
  useEffect(() => () => onOpenQuestion?.(false), [onOpenQuestion]);

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

  if (!shown) return null;
  const title = document?.title || project;
  return (
    <AcceptanceConfirmationCard
      standing={standing}
      criteria={criteria}
      projectTitle={title}
      // Straight off the project read, absent-or-unread meaning neither yes nor no. A press here
      // will turn it on, and a project that was already on when this card arrived says so.
      started={document?.coordinatorEnabled ?? null}
      busy={confirm.isPending}
      error={confirm.isError ? confirm.error : null}
      recorded={confirm.isSuccess ? confirm.data : null}
      onStart={() => {
        if (standing === null || !acceptanceConfirmationAnswerable(standing)) return;
        confirm.mutate(standing.currentVersion.digest);
      }}
      onChatAbout={() => {
        if (standing === null) return;
        onChatAbout?.({
          projectId: project,
          criteriaDigest: standing.currentVersion.digest,
          projectTitle: title,
          criteria: [...(criteria ?? [])]
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((item) => item.text),
        });
      }}
    />
  );
}
