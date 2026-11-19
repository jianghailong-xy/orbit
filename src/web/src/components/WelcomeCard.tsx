import { RocketOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { meQuery } from '../lib/queries';
import { WELCOME_LEAD, welcomeTitle } from '../lib/welcomeCopy';
import './MachineSetupCard.css';

/**
 * Whether this account has never had a session: no Open one and no Completed one. Only then does a
 * draft page wear the welcome card (board 03, rule 1); nothing is stored to remember it. A read that
 * fails, or answers anything but two empty lists, is an account that is not new.
 */
export function useNewAccount(enabled: boolean): boolean {
  const read = (view: 'open' | 'completed') =>
    ({
      queryKey: ['welcome', 'any-session', view] as const,
      meta: { entities: ['session'] },
      queryFn: () => api<unknown>(`/sessions?view=${view}&limit=1`),
      enabled,
      retry: false,
    }) as const;
  const open = useQuery(read('open'));
  const completed = useQuery(read('completed'));
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
