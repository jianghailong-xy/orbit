import { useId } from 'react';
import { AimOutlined } from '@ant-design/icons';
import { Typography } from 'antd';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { remarkHardBreaks } from '../lib/remarkHardBreaks';

export function ProjectGoalCard({ goal }: { goal?: string | null }) {
  const headingId = useId();
  const body = goal?.trim();

  return (
    <section className="project-goal-card" aria-labelledby={headingId}>
      <header className="project-goal-head">
        <div className="project-goal-heading">
          <AimOutlined className="project-goal-icon" aria-hidden="true" />
          <Typography.Title id={headingId} level={5}>
            Goal
          </Typography.Title>
        </div>
      </header>

      {body ? (
        <div className="project-goal-content">
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
