import { DownOutlined } from '@ant-design/icons';
import { useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Typography } from 'antd';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
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
 * THIS IS THE PROJECT PAGE'S ONE HOME FOR THE CRITERIA. It used to render them twice, once as the
 * authored legacy `acceptanceCriteria` text under its own heading and again here; 0229 removed
 * that text column too, and the per-item rows are the whole of it.
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

/** Each clause as a sentence. The codes are the read's vocabulary and a person looking at a
 *  project page has not agreed to learn it. An unrecognised clause prints as itself rather than
 *  vanishing: a browser held open across a deploy is how that happens, and dropping a reason
 *  would under-report exactly when there is more to say. */
const UNMET_CLAUSE: Record<string, string> = {
  NO_WORK_SERVES_IT: 'No task says it serves this criterion.',
  SERVING_WORK_UNSETTLED: 'Work filed under it has not settled by the criterion that work declared.',
  DECLARATION_STALE: 'Work here was filed against an earlier wording of this criterion.',
};

/** The landing lane, which has no third value to print. UNKNOWN is the ABSENCE of evidence — work
 *  lands without leaving a receipt — so it is drawn as not knowing, and never as not landed. */
const LANDING: Record<string, string> = {
  LANDED: 'Landed on the default branch',
  UNKNOWN: 'Landing unknown — no merge receipt either way',
};

/** A criterion is one LINE of the authored field, so it is rendered as inline Markdown: emphasis,
 *  code spans and links come out as themselves, and the block elements a stray `## heading` line
 *  would otherwise produce are flattened, because a row is one row whatever the author typed. */
const Flat = ({ children }: { children?: ReactNode }) => <>{children}</>;
const INLINE_ONLY = { p: Flat, h1: Flat, h2: Flat, h3: Flat, h4: Flat, h5: Flat, h6: Flat };

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
        <span className="acceptance-work-state">{criterion.satisfied ? MET : NOT_MET}</span>
        {criterion.landing === undefined ? null : (
          <span className="acceptance-landing">
            {LANDING[criterion.landing] ?? criterion.landing}
          </span>
        )}
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
                  <span className="acceptance-held-up-title">{task.title}</span>
                  <span className="acceptance-held-up-action">
                    {'Next: '}
                    <Typography.Text code>{task.requiredAction}</Typography.Text>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
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
          <span className="acceptance-row-no">{c.ordinal}</span>
          <div className="acceptance-row-text">
            <Markdown remarkPlugins={[remarkGfm]} components={INLINE_ONLY}>
              {c.text}
            </Markdown>
            <CriterionWork criterion={c} />
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
        </>
      )}
    </Card>
  );
}
