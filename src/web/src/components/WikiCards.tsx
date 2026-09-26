import { PushpinOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';

/**
 * The Wiki's card shell: the project page's Open items card, which is the frame every block on the
 * home page, the topic page and Review wears.
 *
 * REUSED RATHER THAN RESTATED. `.project-open-items` is the app's own card (a raised surface, the
 * subtle border, the 10px radius) and the design's mock links that rule and draws inside it, so the
 * only thing this adds is the head's shape — a title, an optional hint, and an optional trailing
 * action — plus the pin the Principles card leads with.
 */
export function WikiCard({
  title,
  hint,
  leading,
  trailing,
  children,
  className = '',
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** A mark before the title: the pin on Principles, the amber dot on Review. */
  leading?: ReactNode;
  /** A trailing action on the head's line: `All decisions ›`, a count pill. */
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`project-open-items wk-card ${className}`.trim()}>
      <div className="project-open-items-head">
        {leading}
        <span className="project-open-items-title">{title}</span>
        {hint !== undefined && <span className="project-open-items-hint">{hint}</span>}
        {trailing !== undefined && <span className="wk-card-trailing">{trailing}</span>}
      </div>
      {children}
    </section>
  );
}

/** The pin Principles leads with. */
export function WikiPin() {
  return <PushpinOutlined className="ic wk-pin" />;
}

/** What a block says when there is nothing in it yet. Never an empty box. */
export function WikiEmpty({ children }: { children: ReactNode }) {
  return <div className="wk-empty">{children}</div>;
}
