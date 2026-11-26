import { Link } from 'react-router-dom';
import { pauseResumeTime } from '../lib/accountPause';
import type { TaskAccountHold } from '../lib/accountHealth';
import { Badge } from './ui/Badge';
import { Tooltip } from './ui/Tooltip';

/** Where an account's row, and its Check again, lives. */
export const ACCOUNTS_HREF = '/settings/machines';
/** The Model routing page, where "Run pinned tasks elsewhere" is. */
export const RELAX_PINS_HREF = '/settings/providers/routing#relaxBlockedPins';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A task whose next automatic start stands down because no account that could run it can run now
 * (docs/routing-account-health-design.md §7.5): Held, the server's sentence (the provider's words and the next try),
 * a link to the account row, and for a pinned task the setting that would let it run elsewhere.
 */
export function TaskAccountHoldNote({ hold }: { hold: TaskAccountHold }) {
  return (
    <span className="task-sign-in-hold" data-testid="task-account-hold">
      <Badge tone="gold" title={hold.reason}>Held</Badge>{' '}
      <span className="task-sign-in-hold-reason">{hold.reason}</span>{' '}
      <Link className="task-sign-in-hold-action" to={ACCOUNTS_HREF} onClick={stop} onMouseDown={stop}>Open account</Link>
      {hold.setting ? (
        <>{' '}<Link className="task-sign-in-hold-action" to={RELAX_PINS_HREF} onClick={stop} onMouseDown={stop}>Run elsewhere</Link></>
      ) : null}
    </span>
  );
}

/** A pinned task that ran elsewhere says which pin, where it ran and why (§7.5), in the server's sentence. */
export function RelaxedRunNote({ sentence }: { sentence: string }) {
  return <div className="tdp-relaxed-run" data-testid="relaxed-run">{sentence}</div>;
}

/** The hold's text for a row: `Held · Cursor said "…" · Next try 13:19`, the provider's words and the first next trial. */
export function accountHoldLineText(hold: TaskAccountHold): string {
  const words = hold.accounts[0]?.line ?? hold.reason;
  const next = hold.accounts[0] ? ` · Next try ${pauseResumeTime(hold.until)}` : '';
  return `Held · ${words}${next}`;
}

/**
 * The hold on a task list or project row: ONE quiet line under the title, in the row's secondary style, never a chip that
 * takes the title's room. `Held · <provider's words> · Next try <time>` truncates; the whole sentence is its hover title
 * and its accessible name, and Open account stays pressable at the end.
 */
export function TaskAccountHoldLine({ hold }: { hold: TaskAccountHold }) {
  const text = accountHoldLineText(hold);
  const full = `${text} · Open account`;
  return (
    <Tooltip content={full} truncatedOnly>
      <div className="task-hold-line" data-testid="task-account-hold-line">
        <span className="task-hold-line-text" aria-label={full}>{text}</span>
        <Link className="task-hold-line-action" to={ACCOUNTS_HREF} onClick={stop} onMouseDown={stop}>Open account</Link>
      </div>
    </Tooltip>
  );
}
