import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import { ArrowLeftOutlined, HistoryOutlined, RightOutlined } from '@ant-design/icons';
import { WikiCard, WikiEmpty } from './WikiCards';
import { RECENT_DECISIONS, ReviewCard, TimelineRow, UsageCard, WikiDecisionRows, reviewOps } from './WikiHome';
import { WikiDot } from './WikiMarks';
import { WikiPlanBanners, WikiPlanCard } from './WikiPlanCard';
import { WikiRunTimelineRow } from './WikiRunPage';
import {
  wikiEntriesOfKindQuery,
  wikiEntriesQuery,
  wikiReviewQuery,
  wikiSpaceQuery,
  wikiTimelineQuery,
} from '../lib/queries';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import {
  WIKI_ACTIVITY,
  WIKI_ALL_DECISIONS,
  WIKI_NO_CHANGES,
  WIKI_NO_DECISIONS,
  WIKI_RECENT_DECISIONS,
  WIKI_RECENT_DECISIONS_HINT,
  WIKI_RECENTLY_CHANGED,
  WIKI_REVIEW_PATH,
  WIKI_TITLE,
  moveWikiSeen,
  readWikiSeenBefore,
  wikiActivityPath,
  wikiEntriesOfKind,
  wikiNewSinceLastLooked,
  wikiSeenKey,
  wikiSpacePath,
  wikiTopicPath,
  wikiWaitingOnYou,
  type WikiSpaceRow,
} from '../lib/wiki';
import { wikiRecentRows } from '../lib/wikiReviewMode';
import { wikiProposalsBanner, wikiProposalsElsewhere, wikiProposalsWaiting, wikiSpaceNames } from '../lib/wikiSpace';

/**
 * Activity (design §12.3.2, mocks 31 ② and 33 ④): what the Wiki home said besides its content — how the
 * space is kept, what waits on the owner, what was decided and changed lately, and what the agents used.
 *
 * THE HOME'S BLOCKS, MOVED AND IN THEIR ORDER: the status row, Review's banner (a phone) or card (a
 * desktop), the plan's banners or card, Recent decisions, Recently changed, Agents used the wiki. Its
 * head is Review's: `← Wiki` and the big title on a phone, with the space's name beside it; on a desktop
 * the page stands in the Wiki's frame under `Wiki › Activity`, the directory beside it with no row lit.
 *
 * WHAT WAITS IS COUNTED ACROSS EVERY SPACE (§12.3.3). The first banner is every space's proposals, each
 * other space's share said on its line, and it opens Review over all of them; the plan's banners follow,
 * one for each kind of thing waiting, another space's saying which space. Together they are the number
 * on the head's Activity badge and the sidebar's Wiki row (`wikiWaiting`), each banner's part of it in
 * `data-waiting`. A desktop draws cards for this space instead (mock 33 ④ ⑤), so nothing waiting
 * elsewhere may hide behind them: its Review card counts every space's proposals and says the other
 * spaces' shares as the banner does, and the other spaces' plan banners stand over the cards.
 *
 * WHAT IS NEW is what came after the reader last looked at this space (`wikiSeenKey(space, 'home')`, the
 * stamp the home keeps): those rows of Recently changed wear a blue dot and are counted beside its title.
 */
export function WikiActivityPage({
  space,
  spaces,
  status,
}: {
  space: WikiSpaceRow;
  /** Every space of the owner, as the list read answers it — `space` among them. */
  spaces: readonly WikiSpaceRow[];
  /** The frame's status row, which on this page stands under the title. */
  status: ReactNode;
}) {
  const detail = useQuery(wikiSpaceQuery(space.id));
  const decisionRead = useQuery(wikiEntriesOfKindQuery(space.id, 'decision', RECENT_DECISIONS));
  // The newest entries of every kind, which the frame reads anyway: only to name the entry a decision
  // was superseded by.
  const entries = useQuery(wikiEntriesQuery(space.id));
  const timeline = useQuery(wikiTimelineQuery(space.id));
  const review = useQuery(wikiReviewQuery(space.id));
  const names = useMemo(() => wikiSpaceNames(spaces), [spaces]);

  // Read before this page moves the stamp, and before the home did if the reader came from it.
  const seenKey = wikiSeenKey(space.slug, 'home');
  const [seen] = useState(() => readWikiSeenBefore(seenKey));
  useEffect(() => moveWikiSeen(seenKey), [seenKey]);

  const decisions = useMemo(() => wikiEntriesOfKind(decisionRead.data ?? [], 'decision'), [decisionRead.data]);
  const entryById = useMemo(
    () => new Map([...(entries.data ?? []), ...decisions].map((entry) => [entry.id, entry])),
    [entries.data, decisions],
  );
  const pending = useMemo(() => reviewOps(review.data ?? []), [review.data]);
  const rows = useMemo(() => wikiRecentRows(timeline.data?.items ?? []).slice(0, 5), [timeline.data]);
  const fresh = (at: string): boolean => seen <= 0 || Date.parse(at) > seen;
  const freshRows = rows.filter((row) => fresh(row.kind === 'run' ? row.at : row.item.at)).length;

  const proposals = wikiProposalsBanner(spaces, space.id, names);
  const elsewhere = spaces.filter((row) => row.id !== space.id && (row.planWaiting ?? 0) > 0);
  const reviewElsewhere = wikiProposalsElsewhere(spaces, space.id, names);

  return (
    <div className="wk-act">
      <div className="wk-crumb wk-crumb--back">
        <Link to={wikiSpacePath(space.slug)}>
          <ArrowLeftOutlined className="back" />
          {WIKI_TITLE}
        </Link>
        <RightOutlined className="ic" />
        <span>{WIKI_ACTIVITY}</span>
      </div>
      <div className="wk-act-head">
        <h1 className="page-title">{WIKI_ACTIVITY}</h1>
        <span className="wk-space-tag">{names.get(space.id) ?? space.title}</span>
      </div>
      {status}

      {/* A phone's banners (mock 31 ②): the proposals of every space, then what each plan waits for — another
          space's on a desktop too, over the cards. */}
      {proposals && (
        <Link className="wk-banner" to={WIKI_REVIEW_PATH} data-waiting={wikiProposalsWaiting(spaces)}>
          <WikiDot tone="amber" />
          <span className="t">{proposals}</span>
          <RightOutlined className="ic" />
        </Link>
      )}
      <WikiPlanBanners space={space} />
      {elsewhere.map((row) => (
        <WikiPlanBanners key={row.id} space={row} elsewhere={names.get(row.id) ?? row.title} />
      ))}

      <div className="wk-act-cards">
        <ReviewCard space={space} pending={pending} changesets={review.data ?? []} elsewhere={reviewElsewhere} />
        <WikiPlanCard space={space} />
        <WikiCard
          title={WIKI_RECENT_DECISIONS}
          hint={WIKI_RECENT_DECISIONS_HINT}
          trailing={
            <Link className="wk-card-more" to={wikiTopicPath(space.slug, 'decisions')}>
              {WIKI_ALL_DECISIONS}
            </Link>
          }
          className="wk-decisions-card"
        >
          {decisions.length === 0 ? (
            <WikiEmpty>{WIKI_NO_DECISIONS}</WikiEmpty>
          ) : (
            <WikiDecisionRows decisions={decisions.slice(0, RECENT_DECISIONS)} entryById={entryById} spaceSlug={space.slug} />
          )}
        </WikiCard>
        <WikiCard
          title={WIKI_RECENTLY_CHANGED}
          hint={
            freshRows > 0 ? (
              <span className="wk-new-hint">
                <span className="wk-new" />
                {wikiNewSinceLastLooked(freshRows)}
              </span>
            ) : undefined
          }
          className="wk-changed-card"
        >
          {rows.length === 0 ? (
            <WikiEmpty>{WIKI_NO_CHANGES}</WikiEmpty>
          ) : (
            <ol className="wk-tl">
              {rows.map((row) =>
                row.kind === 'run' ? (
                  <WikiRunTimelineRow
                    key={row.changesetId}
                    changesetId={row.changesetId}
                    origin={row.origin}
                    at={row.at}
                    changes={row.items.length}
                    spaceSlug={space.slug}
                    fresh={fresh(row.at)}
                  />
                ) : (
                  <TimelineRow key={row.item.opId} item={row.item} spaceSlug={space.slug} fresh={fresh(row.item.at)} />
                ),
              )}
            </ol>
          )}
        </WikiCard>
        {detail.data && <UsageCard space={detail.data} />}
      </div>
    </div>
  );
}

/**
 * The head's way into Activity (design §12.3.2): the history mark — with its word on a desktop, alone on
 * a phone, as Settings is — and, in its corner, the collapsed sidebar's amber badge with the number
 * waiting on the owner (`wikiWaiting`, the sidebar's own count), none at zero. Pressed on Activity.
 */
export function WikiActivityButton({ spaceSlug, waiting, on }: { spaceSlug: string; waiting: number; on: boolean }) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  const badge = useId();
  return (
    <Button
      className={`wk-activity-btn${on ? ' on' : ''}`}
      icon={<HistoryOutlined />}
      aria-label={WIKI_ACTIVITY}
      aria-current={on ? 'page' : undefined}
      aria-describedby={waiting > 0 ? badge : undefined}
      onClick={() => navigate(wikiActivityPath(spaceSlug))}
    >
      {phone ? null : WIKI_ACTIVITY}
      {waiting > 0 && (
        <span id={badge} className="tp-rail-badge needs-you" title={wikiWaitingOnYou(waiting)} aria-label={wikiWaitingOnYou(waiting)}>
          {waiting}
        </span>
      )}
    </Button>
  );
}
