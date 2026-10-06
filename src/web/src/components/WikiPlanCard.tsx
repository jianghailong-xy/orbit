import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import type { WikiSpace } from '@orbit/shared';
import { relTime } from './Transcript';
import { WikiCard } from './WikiCards';
import { WikiDot } from './WikiMarks';
import { wikiDocsQuery, wikiPlanQuery } from '../lib/queries';
import { useWikiMaintenanceWhere } from '../lib/useWikiMaintenanceWhere';
import { wikiSettingsPath } from '../lib/wikiReviewMode';
import {
  WIKI_PLAN_REDRAFT_ALREADY,
  WIKI_PLAN_REDRAFT_ASKED,
  WIKI_PLAN_TITLE,
  wikiPlanBanner,
  wikiPlanCard,
  wikiPlanCardRow,
  wikiPlanFromVersion,
  wikiPlanLook,
  wikiPlanPath,
  wikiPlanWaitingBanners,
  type WikiPlanLook,
} from '../lib/wikiPlan';
import { wikiInSpace } from '../lib/wiki';
import { redraftWikiPlan, useWikiWrite } from '../lib/wikiWrites';
import { useToast } from '../lib/toast';

/**
 * The plan on the Wiki home (owner's call 2026-09-29, mocks 25 ③ and 26 ③): the first card of the right
 * rail on a desktop, the second banner on a phone, under Review's. Its changes are handled on the plan
 * page and not in Review.
 *
 * ONE LOOK, TWO SHAPES (`wikiPlanLook`): amber while something waits on the owner — a held draft, a draft
 * that failed, a draft to confirm, changes to review — which the directory's Plan count counts too; blue
 * while a draft is on its way or the documents are being written; an invitation while there is no plan.
 * With a plan in force, all its documents written and nothing waiting, neither is drawn.
 */
function usePlanLook(space: WikiSpace) {
  const plan = useQuery(wikiPlanQuery(space.id));
  const docs = useQuery(wikiDocsQuery(space.id));
  const maintenance = useWikiMaintenanceWhere(space);
  const counts = docs.data?.plan ? docs.data.docs : null;
  const look: WikiPlanLook | null = plan.data ? wikiPlanLook(plan.data, { runnerOnline: maintenance.runnerOnline }) : null;
  return { plan: plan.data, look, counts, maintenance };
}

/** The phone's banner: one line, pressed into the plan page — or, held, into the space's Maintenance. */
export function WikiPlanBanner({ space }: { space: WikiSpace }) {
  const { plan, look, counts, maintenance } = usePlanLook(space);
  if (!plan || !look) return null;
  const banner = wikiPlanBanner(look, plan, { now: Date.now(), docs: counts, runnerOnline: maintenance.runnerOnline });
  return (
    <Link className={`wk-banner wk-plan-banner ${banner.tone}`} to={banner.to === 'settings' ? wikiSettingsPath(space.slug) : wikiPlanPath(space.slug)}>
      <WikiDot tone={banner.tone === 'amber' ? 'amber' : 'blue'} />
      <span className="t">{banner.text}</span>
      <RightOutlined className="ic" />
    </Link>
  );
}

/**
 * Activity's plan banners (design §12.3.3): the home's banner once for each kind of thing the plan waits
 * on the owner for — how many it is in `data-waiting`, so the page's amber banners add up to the head's
 * badge — and, with nothing waiting, the plan's blue banner as the home draws it. Another space's
 * (`elsewhere`, its name) are only what waits there, each saying which space it is.
 */
export function WikiPlanBanners({ space, elsewhere = null }: { space: WikiSpace; elsewhere?: string | null }) {
  const { plan, look, counts, maintenance } = usePlanLook(space);
  if (!plan || !look) return null;
  const context = { now: Date.now(), docs: counts, runnerOnline: maintenance.runnerOnline };
  const waiting = wikiPlanWaitingBanners(plan, context);
  const banners = waiting.length > 0 || elsewhere ? waiting : [{ ...wikiPlanBanner(look, plan, context), look, count: 0 }];
  return (
    <>
      {banners.map((banner) => (
        <Link
          key={banner.look}
          className={`wk-banner wk-plan-banner ${banner.tone}`}
          data-waiting={banner.tone === 'amber' ? banner.count : undefined}
          to={banner.to === 'settings' ? wikiSettingsPath(space.slug) : wikiPlanPath(space.slug)}
        >
          <WikiDot tone={banner.tone === 'amber' ? 'amber' : 'blue'} />
          <span className="t">{elsewhere ? `${banner.text} ${wikiInSpace(elsewhere)}` : banner.text}</span>
          <RightOutlined className="ic" />
        </Link>
      ))}
    </>
  );
}

/** The desktop's card, over Review: its dot and count, its sentence or its changes, and its buttons. */
export function WikiPlanCard({ space }: { space: WikiSpace }) {
  const navigate = useNavigate();
  const message = useToast();
  const { plan, look, counts, maintenance } = usePlanLook(space);
  const draft = useWikiWrite(() => redraftWikiPlan(space.id, null));
  if (!plan || !look) return null;
  const card = wikiPlanCard(look, plan, { now: Date.now(), docs: counts, runnerOnline: maintenance.runnerOnline, provider: maintenance.provider });
  const base = plan.confirmed ? wikiPlanFromVersion(plan.confirmed) : null;
  const amber = card.dot === 'amber' || look === 'noPlan';
  const go = async (to: 'draft' | 'plan' | 'settings') => {
    if (to === 'plan') return navigate(wikiPlanPath(space.slug));
    if (to === 'settings') return navigate(wikiSettingsPath(space.slug));
    try {
      const answer = await draft.mutateAsync(undefined);
      message.success(answer.created ? WIKI_PLAN_REDRAFT_ASKED : WIKI_PLAN_REDRAFT_ALREADY);
      navigate(wikiPlanPath(space.slug));
    } catch (error) {
      message.error("Couldn't draft the plan", error instanceof Error ? error.message : undefined);
    }
  };
  return (
    <WikiCard
      title={WIKI_PLAN_TITLE}
      leading={card.dot ? <WikiDot tone={card.dot === 'amber' ? 'amber' : card.dot === 'blue' ? 'blue' : 'muted'} /> : undefined}
      trailing={card.count !== null ? <span className="tp-count needs-you">{card.count}</span> : undefined}
      className={`wk-plan-card look-${look}`}
    >
      {card.sub && <div className="project-open-items-hint wk-review-sub">{card.sub}</div>}
      {card.text && <div className="wk-plan-card-text">{card.text}</div>}
      {look === 'changes' &&
        plan.proposals.slice(0, 3).map((proposal, index) => {
          const row = wikiPlanCardRow(proposal, base);
          return (
            <div className={`wk-rv-row${index === 0 ? ' first' : ''}`} key={proposal.id}>
              <span className="wk-op add plan">{row.op}</span>
              <span className="t">{row.text}</span>
              <span className="a">{relTime(proposal.createdAt)}</span>
            </div>
          );
        })}
      <div className="wk-rv-foot">
        <Button type={amber ? 'primary' : 'default'} size="small" loading={draft.isPending} onClick={() => void go(card.primary.to)}>
          {card.primary.label}
        </Button>
        {card.secondary && (
          <Link className="wk-plan-card-link" to={wikiPlanPath(space.slug)}>
            {card.secondary.label}
          </Link>
        )}
        {card.note && <span className="hint">{card.note}</span>}
      </div>
    </WikiCard>
  );
}
