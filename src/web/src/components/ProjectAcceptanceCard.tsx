import { DownOutlined } from '@ant-design/icons';
import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Tag, Typography } from 'antd';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { remarkHardBreaks } from '../lib/remarkHardBreaks';
import { ago } from '../lib/runnerEngines';
import { useMediaQuery } from '../lib/useMediaQuery';

/**
 * The OUTCOME half of "is this project done", drawn from `GET /projects/:id` → `acceptance`.
 *
 * The rest of a project page counts tasks, which is a PROCESS measure: it reaches 100% whether or
 * not anything the project was stated for was ever checked. This card shows the other number —
 * how many of the stated criteria the LATEST acceptance attempt concluded PASS about — and, for
 * the common case where no attempt has ever run, says exactly that instead of implying a score.
 *
 * THIS IS THE PROJECT PAGE'S ONE HOME FOR THE CRITERIA. The page used to render them twice: once
 * as the authored legacy `acceptanceCriteria` text under its own heading, and again here with a
 * verdict per row. Structured servers now serve the authoritative item rows directly; legacy
 * servers conservatively derive them one physical line at a time. In both cases this card carries
 * both halves: what is currently stated, and what the latest matching attempt concluded.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 *  - **A verdict is text before it is a colour.** Every badge carries PASS / FAIL / — as glyphs,
 *    and the meter in the head carries its reading in `aria-label`. Hue is the second signal.
 *  - **Never run is not zero.** A project with 53 stated criteria and no run is the normal state,
 *    not a failing one. It gets a stated standing and no ratio at all, because "0 / 53" and
 *    "0 / 0" both read as a score somebody earned.
 *  - **Losing the field must not lose the text.** A server that does not report `acceptance` still
 *    has the authored criteria in the document, and this card renders them as Markdown in that
 *    case — otherwise removing the heading above would have cost that reader the criteria
 *    entirely.
 */

/** One stated criterion and what the latest attempt currently says about it.
 *
 *  `UNDECIDED` is a value the server sends rather than an absence: it covers both a criterion the
 *  current run has not reached and every criterion of a project no run has ever judged. */
export interface AcceptanceCriterionStanding {
  /** Stable authored definition id on structured servers. Optional for compatibility payloads. */
  id?: string;
  key: string;
  text: string;
  ordinal: number;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'UNDECIDED';
}

/** The acceptance tally the project detail read embeds, from the latest attempt only. */
export interface ProjectAcceptanceSummary {
  total: number;
  passed: number;
  /** When acceptance was last looked at — null on a project no run has ever judged. */
  lastRunAt: string | null;
  criteria: AcceptanceCriterionStanding[];
}

/** The parts of the project detail document this card reads. `acceptance` is optional because a
 *  server that predates the field serves the rest of the document unchanged, and that is a
 *  different answer from "never run"; `acceptanceCriteria` is the compatibility projection this
 *  card falls back to only when that older server reports no standing. */
interface ProjectAcceptanceDetail {
  acceptance?: ProjectAcceptanceSummary | null;
  acceptanceCriteria?: string | null;
  acceptanceCriteriaItems?: Array<{ id: string; ordinal: number; text: string; revision: number }>;
  acceptanceCriteriaMigration?: {
    source: 'LEGACY_TEXT' | 'STRUCTURED';
    needsReview: boolean;
    reason: 'AMBIGUOUS_SINGLE_LINE_ENUMERATION' | null;
  };
}

/**
 * How each verdict is drawn: `label` is what the badge SAYS, the colours are what it looks like.
 *
 * `--success` / `--error` rather than `--success-solid` / `--error-solid`: the solid step is the
 * dot-and-icon colour, and it is too light as text on its own tint. Undecided is neutral grey —
 * an unjudged criterion is not a warning, and colouring it as one would make a normal project
 * look broken.
 */
const VERDICT: Record<
  AcceptanceCriterionStanding['verdict'],
  { label: string; accessible: string; color: string; background: string; border: string; fill: string }
> = {
  PASS: {
    label: 'PASS',
    accessible: 'Passed',
    color: 'var(--success)',
    background: 'var(--success-bg)',
    border: 'var(--success-border)',
    fill: 'var(--success-solid)',
  },
  FAIL: {
    label: 'FAIL',
    accessible: 'Failed',
    color: 'var(--error)',
    background: 'var(--error-bg)',
    border: 'var(--error-border)',
    fill: 'var(--error-solid)',
  },
  INCONCLUSIVE: {
    label: 'INCONCLUSIVE',
    accessible: 'Inconclusive',
    color: 'var(--warning)',
    background: 'var(--warning-bg)',
    border: 'var(--warning-border)',
    fill: 'var(--warning-solid)',
  },
  UNDECIDED: {
    label: 'Unjudged',
    accessible: 'Unjudged — not judged yet',
    color: 'var(--text-2)',
    background: 'var(--fill-muted)',
    border: 'var(--border)',
    fill: 'var(--border)',
  },
};

/** One verdict, as a word. `Unjudged` is deliberately explicit on a phone, where the old em dash
 *  looked like a disabled remove control. Its accessible name remains the fuller sentence. */
export function VerdictBadge({ verdict }: { verdict: AcceptanceCriterionStanding['verdict'] }) {
  const v = VERDICT[verdict];
  return (
    <Tag
      aria-label={v.accessible}
      title={v.accessible}
      style={{
        color: v.color,
        background: v.background,
        borderColor: v.border,
        fontVariantNumeric: 'tabular-nums',
        marginInlineEnd: 0,
        textAlign: 'center',
        // INCONCLUSIVE is the longest label there is; the rail below is sized for it, and every
        // shorter badge is right-aligned inside that rail rather than stretched to fill it.
        fontSize: verdict === 'INCONCLUSIVE' ? 10.5 : undefined,
      }}
    >
      {v.label}
    </Tag>
  );
}

/** How many criteria a card lists before it stops and says how many more there are. Twelve rather
 *  than all of them because the section sits between the goal and the task list: a 53-criterion
 *  project would otherwise push the rest of the page off the screen. */
export const CRITERIA_PREVIEW = 12;

/** A project detail page on a phone should establish the section and then let the task content
 *  continue. Four rows are enough to show the shape without a seven- or fifty-three-item list
 *  taking over the first visit; the disclosure below names exactly what remains. */
export const MOBILE_CRITERIA_PREVIEW = 4;

/** Kept identical to the acceptance media block in index.css. This is narrower than the app's
 *  960px master/detail breakpoint: a tablet has enough reading width for the desktop list. */
export const ACCEPTANCE_PHONE_QUERY = '(max-width: 560px)';

/** Above this many criteria the meter stops being one segment per criterion — 53 hairlines are a
 *  texture, not a reading — and becomes one proportional run per verdict. */
export const METER_SEGMENT_LIMIT = 24;

export interface AcceptanceTally {
  pass: number;
  fail: number;
  inconclusive: number;
  undecided: number;
  total: number;
}

/** What the criteria rows add up to. Derived from the rows rather than read off `passed`/`total`,
 *  because the meter and the breakdown sentence are readings OF THE ROWS — a meter that disagreed
 *  with the list under it would be the more confusing of the two errors. */
export function tally(criteria: AcceptanceCriterionStanding[]): AcceptanceTally {
  const t: AcceptanceTally = { pass: 0, fail: 0, inconclusive: 0, undecided: 0, total: criteria.length };
  for (const c of criteria) {
    if (c.verdict === 'PASS') t.pass += 1;
    else if (c.verdict === 'FAIL') t.fail += 1;
    else if (c.verdict === 'INCONCLUSIVE') t.inconclusive += 1;
    else t.undecided += 1;
  }
  return t;
}

/**
 * The meter, as weighted runs left to right.
 *
 * Under the limit there is one segment per criterion IN STATED ORDER, so segment three is
 * criterion three — the meter indexes the list under it rather than summarizing it. Over the
 * limit that reading is not available at any width, so it collapses to one run per verdict,
 * proportional to how many criteria hold it.
 */
export function meterSegments(
  criteria: AcceptanceCriterionStanding[],
): Array<{ verdict: AcceptanceCriterionStanding['verdict']; weight: number }> {
  if (criteria.length === 0) return [];
  if (criteria.length <= METER_SEGMENT_LIMIT) {
    return criteria.map((c) => ({ verdict: c.verdict, weight: 1 }));
  }
  const t = tally(criteria);
  return (
    [
      ['PASS', t.pass],
      ['FAIL', t.fail],
      ['INCONCLUSIVE', t.inconclusive],
      ['UNDECIDED', t.undecided],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([verdict, n]) => ({ verdict, weight: n }));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the meter says in words, for a reader who is not being shown its colours. */
export function meterReading(t: AcceptanceTally, ran: boolean): string {
  if (!ran) return `${plural(t.total, 'criterion', 'criteria')} stated, none judged`;
  const parts = [`${t.pass} passed`];
  if (t.fail > 0) parts.push(`${t.fail} failed`);
  if (t.inconclusive > 0) parts.push(`${t.inconclusive} inconclusive`);
  if (t.undecided > 0) parts.push(`${t.undecided} not judged`);
  return `${parts.join(', ')} of ${plural(t.total, 'criterion', 'criteria')}`;
}

/**
 * The one sentence above the list: what this project's acceptance standing IS.
 *
 * Three states, three sentences, and none of them a ratio the reader has to interpret. The
 * never-run one keeps saying "unknown, not zero" because that is the whole point of not printing
 * `0 / 53` — a reader who saw the number would have read a verdict nobody reached.
 */
export function standingLine(acceptance: ProjectAcceptanceSummary, now: number): string {
  const t = tally(Array.isArray(acceptance.criteria) ? acceptance.criteria : []);
  if (acceptance.lastRunAt === null) {
    if (acceptance.total === 0) {
      return 'No criteria are stated for this project, so there is nothing for a run to conclude.';
    }
    return `Never run — ${plural(acceptance.total, 'criterion', 'criteria')} stated. This project's standing is unknown, not zero.`;
  }
  const problems = [
    t.fail > 0 ? `${t.fail} failed` : null,
    t.inconclusive > 0 ? `${t.inconclusive} inconclusive` : null,
    t.undecided > 0 ? `${t.undecided} still unjudged` : null,
  ].filter((s): s is string => s !== null);
  const rest = problems.length === 0 ? 'every stated criterion passed' : problems.join(', ');
  return `Judged ${ago(acceptance.lastRunAt, now)} — ${rest}.`;
}

/** A criterion is one LINE of the authored field, so it is rendered as inline Markdown: emphasis,
 *  code spans and links come out as themselves, and the block elements a stray `## heading` line
 *  would otherwise produce are flattened, because a row is one row whatever the author typed. */
const Flat = ({ children }: { children?: ReactNode }) => <>{children}</>;
const INLINE_ONLY = { p: Flat, h1: Flat, h2: Flat, h3: Flat, h4: Flat, h5: Flat, h6: Flat };
const PreviewImage = ({ alt }: ComponentProps<'img'>) => <>{alt ?? ''}</>;
// A collapsed phone preview is readable text, not the interactive document. In particular, a
// link clipped below line three must not remain in the keyboard order; the formatted Markdown is
// mounted separately and `hidden` until the reader asks for it.
const PREVIEW_ONLY = { ...INLINE_ONLY, a: Flat, img: PreviewImage };

export const MOBILE_CRITERION_PREVIEW_LINES = 3;

/** Real rendered overflow, not character count: CJK, code and links all wrap differently. */
export function criterionNeedsDisclosure(element: HTMLElement): boolean {
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return false;
  return element.scrollHeight > lineHeight * MOBILE_CRITERION_PREVIEW_LINES + 1;
}

/** One phone row. The disclosure exists only when the rendered text actually exceeds three
 *  lines. Its collapsed copy contains no interactive descendants, while the real Markdown stays
 *  natively hidden, so a clipped link cannot still receive keyboard focus. */
function MobileCriterionRow({ criterion }: { criterion: AcceptanceCriterionStanding }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState<boolean | null>(null);
  const measuredText = useRef<HTMLSpanElement>(null);
  const fullId = useId();

  useLayoutEffect(() => {
    if (expanded || measuredText.current === null) return;
    const element = measuredText.current;
    const measure = (): void => {
      const next = criterionNeedsDisclosure(element);
      setOverflows((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [criterion.text, expanded, overflows]);

  const classes = [
    'acceptance-row',
    'acceptance-row-mobile',
    criterion.verdict === 'FAIL' ? 'is-fail' : '',
    expanded ? 'is-expanded' : '',
  ].filter(Boolean).join(' ');

  // Once a short row has been measured, render its real Markdown directly: links that fit in the
  // preview should work without making the reader open a disclosure that reveals nothing.
  if (overflows === false) {
    return (
      <li className={classes}>
        <span className="acceptance-row-no">{criterion.ordinal}</span>
        <span ref={measuredText} className="acceptance-row-text acceptance-row-full">
          <Markdown remarkPlugins={[remarkGfm]} components={INLINE_ONLY}>
            {criterion.text}
          </Markdown>
        </span>
        <span className="acceptance-row-verdict acceptance-row-verdict-static">
          <VerdictBadge verdict={criterion.verdict} />
        </span>
      </li>
    );
  }

  return (
    <li className={classes}>
      <span className="acceptance-row-no">{criterion.ordinal}</span>
      <span
        ref={expanded ? undefined : measuredText}
        className="acceptance-row-text acceptance-row-preview"
        hidden={expanded}
      >
        <Markdown remarkPlugins={[remarkGfm]} components={PREVIEW_ONLY}>
          {criterion.text}
        </Markdown>
      </span>
      <span className="acceptance-row-verdict">
        {overflows === true ? (
          <button
            type="button"
            className="acceptance-row-toggle"
            aria-expanded={expanded}
            aria-controls={fullId}
            aria-label={`${expanded ? 'Hide' : 'Show'} formatted criterion ${criterion.ordinal}, ${VERDICT[criterion.verdict].accessible}`}
            onClick={() => setExpanded((current) => !current)}
          >
            <VerdictBadge verdict={criterion.verdict} />
            <DownOutlined className="acceptance-row-toggle-icon" aria-hidden />
          </button>
        ) : (
          <span className="acceptance-row-verdict-static">
            <VerdictBadge verdict={criterion.verdict} />
          </span>
        )}
      </span>
      <span
        ref={expanded ? measuredText : undefined}
        id={fullId}
        className="acceptance-row-text acceptance-row-full"
        hidden={!expanded}
      >
        <Markdown remarkPlugins={[remarkGfm]} components={INLINE_ONLY}>
          {criterion.text}
        </Markdown>
      </span>
    </li>
  );
}

/** Every stated criterion with what the latest attempt says about it, in the order they were
 *  stated. Rendered on a never-run project too: the criteria are stated facts, they are simply
 *  unjudged, and listing them is how a reader sees what a run would have to conclude. */
export function AcceptanceCriteriaList({
  criteria,
  id,
  compact = false,
}: {
  criteria: AcceptanceCriterionStanding[];
  id?: string;
  compact?: boolean;
}) {
  return (
    <ul id={id} className="acceptance-criteria">
      {criteria.map((c) => {
        const identity = c.id ?? `${c.key}:${c.ordinal}`;
        return compact ? (
          // Authored text changing under the same stable criterion id must reset its measured
          // preview and disclosure state, hence text is part of this phone-only instance key.
          <MobileCriterionRow key={`${identity}:${c.text}`} criterion={c} />
        ) : (
          <li
            key={identity}
            className={`acceptance-row${c.verdict === 'FAIL' ? ' is-fail' : ''}`}
          >
            <span className="acceptance-row-no">{c.ordinal}</span>
            <span className="acceptance-row-text">
              <Markdown remarkPlugins={[remarkGfm]} components={INLINE_ONLY}>
                {c.text}
              </Markdown>
            </span>
            <span className="acceptance-row-verdict">
              <VerdictBadge verdict={c.verdict} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The card's bottom line, in every loaded state: what the two numbers on this page mean, so the
 *  task tally is not read as the answer. */
function OutcomeNote() {
  return (
    <div className="acceptance-note">
      <span className="acceptance-note-wide">
        Task completion is a process measure; acceptance is the outcome measure — a project can
        finish every task and still meet none of the criteria it was stated for.
      </span>
      <span className="acceptance-note-compact">
        Tasks track process · Acceptance tracks outcomes.
      </span>
    </div>
  );
}

/** The head's right-hand column: the standing as a number, and the meter as a picture of the same
 *  rows. No ratio before a run has earned one — `{total} unjudged` is a count of what is stated,
 *  which is a fact, where `0 / {total}` would be a score. */
function Standing({
  acceptance,
  ran,
}: {
  acceptance: ProjectAcceptanceSummary;
  ran: boolean;
}) {
  const criteria = Array.isArray(acceptance.criteria) ? acceptance.criteria : [];
  const t = tally(criteria);
  const segments = meterSegments(criteria);
  return (
    <div className="acceptance-standing-figure">
      <div className={`acceptance-score${ran ? ' is-ran' : ''}`}>
        {ran ? `${acceptance.passed} / ${acceptance.total} PASS` : `${acceptance.total} unjudged`}
      </div>
      {segments.length > 0 ? (
        <div className="acceptance-meter" role="img" aria-label={meterReading(t, ran)}>
          {segments.map((s, i) => (
            <i
              key={i}
              style={{ flex: s.weight, background: VERDICT[s.verdict].fill }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What the list shows before and after the button is pressed. Exported because a static render
 *  cannot press it: the collapsed state is what the card's own suite asserts on, and both
 *  readings are asserted here. */
export function criteriaPreview(
  criteria: AcceptanceCriterionStanding[],
  expanded: boolean,
  limit = CRITERIA_PREVIEW,
): AcceptanceCriterionStanding[] {
  return expanded ? criteria : criteria.slice(0, limit);
}

/** The never-run sentence has two visual readings of the same facts. On a wide screen it remains
 *  one explanatory line; on a phone the headline and compact detail become a scannable inset.
 *  CSS exposes only one copy at a time, so assistive technology does not hear it twice. */
function AcceptanceStanding({ acceptance }: { acceptance: ProjectAcceptanceSummary }) {
  if (acceptance.lastRunAt === null && acceptance.total > 0) {
    const count = plural(acceptance.total, 'criterion', 'criteria');
    return (
      <div className="acceptance-standing is-never">
        <span className="acceptance-standing-wide">
          {standingLine(acceptance, Date.now())}
        </span>
        <span className="acceptance-standing-compact">
          <strong className="acceptance-standing-title">Never run</strong>
          <span>{`${count} stated · Standing unknown, not zero`}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="acceptance-standing">{standingLine(acceptance, Date.now())}</div>
  );
}

/**
 * The acceptance standing of one project, fetched here rather than handed in as a prop.
 *
 * The query key and URL are the project detail page's own (`['project', id]`), so the card reads
 * the document that page already holds instead of opening a second read of it — and a write that
 * invalidates the project refreshes both.
 *
 * `action` is where the "run acceptance" control goes: the card owns its head and its states, but
 * not the decision of what starting a run does, which belongs to whoever mounts it.
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

  const acceptance = detail.data?.acceptance ?? null;
  const criteria = Array.isArray(acceptance?.criteria) ? acceptance.criteria : [];
  // A ratio is shown only once an attempt exists to have earned it. Before that there is nothing
  // to put here that is not a score: "0 / 0" and "0 / 53" both read as a result.
  const ran = acceptance !== null && acceptance.lastRunAt !== null;
  const previewLimit = phone ? MOBILE_CRITERIA_PREVIEW : CRITERIA_PREVIEW;
  const shown = criteriaPreview(criteria, expanded, previewLimit);
  const hasCriteriaDisclosure = criteria.length > previewLimit;
  const hasMeter = acceptance !== null && acceptance.total > 0 && criteria.length > 0;
  const authored = detail.data?.acceptanceCriteria?.trim();

  return (
    <Card
      className={`acceptance-card${hasMeter ? ' has-meter' : ''}`}
      title="Acceptance"
      styles={{ body: { padding: 0 } }}
      extra={
        // Nothing stated, nothing to figure: `0 unjudged` is the same mistake as `0 / 0` — a
        // number in the place a score goes, for a project that was never held to anything.
        detail.data && acceptance !== null && acceptance.total > 0 ? (
          <div className="acceptance-head-extra">
            <Standing acceptance={acceptance} ran={ran} />
            {action}
          </div>
        ) : (
          action
        )
      }
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
            message="Acceptance standing could not be loaded"
            description={detail.error instanceof Error ? detail.error.message : undefined}
          />
        </div>
      ) : acceptance === null ? (
        // Not the same as never run: this server did not answer the question at all, so there are
        // no verdicts to draw. The authored criteria are still in the document, and they are the
        // only place this reader can see what the project is held to — the page has no other.
        <>
          <div className="acceptance-standing">
            This server build does not report acceptance standing
            {authored ? ' — showing the stated criteria as written.' : '.'}
          </div>
          {authored ? (
            <div className="acceptance-block md">
              <Markdown
                remarkPlugins={[remarkGfm, remarkHardBreaks]}
                rehypePlugins={[rehypeHighlight]}
              >
                {authored}
              </Markdown>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <AcceptanceStanding acceptance={acceptance} />
          {detail.data?.acceptanceCriteriaMigration?.needsReview ? (
            <div className="acceptance-block">
              <Alert
                type="warning"
                showIcon
                message="Legacy acceptance criteria need review"
                description="This single-line text contains inline numbering. It was preserved as one criterion rather than guessed into several; resave it as structured items to confirm the intended boundaries."
              />
            </div>
          ) : null}
          <AcceptanceCriteriaList id={criteriaListId} criteria={shown} compact={phone} />
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
                    ? `View all ${acceptance.total} criteria`
                    : `Show all ${acceptance.total} criteria`}
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
