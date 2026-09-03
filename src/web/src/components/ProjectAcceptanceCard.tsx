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
 * left that concludes anything about a criterion, and this card says only what is true: here is
 * what the project is for, stated one condition at a time. A badge reading "Unjudged" on every row
 * forever would be a score dressed as a status.
 *
 * THIS IS THE PROJECT PAGE'S ONE HOME FOR THE CRITERIA. It used to render them twice, once as the
 * authored legacy `acceptanceCriteria` text under its own heading and again here; 0229 removed
 * that text column too, and the per-item rows are the whole of it.
 */

/** One stated criterion, as the project document reports it. */
export interface AcceptanceCriterionItem {
  id: string;
  ordinal: number;
  text: string;
  revision: number;
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

/** A criterion is one LINE of the authored field, so it is rendered as inline Markdown: emphasis,
 *  code spans and links come out as themselves, and the block elements a stray `## heading` line
 *  would otherwise produce are flattened, because a row is one row whatever the author typed. */
const Flat = ({ children }: { children?: ReactNode }) => <>{children}</>;
const INLINE_ONLY = { p: Flat, h1: Flat, h2: Flat, h3: Flat, h4: Flat, h5: Flat, h6: Flat };

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
          <span className="acceptance-row-text">
            <Markdown remarkPlugins={[remarkGfm]} components={INLINE_ONLY}>
              {c.text}
            </Markdown>
          </span>
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
        finish every task and still meet none of the conditions it was stated for.
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
            {`${plural(criteria.length, 'criterion', 'criteria')} stated. Nothing in Orbit judges them.`}
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
