import { DownOutlined } from '@ant-design/icons';
import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Typography } from 'antd';
import { Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  confirmAcceptanceCriteria,
  readAcceptanceConfirmation,
} from '../lib/acceptanceConfirmation';
import { useMediaQuery } from '../lib/useMediaQuery';

/**
 * What this project is held to, drawn from `GET /projects/:id` → `acceptanceCriteriaItems`.
 *
 * The rest of a project page counts tasks, which is a PROCESS measure: it reaches 100% whether or
 * not anything the project was stated for was ever checked. This card is the other half of that
 * question — the stated conditions themselves.
 *
 * Until 2026-09-03 it also drew a verdict per row, a pass ratio and a meter. Migration 0229
 * removed the project acceptance judgment on the account owner's instruction, so there is nothing
 * left that concludes anything about a criterion. A badge reading "Unjudged" on every row forever
 * would be a score dressed as a status, which is why that whole rail went.
 *
 * WHAT A ROW SAYS NOW, AND WHY IT IS NOT THAT COMING BACK
 * ------------------------------------------------------
 * Each row also reports whether the WORK filed under its criterion has met it, and where that
 * work is. NO PRINCIPAL WROTE ANY OF IT. There is no field anybody sets, no decision anybody
 * records and nothing to overrule: `satisfied`, `unmet` and `landing` are COMPUTED by the project
 * read, out of which tasks declare they serve this criterion, whether each of those tasks has
 * settled by the criterion IT declared, and whether a merge receipt exists for that work. Delete
 * the tasks and the answer changes; nobody has an opinion to revise.
 *
 * That distinction is invisible on a screen, so the drawing is what has to carry it, and the rules
 * are the ones 0229's removal implies:
 *
 *  - No ratio. Not in the head, not anywhere: "3 / 5 met" is the pass count under a new name.
 *  - No meter, no bar, no gauge.
 *  - No per-row badge that reads as a score. A row states its condition and then says, in words,
 *    what its work has done — never a pill a reader scans for a colour.
 *  - Nothing here is a verdict on what a criterion SAYS. The text is never judged; only the work
 *    filed under it is read, and the note under the list keeps saying so.
 *
 * `landing` is the fourth fact and the one most easily drawn wrong: it is not a boolean. LANDED
 * means a merge receipt puts the work on the default branch, and UNKNOWN means no receipt says
 * anything either way — never "not landed", because work lands without leaving a receipt. Drawing
 * UNKNOWN as a red "not merged" would be a false red invented by this file.
 *
 * HOW A ROW IS DRAWN, AND WHY IT IS DRAWN THAT WAY
 * -----------------------------------------------
 * The first version of this said all of it at 12px in the third grey. It was true and nobody saw
 * it — a fifty-three row list whose only landmark was an ordinal, with the answer set smaller than
 * the question. What replaced it, and the reason for each:
 *
 *  - ONE mark per row, and it is the ordinal itself: a disc filled for met, a 2px ring for unmet,
 *    a dashed ring for a criterion the read did not answer for. SHAPE BEFORE HUE — fill and stroke
 *    keep the three apart in greyscale and for a reader who cannot separate the colours, so hue is
 *    a second signal and never the only one. The unmet ring is near-black rather than grey because
 *    it then outweighs the filled disc, which puts the visual weight on the rows still wanting
 *    work. Until 2026-09-06 the state was a separate 10px dot BESIDE the number; on a phone, where
 *    the number is a 36px disc, that put two circles in the gutter with the meaningless one 3.6x
 *    the size of the meaningful one, and the dot read as a bullet. Nothing but the ordinal goes
 *    inside the mark: a tick or a cross would turn it into the verdict badge 0229 deleted.
 *  - The state sentence at the standing line's size, not the row text's: it answers the row, it
 *    does not compete with it. UNMET IS NOT RED. A project stated this morning has met none of
 *    its criteria and has failed nothing; fifty-three red rows would tell its owner the project
 *    was broken. It gets weight — full text colour at 600 — which also clears AA at 13px, where
 *    the warning token (3.7 : 1) does not.
 *  - Landing only beside work that HAS met its criterion, where both values are printed and the
 *    receiptless one is drawn heavier. A reader whose criterion is still open is not asking where
 *    the unfinished work merged to.
 *  - `requiredAction` and the clause codes as sentences, with the code kept on `title`. Neither
 *    vocabulary is something a person opening a project page agreed to learn.
 *  - The blocking task as a link, because knowing which task and not being able to open it is the
 *    whole of what that line is for.
 *  - The owner's `verificationMethod` behind a disclosure that renders nothing until it is opened.
 *
 * THIS IS THE PROJECT PAGE'S ONE HOME FOR THE CRITERIA. It used to render them twice, once as the
 * authored legacy `acceptanceCriteria` text under its own heading and again here; 0229 removed
 * that text column too, and the per-item rows are the whole of it.
 *
 * THE ONE THING ON THIS CARD A PRINCIPAL DOES WRITE, AND WHY IT IS NOT ABOVE
 * -------------------------------------------------------------------------
 * Since 2026-09-08 the card also carries the account owner's exercise of
 * `CONFIRM_ACCEPTANCE_CRITERIA` — the HUMAN_ONLY act of saying that this set of criteria expresses
 * what the project is for. It is the (B) web entry decided in `docs/human-only-authority.md`
 * §"A2 follow-up (2026-09-08)", and everything about where it sits follows from what is written
 * above:
 *
 *  - It is about the complete SET, never one row. `coordinator-authority.ts` says the action grades
 *    whether the whole exam expresses the goal, so a per-criterion control would be a different
 *    act — and, drawn per row, would be the badge rail 0229 deleted wearing a checkbox.
 *  - It is a REGION OF ITS OWN, below the derived list and after the note, and the list above it
 *    is untouched. Everything up there is still computed with no principal's opinion in it; the
 *    confirmation is one recorded decision that says nothing about whether any criterion is met.
 *  - It names the VERSION. `GET /projects/:id/acceptance/confirmation` reports the digest of the
 *    criteria as they stand and the digest that was confirmed, so "this confirmation is no longer
 *    current" is a comparison the reader is SHOWN rather than one they have to make. The same
 *    digest is what the button sends, which is what makes the click a confirmation of the wording
 *    the person just read: an edit landing in between comes back 409, not a signature.
 *  - It concludes nothing about DONE. Confirming the ruler is not settling the project, nothing
 *    here writes `project.status`, and no state on this card derives one.
 */

/** One task standing between a criterion and its work having met it, and the one thing that
 *  would move it. `requiredAction` is the code every completion refusal already quotes, so the
 *  reader is told what settles that task rather than only that it is unfinished. */
export interface CriterionBlockingTask {
  taskId: string;
  title: string;
  requiredAction: string;
}

/** One clause that does not hold, and the work holding it open. `heldUpBy` is empty for the
 *  clause whose whole content is that there is nobody to name. */
export interface CriterionUnmetReason {
  clause: string;
  heldUpBy?: CriterionBlockingTask[];
}

/** One stated criterion, as the project document reports it.
 *
 *  Everything below `revision` is DERIVED by the read rather than authored — see the card comment
 *  — and every one of them is optional, because a criterion the read did not answer for arrives
 *  without them, and a card that invented a state for it would be inventing the answer. */
export interface AcceptanceCriterionItem {
  id: string;
  ordinal: number;
  text: string;
  revision: number;
  satisfied?: boolean;
  unmet?: CriterionUnmetReason[];
  landing?: string;
  /** How the OWNER said anybody would know this criterion holds, authored beside the criterion
   *  itself. Not derived and not judged by it: it is the instruction, and until now the card
   *  printed none of it. Null for a criterion whose author left it unanswered. */
  verificationMethod?: string | null;
}

/** The parts of the project detail document this card reads. */
interface ProjectAcceptanceDetail {
  acceptanceCriteriaItems?: AcceptanceCriterionItem[];
}

/** How many criteria a card lists before it stops and says how many more there are. Twelve rather
 *  than all of them because the section sits between the goal and the task list: a 53-criterion
 *  project would otherwise push the rest of the page off the screen. */
export const CRITERIA_PREVIEW = 12;

/** A project detail page on a phone should establish the section and then let the task content
 *  continue. Four rows are enough to show the shape without a seven- or fifty-three-item list
 *  taking over the first visit; the disclosure below names exactly what remains.
 *
 *  This limit is now the ONLY thing bounding the section's height, because a phone row draws its
 *  criterion whole. Until 2026-09-03 each row also clamped to three lines behind a per-row
 *  chevron; on a 393px screen that cut every criterion mid-clause while saving almost nothing —
 *  the rows already ran to three lines, so the clamp bought about a hundred pixels in exchange
 *  for making every condition unreadable until it was tapped. A criterion read half-way is not
 *  read, so the whole of it is what a row shows. */
export const MOBILE_CRITERIA_PREVIEW = 4;

/** Kept identical to the acceptance media block in index.css. This is narrower than the app's
 *  960px master/detail breakpoint: a tablet has enough reading width for the desktop list. */
export const ACCEPTANCE_PHONE_QUERY = '(max-width: 560px)';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Said about the WORK, never about the criterion: the read folds task rows, and "met" is those
 *  rows agreeing rather than anybody's finding. Words in the row's own type size — a pill here
 *  would be the badge 0229 deleted, wearing a derivation's clothes. */
const MET = 'Met by its work';
const NOT_MET = 'Not met by its work';

/** Which way the row's one mark is drawn. THREE states, not two: `satisfied === undefined` is the
 *  read declining to answer, and it gets a dashed ring of its own rather than the unmet ring —
 *  "no answer" and "the answer is no" are different things and the drawing may not merge them. */
function markState(satisfied: boolean | undefined): string {
  if (satisfied === undefined) return 'is-unanswered';
  return satisfied ? 'is-met' : 'is-unmet';
}

/** Each clause as a sentence. The codes are the read's vocabulary and a person looking at a
 *  project page has not agreed to learn it. An unrecognised clause prints as itself rather than
 *  vanishing: a browser held open across a deploy is how that happens, and dropping a reason
 *  would under-report exactly when there is more to say. */
const UNMET_CLAUSE: Record<string, string> = {
  NO_WORK_SERVES_IT: 'No task says it serves this criterion.',
  SERVING_WORK_UNSETTLED: 'Work filed under it has not settled by the criterion that work declared.',
  DECLARATION_STALE: 'Work here was filed against an earlier wording of this criterion.',
};

/** The landing lane, which has no third value to print, said as the tail of the state sentence
 *  rather than as a claim of its own — lower case because it continues "Met by its work ·".
 *  UNKNOWN is the ABSENCE of evidence — work lands without leaving a receipt — so it is drawn as
 *  nobody having said either way, and never as not landed.
 *
 *  It is printed ONLY beside work that has met its criterion. A reader looking at a criterion
 *  nothing has settled yet is not asking where that unfinished work merged to, and answering
 *  anyway put a second sentence on every row that had nothing to do with why the row was open. */
const LANDING: Record<string, string> = {
  LANDED: 'landed on the default branch',
  UNKNOWN: 'no merge receipt either way',
};

/** The landing value that is drawn heavier than the other. A criterion its work has MET, with no
 *  receipt putting that work on the default branch, is precisely the false green this card exists
 *  to keep visible — so it is given full text colour while the ordinary answer stays receded.
 *  Both are printed: the difference between settled and landed has to be readable, and silence
 *  cannot express a difference. */
const LANDING_FLAGGED = 'UNKNOWN';

/** What would settle one blocking task, as a sentence. `requiredAction` is a code out of the
 *  completion table every refusal quotes, and it reads as one; somebody looking at a project page
 *  has not agreed to learn that vocabulary any more than they agreed to learn the clause codes.
 *  The code stays on `title` for the reader matching this row against an API response, and a code
 *  this build does not recognise prints as itself — the same treatment an unknown clause gets,
 *  for the same reason: a browser held open across a deploy must under-report nothing. */
const REQUIRED_ACTION: Record<string, string> = {
  RUN_ACCEPTANCE_COMMAND: 'needs its acceptance command to run',
  OBTAIN_INDEPENDENT_VERIFICATION_PASS: 'needs an independent verification pass',
  RECORD_VERIFICATION_VERDICT: 'needs its verdict recorded',
  SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION:
    'needs evidence submitted, then an independent decision',
};

/** A criterion is one LINE of the authored field, so it is rendered as inline Markdown: emphasis,
 *  code spans and links come out as themselves, and the block elements a stray `## heading` line
 *  would otherwise produce are flattened, because a row is one row whatever the author typed. */
const Flat = ({ children }: { children?: ReactNode }) => <>{children}</>;
const INLINE_ONLY = { p: Flat, h1: Flat, h2: Flat, h3: Flat, h4: Flat, h5: Flat, h6: Flat };

/** What would move one blocking task, in words. An unrecognised code is printed as the code it
 *  is, in the same monospace the card has always given a raw value: dropping it would say the
 *  task needs nothing. */
function RequiredAction({ code }: { code: string }) {
  const sentence = REQUIRED_ACTION[code];
  if (sentence === undefined) {
    return (
      <span className="acceptance-held-up-action">
        <Typography.Text code>{code}</Typography.Text>
      </span>
    );
  }
  return <span className="acceptance-held-up-action" title={code}>{sentence}</span>;
}

/**
 * What the read says about one criterion's work: whether it has met the criterion, where that work
 * is, and, when it has not, every reason it has not — each naming the tasks holding it open and
 * what would settle each of them.
 *
 * Every unmet reason is drawn, not the first: a reader who fixes the one they were shown and comes
 * back to the next has been sent round twice. And a criterion the read did not answer for draws
 * nothing at all, which is also what an older server's document renders as.
 */
function CriterionWork({ criterion }: { criterion: AcceptanceCriterionItem }) {
  if (criterion.satisfied === undefined) return null;
  const unmet = criterion.unmet ?? [];
  return (
    <>
      <div className="acceptance-work">
        <span className={`acceptance-work-state ${criterion.satisfied ? 'is-met' : 'is-unmet'}`}>
          {criterion.satisfied ? MET : NOT_MET}
        </span>
        {criterion.satisfied && criterion.landing !== undefined ? (
          <span
            className={
              `acceptance-landing${criterion.landing === LANDING_FLAGGED ? ' is-flagged' : ''}`
            }
          >
            {LANDING[criterion.landing] ?? criterion.landing}
          </span>
        ) : null}
      </div>
      {unmet.length === 0 ? null : (
        <div className="acceptance-unmet">
          {unmet.map((reason) => (
            <div key={reason.clause} className="acceptance-unmet-reason">
              <div className="acceptance-unmet-clause">
                {UNMET_CLAUSE[reason.clause] ?? reason.clause}
              </div>
              {(reason.heldUpBy ?? []).map((task) => (
                <div key={task.taskId} className="acceptance-held-up">
                  {/* The whole reason this line exists is "who does what next", and the reader's
                      next move after recognising the name is to open it. */}
                  <Link className="acceptance-held-up-title" to={`/tasks/${task.taskId}`}>
                    {task.title}
                  </Link>
                  <RequiredAction code={task.requiredAction} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * How the owner said this criterion would be checked, folded away until somebody asks.
 *
 * Collapsed means ABSENT rather than merely out of sight: fifty-three methods sitting in the
 * document under a closed twisty is fifty-three criteria rendered twice, and it is the reader who
 * is about to go and check one who needs it — not the reader going down the list. A native
 * `<details>` keeps its body in the page whatever it is showing, which is the one thing this
 * must not do, so the disclosure is the same `aria-expanded` button the list itself uses.
 */
function CriterionMethod({ method }: { method: string }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="acceptance-method">
      <button
        type="button"
        className="acceptance-method-toggle"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="acceptance-method-marker" aria-hidden>{open ? '\u25be' : '\u25b8'}</span>
        {"How it's checked"}
      </button>
      {open ? (
        <div id={bodyId} className="acceptance-method-body">{method}</div>
      ) : null}
    </div>
  );
}

/** Every stated criterion, in the order they were stated. */
export function AcceptanceCriteriaList({
  criteria,
  id,
}: {
  criteria: AcceptanceCriterionItem[];
  id?: string;
}) {
  return (
    <ul id={id} className="acceptance-criteria">
      {criteria.map((c) => (
        <li key={c.id} className="acceptance-row">
          {/* The scanning handle, and the row's ONE mark: the number is drawn as the state
              rather than beside it. It says which criterion, and how it is drawn says what the
              read said about that criterion's work. Nothing but the ordinal goes inside it — a
              tick or a cross would make it a verdict badge, and there is no verdict here. */}
          <span className={`acceptance-row-no ${markState(c.satisfied)}`}>{c.ordinal}</span>
          <div className="acceptance-row-text">
            <Markdown remarkPlugins={[remarkGfm]} components={INLINE_ONLY}>
              {c.text}
            </Markdown>
            <CriterionWork criterion={c} />
            {c.verificationMethod ? <CriterionMethod method={c.verificationMethod} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The card's bottom line, in every loaded state: what the two numbers on this page mean, so the
 *  task tally is not read as the answer. */
function OutcomeNote() {
  return (
    <div className="acceptance-note">
      <span className="acceptance-note-wide">
        Task completion is a process measure, and nothing evaluates these criteria — a project can
        finish every task and still meet none of the conditions it was stated for. What a row says
        about a criterion is computed from the work filed under it, not a judgment anybody made.
      </span>
      <span className="acceptance-note-compact">
        Tasks track process · Nothing judges these criteria.
      </span>
    </div>
  );
}

/** How much of a digest a reader is shown. Twelve hex characters is the length a person can
 *  compare at a glance; the whole 64 stays on `title` and is what the button actually sends, so
 *  nothing is ever decided from the short form. */
export const DIGEST_PREVIEW = 12;

/** A version, named. `title` carries the whole digest because the short form is for the eye and
 *  the long one is what the server was asked about. */
function Digest({ digest }: { digest: string }) {
  return (
    <code className="acceptance-confirmation-digest" title={digest}>
      {digest.slice(0, DIGEST_PREVIEW)}
    </code>
  );
}

/** One instant in the reader's own clock, with the exact one kept beside it machine-readable —
 *  the same split `scheduledStart` makes, for the same reason: a time shown in UTC is the wrong
 *  time for everyone outside it, and a time shown only as prose cannot be checked. */
function ConfirmedAt({ at }: { at: string }) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return (
    <time dateTime={at} title={at}>
      {when.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}
    </time>
  );
}

/**
 * The account owner's confirmation that this set of criteria expresses what the project is for —
 * the web entry for `CONFIRM_ACCEPTANCE_CRITERIA`, and the only thing on this card anybody writes.
 *
 * Its own read, not the project document's: the standing is a comparison of two stored facts and
 * has to be able to refresh on its own after a confirmation, without re-reading the project.
 *
 * Three drawings, because the server reports three states and the third one is the whole reason
 * the region names a version at all: a confirmation of criteria that have since been rewritten is
 * not a confirmation of what is on the screen, and the reader is shown that rather than left to
 * work it out. Both un-confirmed states offer the same button, and it always sends the version
 * standing NOW — never the one that was confirmed before.
 */
function OwnerConfirmation({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const standing = useQuery({
    queryKey: acceptanceConfirmationKey(projectId),
    queryFn: () => readAcceptanceConfirmation(projectId),
    enabled: Boolean(projectId),
  });
  const confirm = useMutation({
    mutationFn: (criteriaDigest: string) => confirmAcceptanceCriteria(projectId, criteriaDigest),
    // The door returns the standing it just wrote, so the region redraws from the server's answer
    // rather than from what this component assumed the press would do.
    onSuccess: (next) => qc.setQueryData(acceptanceConfirmationKey(projectId), next),
    // The refusal this door exists for is a digest that moved under the click, and its answer is
    // to read the set again — so a failure re-reads instead of leaving a stale digest on a button
    // beside the complaint about it.
    onError: () => {
      void qc.invalidateQueries({ queryKey: acceptanceConfirmationKey(projectId) });
    },
  });

  if (standing.isPending) {
    return (
      <div className="acceptance-confirmation">
        <Skeleton active title={false} paragraph={{ rows: 1 }} />
      </div>
    );
  }
  if (standing.isError || standing.data === undefined) {
    // Quiet on purpose. The criteria above loaded; an alert here would make a second read that
    // failed look like a problem with the criteria themselves.
    return (
      <div className="acceptance-confirmation">
        <div className="acceptance-confirmation-unread">
          {'Owner confirmation could not be read'}
          {standing.error instanceof Error ? ` — ${standing.error.message}` : '.'}
        </div>
      </div>
    );
  }

  const { state, currentVersion, confirmation } = standing.data;
  const stated = plural(currentVersion.material.length, 'criterion', 'criteria');
  const failure = confirm.error instanceof Error ? confirm.error.message : null;

  if (state === 'CONFIRMED' && confirmation !== null) {
    return (
      <div className="acceptance-confirmation">
        <div className="acceptance-confirmation-head">Confirmed by the account owner</div>
        <div className="acceptance-confirmation-state">
          {`These ${stated} were confirmed to express this project's goal on `}
          <ConfirmedAt at={confirmation.confirmedAt} />
          {'.'}
        </div>
        <div className="acceptance-confirmation-version">
          {'Version '}
          <Digest digest={confirmation.criteriaDigest} />
          {' — the wording that stands now. Editing any criterion ends this confirmation.'}
        </div>
      </div>
    );
  }

  return (
    <div className="acceptance-confirmation">
      <div className="acceptance-confirmation-head">Owner confirmation</div>
      <div className="acceptance-confirmation-state">
        {confirmation === null
          ? `Nobody has confirmed that these ${stated} express this project's goal.`
          : 'The criteria changed after they were confirmed, so that confirmation no longer '
            + 'covers what is stated above.'}
      </div>
      {confirmation === null ? null : (
        <div className="acceptance-confirmation-prior">
          {'Confirmed version '}
          <Digest digest={confirmation.criteriaDigest} />
          {' on '}
          <ConfirmedAt at={confirmation.confirmedAt} />
          {'.'}
        </div>
      )}
      <div className="acceptance-confirmation-action">
        <Button
          type="primary"
          size="small"
          loading={confirm.isPending}
          onClick={() => confirm.mutate(currentVersion.digest)}
        >
          Confirm these criteria
        </Button>
        <span className="acceptance-confirmation-version">
          {'Records version '}
          <Digest digest={currentVersion.digest} />
          {` — the ${stated} above as they stand now.`}
        </span>
      </div>
      {failure === null ? null : (
        <Alert
          className="acceptance-confirmation-failure"
          type="warning"
          showIcon
          message={failure}
        />
      )}
    </div>
  );
}

/** What the list shows before and after the button is pressed. Exported because a static render
 *  cannot press it: the collapsed state is what the card's own suite asserts on, and both
 *  readings are asserted here. */
export function criteriaPreview(
  criteria: AcceptanceCriterionItem[],
  expanded: boolean,
  limit = CRITERIA_PREVIEW,
): AcceptanceCriterionItem[] {
  return expanded ? criteria : criteria.slice(0, limit);
}

/**
 * The stated criteria of one project, fetched here rather than handed in as a prop.
 *
 * The query key and URL are the project detail page's own (`['project', id]`), so the card reads
 * the document that page already holds instead of opening a second read of it — and a write that
 * invalidates the project refreshes both.
 */
export function ProjectAcceptanceCard({
  projectId,
  action,
}: {
  projectId: string;
  action?: ReactNode;
}) {
  const phone = useMediaQuery(ACCEPTANCE_PHONE_QUERY);
  const criteriaListId = useId();
  const detail = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectAcceptanceDetail>(`/projects/${encodeURIComponent(projectId)}`),
    enabled: Boolean(projectId),
  });
  // Collapsed until asked: see CRITERIA_PREVIEW. A static render cannot press the button, which
  // is why the slice is `criteriaPreview` — the function this reads through is the one the suite
  // asserts both readings of.
  const [expanded, setExpanded] = useState(false);

  const criteria = Array.isArray(detail.data?.acceptanceCriteriaItems)
    ? detail.data.acceptanceCriteriaItems
    : [];
  const previewLimit = phone ? MOBILE_CRITERIA_PREVIEW : CRITERIA_PREVIEW;
  const shown = criteriaPreview(criteria, expanded, previewLimit);
  const hasCriteriaDisclosure = criteria.length > previewLimit;

  return (
    <Card
      className="acceptance-card"
      title="Acceptance criteria"
      styles={{ body: { padding: 0 } }}
      extra={action}
    >
      {detail.isPending ? (
        <div className="acceptance-block">
          <Skeleton active title={false} paragraph={{ rows: 3 }} />
        </div>
      ) : detail.isError ? (
        <div className="acceptance-block">
          <Alert
            type="error"
            showIcon
            message="Acceptance criteria could not be loaded"
            description={detail.error instanceof Error ? detail.error.message : undefined}
          />
        </div>
      ) : criteria.length === 0 ? (
        <div className="acceptance-standing">
          No criteria are stated for this project.
        </div>
      ) : (
        <>
          <div className="acceptance-standing">
            {`${plural(criteria.length, 'criterion', 'criteria')} stated. Whether one is met is `
              + 'read off the work filed under it; nothing in Orbit judges the criteria themselves.'}
          </div>
          <AcceptanceCriteriaList id={criteriaListId} criteria={shown} />
          {hasCriteriaDisclosure ? (
            // Says what it is hiding. A list that stopped at twelve without naming the other
            // forty-one would read as a complete list of twelve. The control remains after it is
            // pressed so keyboard focus has somewhere stable to stay, and the list can fold back.
            <div className="acceptance-block acceptance-more">
              <Button
                size="small"
                block={phone}
                className="acceptance-more-button"
                aria-expanded={expanded}
                aria-controls={criteriaListId}
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded
                  ? `Show first ${previewLimit} criteria`
                  : phone
                    ? `View all ${criteria.length} criteria`
                    : `Show all ${criteria.length} criteria`}
                {phone ? (
                  <DownOutlined
                    className={`acceptance-more-icon${expanded ? ' is-expanded' : ''}`}
                    aria-hidden
                  />
                ) : null}
              </Button>
              <Typography.Text type="secondary" className="acceptance-more-meta">
                {expanded
                  ? `Showing all ${criteria.length} criteria`
                  : `${criteria.length - shown.length} more not shown`}
              </Typography.Text>
            </div>
          ) : null}
          <OutcomeNote />
          {/* Below the derived list and below the note that explains it, so the note keeps its
              referent and the one written fact on this card is plainly not part of what is read
              off the work. See the header: about the whole SET, never a row. */}
          <OwnerConfirmation projectId={projectId} />
        </>
      )}
    </Card>
  );
}
