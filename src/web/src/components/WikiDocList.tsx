import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LockOutlined, RightOutlined } from '@ant-design/icons';

/**
 * A document as a list row: its number, its title, a line under it and the chevron into its page — the plan
 * page's row on a phone (mock 22 ②), and the home's at every width (design §12.3.1, mocks 30 ③, 31 ①).
 *
 * ONE ROW, TWO LINES UNDER THE TITLE: the plan's is the question the document answers; the home's is the
 * document's lead (`lead`), a shade darker, since it is what the document says rather than what it is for.
 */
export function WikiDocRow({
  to,
  number,
  title,
  line,
  lead = false,
  fresh = false,
  locked = false,
  extra,
  end,
  className,
}: {
  to: string;
  /** What stands in the number column: `3.1`, or a principle's pin. Left out, the row has no such column. */
  number?: ReactNode;
  title: ReactNode;
  /** The line under the title, two lines at most. */
  line?: ReactNode;
  /** The line is the document's lead. */
  lead?: boolean;
  /** A blue dot before the title: new since the reader last looked. */
  fresh?: boolean;
  locked?: boolean;
  /** Under the line: the plan's sections, and the errors its check found. */
  extra?: ReactNode;
  /** What ends the row in the chevron's place: a principle's day. */
  end?: ReactNode;
  /** `todo` (not written yet: the title grey), `topic` (no number column), `pr` (a principle). */
  className?: string;
}) {
  return (
    <Link className={`wk-pl-doc phone${className ? ` ${className}` : ''}`} to={to}>
      {number !== undefined && <span className="no">{number}</span>}
      <span className="main">
        <span className="t">
          {fresh && <span className="wk-new" />}
          <span className="tt">{title}</span>
          {locked && <LockOutlined className="ic lock" />}
        </span>
        {line !== undefined && <span className={lead ? 'q lead' : 'q'}>{line}</span>}
        {extra}
      </span>
      {end ?? <RightOutlined className="chev" />}
    </Link>
  );
}
