import { useId, useState } from 'react';
import { AimOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { remarkHardBreaks } from '../lib/remarkHardBreaks';

/**
 * A goal can be a one-line sentence or a small project brief. Show the complete brief on first
 * reading; anything likely to occupy more than three lines gets an explicit, accessible way to
 * collapse it in place when the reader has already absorbed it.
 *
 * This is deliberately a content hint rather than a DOM measurement. The control is present on
 * the first/server render, so it neither pops into the page after hydration nor disappears from
 * keyboard navigation when a resize observer has not fired yet.
 */
export function goalNeedsExpansion(goal: string): boolean {
  return goal.length > 160 || goal.includes('\n');
}

export function ProjectGoalCard({ goal }: { goal?: string | null }) {
  const [expanded, setExpanded] = useState(true);
  const headingId = useId();
  const contentId = useId();
  const body = goal?.trim();
  const expandable = body ? goalNeedsExpansion(body) : false;

  return (
    <section className="project-goal-card" aria-labelledby={headingId}>
      <header className="project-goal-head">
        <div className="project-goal-heading">
          <AimOutlined className="project-goal-icon" aria-hidden="true" />
          <Typography.Title id={headingId} level={5}>
            Goal
          </Typography.Title>
        </div>
        {expandable ? (
          <Button
            className="project-goal-toggle"
            type="text"
            size="small"
            aria-expanded={expanded}
            aria-controls={contentId}
            icon={expanded ? <UpOutlined /> : <DownOutlined />}
            iconPosition="end"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide details' : 'Show details'}
          </Button>
        ) : null}
      </header>

      {body ? (
        <div
          id={contentId}
          className={`project-goal-content${expandable && !expanded ? ' is-collapsed' : ''}`}
        >
          <div className="md">
            <Markdown
              remarkPlugins={[remarkGfm, remarkHardBreaks]}
              rehypePlugins={[rehypeHighlight]}
            >
              {body}
            </Markdown>
          </div>
        </div>
      ) : (
        <Typography.Paragraph className="project-goal-empty" type="secondary">
          No goal set
        </Typography.Paragraph>
      )}
    </section>
  );
}
