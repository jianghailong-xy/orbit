import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Spin } from 'antd';
import { useSearchParams } from 'react-router-dom';
import type { WatchView } from '@orbit/shared';
import { WatchCard } from '../components/WatchCard';
import { watchesQuery } from '../lib/queries';
import {
  groupWatches,
  sameResourceId,
  watchBucket,
  watchErrorMessage,
  type WatchBucket,
} from '../lib/watches';

/** The most rows `GET /watches` answers with (WatchesService LIST_LIMIT). */
export const FOLLOWING_LIST_LIMIT = 100;

const TABS: readonly { key: WatchBucket; label: string; empty: string }[] = [
  {
    key: 'active',
    label: 'Active',
    empty:
      'Nothing is being followed right now. Follow a session or a task from its page, or have an agent wait on work for you.',
  },
  {
    key: 'attention',
    label: 'Needs attention',
    empty:
      'Nothing needs attention. A watch lands here when it stops without triggering, loses access to a target, or fails to deliver.',
  },
  { key: 'history', label: 'Triggered history', empty: 'No watch has ended yet.' },
];

const isBucket = (value: string | null): value is WatchBucket => TABS.some((tab) => tab.key === value);

/**
 * Everything this account follows, filed by what it asks of a reader: Active (still waiting), Needs
 * attention (an end or a failure nobody would otherwise hear about — lib/watches `watchProblem`) and
 * Triggered history (every other end, newest first). `?watch=<id>` opens that watch's card on its
 * tab, and `?tab=` picks a tab.
 */
export function FollowingPage() {
  const [params, setParams] = useSearchParams();
  const watchesQ = useQuery(watchesQuery());
  const data = watchesQ.data;
  const watches = useMemo<WatchView[]>(() => (Array.isArray(data) ? data : []), [data]);
  const groups = useMemo(() => groupWatches(watches), [watches]);
  const wanted = params.get('watch');
  const focused = wanted ? watches.find((w) => sameResourceId(w.id, wanted)) : undefined;
  const focusedId = focused?.id;
  const tabParam = params.get('tab');
  const tab: WatchBucket = isBucket(tabParam) ? tabParam : focused ? watchBucket(focused) : 'active';
  const current = TABS.find((t) => t.key === tab)!;

  useEffect(() => {
    if (!focusedId) return;
    const card = [...document.querySelectorAll<HTMLElement>('[data-watch-id]')].find(
      (el) => el.dataset.watchId === focusedId,
    );
    card?.scrollIntoView?.({ block: 'center' });
  }, [focusedId]);

  return (
    <div className="following-page">
      <header className="following-head">
        <h1 className="page-title">Following</h1>
        <p className="following-sub">
          What you and your sessions are waiting on. A watch waits on the server, so nothing keeps
          running in the background.
        </p>
      </header>
      <div className="following-tabs" role="tablist" aria-label="Watches">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`following-tab${tab === key ? ' is-on' : ''}`}
            onClick={() => setParams({ tab: key }, { replace: true })}
          >
            {label}
            <span
              className={`following-count${key === 'attention' && groups.attention.length > 0 ? ' is-alert' : ''}`}
            >
              {groups[key].length}
            </span>
          </button>
        ))}
      </div>
      {wanted && watchesQ.isSuccess && !focused && (
        <div className="following-note">
          That watch isn’t in this list, which holds the {FOLLOWING_LIST_LIMIT} most recent watches.
        </div>
      )}
      <div role="tabpanel" className="following-panel">
        {watchesQ.isPending ? (
          <div className="following-empty">
            <Spin />
          </div>
        ) : watchesQ.isError ? (
          <div className="following-empty">
            Couldn’t load watches: {watchErrorMessage(watchesQ.error)}{' '}
            <Button size="small" onClick={() => void watchesQ.refetch()}>
              Retry
            </Button>
          </div>
        ) : groups[tab].length === 0 ? (
          <div className="following-empty">{current.empty}</div>
        ) : (
          <div className="watch-list">
            {groups[tab].map((w) => (
              // Keyed by focus too, so a card asked for by `?watch=` opens even if it was on screen.
              <WatchCard key={w.id === focusedId ? `${w.id}:focused` : w.id} watch={w} focused={w.id === focusedId} />
            ))}
          </div>
        )}
      </div>
      {watches.length >= FOLLOWING_LIST_LIMIT && (
        <div className="following-note">Showing the {FOLLOWING_LIST_LIMIT} most recent watches.</div>
      )}
    </div>
  );
}
