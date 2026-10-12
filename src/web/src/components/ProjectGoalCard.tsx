import { useId } from 'react';
import { AimOutlined } from '@ant-design/icons';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ReferenceLink, referenceUrlTransform } from '../lib/markdownLinks';
import { remarkHardBreaks } from '../lib/remarkHardBreaks';
import './ui/Typography.css';

export function ProjectGoalCard({ goal }: { goal?: string | null }) {
  const headingId = useId();
  const body = goal?.trim();

  return (
    <section className="project-goal-card" aria-labelledby={headingId}>
      <header className="project-goal-head">
        <div className="project-goal-heading">
          <AimOutlined className="project-goal-icon" aria-hidden="true" />
          <h5 id={headingId} className="orbit-typography">
            Goal
          </h5>
        </div>
      </header>

      {body ? (
        <div className="project-goal-content">
          <div className="md">
            <Markdown
              remarkPlugins={[remarkGfm, remarkHardBreaks]}
              rehypePlugins={[rehypeHighlight]}
              urlTransform={referenceUrlTransform}
              components={{ a: ReferenceLink }}
            >
              {body}
            </Markdown>
          </div>
        </div>
      ) : (
        <div className="project-goal-empty orbit-typography orbit-typography-secondary">
          No goal set
        </div>
      )}
    </section>
  );
}
