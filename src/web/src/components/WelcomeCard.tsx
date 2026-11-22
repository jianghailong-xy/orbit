import { RocketOutlined } from '@ant-design/icons';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { meQuery } from '../lib/queries';
import { WELCOME_LEAD, welcomeTitle } from '../lib/welcomeCopy';
import type { SessionReach } from '../lib/sessionReach';
import './MachineSetupCard.css';

/** Whether one view of the account's sessions has any session: one row at most. */
export const anySessionQuery = (view: 'open' | 'completed') =>
  queryOptions({
    queryKey: ['welcome', 'any-session', view] as const,
    // Whether there is any session moves only when one enters or leaves the lists (lib/sessionReach).
    meta: { entities: ['session'], sessionReach: 'lifecycle' satisfies SessionReach },
    queryFn: () => api<unknown>(`/sessions?view=${view}&limit=1`),
    retry: false,
  });

/**
 * Whether this account has never had a session: no Open one and no Completed one. Only then does a
 * draft page wear the welcome card (board 03, rule 1); nothing is stored to remember it. A read that
 * fails, or answers anything but two empty lists, is an account that is not new.
 */
export function useNewAccount(enabled: boolean): boolean {
  const open = useQuery({ ...anySessionQuery('open'), enabled });
  const completed = useQuery({ ...anySessionQuery('completed'), enabled });
  const empty = (data: unknown) => Array.isArray(data) && data.length === 0;
  return enabled && empty(open.data) && empty(completed.data);
}

/** The card's head: who it greets and what Orbit is, in one sentence. */
export function WelcomeHead() {
  const me = useQuery(meQuery());
  return (
    <div className="msc-head">
      <span className="msc-head-icon">
        <RocketOutlined aria-hidden="true" />
      </span>
      <div>
        <div className="msc-title">{welcomeTitle(me.data?.name)}</div>
        <div className="msc-sub">{WELCOME_LEAD}</div>
      </div>
    </div>
  );
}
