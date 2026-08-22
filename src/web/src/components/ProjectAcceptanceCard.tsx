import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Skeleton, Tag, Typography } from 'antd';
import { api } from '../api';

/**
 * The OUTCOME half of "is this project done", drawn from `GET /projects/:id` → `acceptance`.
 *
 * The rest of a project page counts tasks, which is a PROCESS measure: it reaches 100% whether or
 * not anything the project was stated for was ever checked. This card shows the other number —
 * how many of the stated criteria the LATEST acceptance attempt concluded PASS about — and, for
 * the common case where no attempt has ever run, says exactly that instead of implying a score.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT
 *
 *  - **A verdict is text before it is a colour.** Every badge carries PASS / FAIL / — as glyphs.
 *    Hue is the second signal, never the only one.
 *  - **Never run is not zero.** A project with 53 stated criteria and no run is the normal state,
 *    not a failing one. It gets a stated empty state and no ratio at all, because "0 / 53" and
 *    "0 / 0" both read as a score somebody earned.
 */

/** One stated criterion and what the latest attempt currently says about it.
 *
 *  `UNDECIDED` is a value the server sends rather than an absence: it covers both a criterion the
 *  current run has not reached and every criterion of a project no run has ever judged. */
export interface AcceptanceCriterionStanding {
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

/** The only part of the project detail document this card reads. Optional because a server that
 *  predates the field serves the rest of the document unchanged, and that is a different answer
 *  from "never run" — see {@link ProjectAcceptanceCard}. */
interface ProjectAcceptanceDetail {
  acceptance?: ProjectAcceptanceSummary | null;
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
  { label: string; accessible: string; color: string; background: string; border: string }
> = {
  PASS: {
    label: 'PASS',
    accessible: 'Passed',
    color: 'var(--success)',
    background: 'var(--success-bg)',
    border: 'var(--success-border)',
  },
  FAIL: {
    label: 'FAIL',
    accessible: 'Failed',
    color: 'var(--error)',
    background: 'var(--error-bg)',
    border: 'var(--error-border)',
  },
  INCONCLUSIVE: {
    label: 'INCONCLUSIVE',
    accessible: 'Inconclusive',
    color: 'var(--warning)',
    background: 'var(--warning-bg)',
    border: 'var(--warning-border)',
  },
  UNDECIDED: {
    label: '—',
    accessible: 'Not judged yet',
    color: 'var(--text-3)',
    background: 'var(--fill-muted)',
    border: 'var(--border)',
  },
};

/** One verdict, as a word. The em dash of an undecided criterion is the one label that is not a
 *  word, so it carries the sentence in `aria-label` and `title` instead — a screen reader that
 *  read it out as "dash" would be told nothing. */
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
        minWidth: 52,
        textAlign: 'center',
      }}
    >
      {v.label}
    </Tag>
  );
}

/** Every stated criterion with what the latest attempt says about it, in the order they were
 *  stated. Rendered on a never-run project too: the criteria are stated facts, they are simply
 *  unjudged, and listing them is how a reader sees what a run would have to conclude. */
export function AcceptanceCriteriaList({ criteria }: { criteria: AcceptanceCriterionStanding[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {criteria.map((c, i) => (
        <li
          key={c.key}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '6px 0',
            // Between rows only: a rule on the first one would double up with the card head's.
            borderTop: i === 0 ? undefined : '1px solid var(--border-subtle)',
          }}
        >
          <VerdictBadge verdict={c.verdict} />
          <span style={{ flex: 1, minWidth: 0 }}>{c.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The card's bottom line, in every loaded state: what the two numbers on this page mean, so the
 *  task tally is not read as the answer. */
function OutcomeNote() {
  return (
    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
      Task completion is a process measure; acceptance is the outcome measure — a project can
      finish every task and still meet none of the criteria it was stated for.
    </Typography.Paragraph>
  );
}

/**
 * The acceptance standing of one project, fetched here rather than handed in as a prop.
 *
 * The query key and URL are the project detail page's own (`['project', id]`), so the card reads
 * the document that page already holds instead of opening a second read of it — and a write that
 * invalidates the project refreshes both.
 *
 * `action` is where the "run acceptance" control goes: the card owns the never-run state and its
 * layout, but not the decision of what starting a run does, which belongs to whoever mounts it.
 */
export function ProjectAcceptanceCard({
  projectId,
  action,
}: {
  projectId: string;
  action?: ReactNode;
}) {
  const detail = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectAcceptanceDetail>(`/projects/${encodeURIComponent(projectId)}`),
    enabled: Boolean(projectId),
  });

  const acceptance = detail.data?.acceptance ?? null;
  // A ratio is shown only once an attempt exists to have earned it. Before that there is nothing
  // to put here that is not a score: "0 / 0" and "0 / 53" both read as a result.
  const ran = acceptance !== null && acceptance.lastRunAt !== null;

  return (
    <Card
      title="Acceptance"
      extra={
        ran ? (
          <Typography.Text style={{ fontVariantNumeric: 'tabular-nums' }}>
            {`${acceptance.passed} / ${acceptance.total}`}
          </Typography.Text>
        ) : null
      }
    >
      {detail.isPending ? (
        <Skeleton active title={false} paragraph={{ rows: 3 }} />
      ) : detail.isError ? (
        <Alert
          type="error"
          showIcon
          message="Acceptance standing could not be loaded"
          description={detail.error instanceof Error ? detail.error.message : undefined}
        />
      ) : acceptance === null ? (
        // Not the same as never run: this server did not answer the question at all, and saying
        // "never run" for it would be this card inventing a fact.
        <Typography.Text type="secondary">
          This server build does not report acceptance standing.
        </Typography.Text>
      ) : (
        <>
          {ran ? null : (
            <div style={{ marginBottom: acceptance.criteria.length > 0 ? 12 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <Typography.Text strong>Acceptance has never been run</Typography.Text>
                {action}
              </div>
              <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0 }}>
                {acceptance.total === 0
                  ? 'No criteria are stated for this project, so there is nothing for a run to conclude.'
                  : `${acceptance.total} criteria are stated and none has been judged. This project's standing is unknown, not zero.`}
              </Typography.Paragraph>
            </div>
          )}
          <AcceptanceCriteriaList criteria={acceptance.criteria} />
          <OutcomeNote />
        </>
      )}
    </Card>
  );
}
