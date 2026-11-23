import { Link } from 'react-router-dom';
import type { TaskAccountHold } from '../lib/accountHealth';
import { Badge } from './ui/Badge';

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
