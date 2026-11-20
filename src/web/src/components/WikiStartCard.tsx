import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckOutlined } from '@ant-design/icons';
import { WikiCreateDialog, WikiSetUpDialog, useWikiWorkspaceChoices } from './WikiSetUpDialog';
import { Button } from './ui/Button';
import { encodeId } from '../lib/idCodec';
import { wikiDocsQuery, wikiPlanQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useWikiMaintenanceWhere } from '../lib/useWikiMaintenanceWhere';
import { useMachinesHref } from '../lib/useMachinesHref';
import { wikiSpaceSettings } from '@orbit/shared';
import type { WikiSpaceRow } from '../lib/wiki';
import { WIKI_PLAN_REDRAFT_ALREADY, WIKI_PLAN_REDRAFT_ASKED, WIKI_PLAN_WRITING_NOW, wikiPlanPath } from '../lib/wikiPlan';
import { wikiStartCard, wikiStartFirstCard, type WikiStartActionTo, type WikiStartCard as Card } from '../lib/wikiStart';
import { wikiTrashHoldsWhenEmpty } from '../lib/wikiReviewMode';
import { redraftWikiPlan, useWikiWrite } from '../lib/wikiWrites';
import { WikiTrashLink } from './WikiTrashDialog';

/** The card itself (mock 41): three steps, wide or stacked by its own width, and at most one primary button. */
function WikiStartSteps({
  card,
  busy,
  onAction,
  underLead,
}: {
  card: Card;
  busy: boolean;
  onAction: (to: WikiStartActionTo) => void;
  /** What the first-wiki card says under its lead: the way to the wikis in Trash (docs/mocks/wiki-trash). */
  underLead?: ReactNode;
}) {
  return (
    <section className="wk-start" aria-label={card.title}>
      <div className="wk-start-h">
        <b>{card.title}</b>
        <span>{card.lead}</span>
        {underLead}
      </div>
      <ol className="wk-start-steps">
        {card.steps.map((step, index) => (
          <li key={step.title} className={`wk-start-step is-${step.state}`} aria-current={step.state === 'wait' || step.state === 'run' ? 'step' : undefined}>
            <div className="wk-start-head">
              <span className="wk-start-no">{step.state === 'done' ? <CheckOutlined className="ic" /> : index + 1}</span>
              <span className="wk-start-t">{step.title}</span>
            </div>
            <div className="wk-start-body">
              <div className="wk-start-d">{step.text}</div>
              {step.progress && (
                <div className="wk-pl-prog">
                  <div className="bar">
                    <i style={{ width: `${Math.round((step.progress.done / Math.max(1, step.progress.total)) * 100)}%` }} />
                  </div>
                  {step.progress.now && (
                    <div className="next">
                      {WIKI_PLAN_WRITING_NOW} <b>{step.progress.now}</b>
                    </div>
                  )}
                </div>
              )}
              {step.note && <div className="wk-start-note">{step.note}</div>}
              {step.action && (
                <div className="wk-start-act">
                  <Button
                    variant={step.action.primary ? 'primary' : 'default'}
                    loading={busy && step.action.to === 'draft'}
                    onClick={() => onAction(step.action!.to)}
                  >
                    {step.action.label}
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The home of a wiki with nothing to read (design §12.3.1): where it stands on the way to something, read from
 * the plan as Activity's card reads it. What the owner has to do is done from here — the form opens where they
 * are, a draft is asked for on the spot — and only the plan, which has to be read before it is confirmed, sends
 * them to its page.
 */
export function WikiStartCard({ space }: { space: WikiSpaceRow }) {
  const navigate = useNavigate();
  const message = useToast();
  const plan = useQuery(wikiPlanQuery(space.id));
  const docs = useQuery(wikiDocsQuery(space.id));
  const { runnerOnline } = useWikiMaintenanceWhere(space);
  const machinesHref = useMachinesHref();
  const { choices } = useWikiWorkspaceChoices();
  const draft = useWikiWrite(() => redraftWikiPlan(space.id, null));
  const [settingUp, setSettingUp] = useState(false);
  if (!plan.data) return null;

  const { maintenance } = wikiSpaceSettings(space.settings);
  const workspace = maintenance.workspaceId ? choices.find((choice) => encodeId(choice.id) === encodeId(maintenance.workspaceId!)) : undefined;
  const card = wikiStartCard(plan.data, {
    now: Date.now(),
    maintenance: maintenance.enabled,
    readsFrom: workspace?.label ?? null,
    runnerOnline,
    directory: docs.data ?? null,
  });

  const act = async (to: WikiStartActionTo) => {
    if (to === 'setUp') return setSettingUp(true);
    if (to === 'plan') return navigate(wikiPlanPath(space.slug));
    if (to === 'runners') return navigate(machinesHref);
    try {
      const answer = await draft.mutateAsync(undefined);
      message.success(answer.created ? WIKI_PLAN_REDRAFT_ASKED : WIKI_PLAN_REDRAFT_ALREADY);
    } catch (error) {
      message.error("Couldn't draft the plan", error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <>
      <WikiStartSteps card={card} busy={draft.isPending} onAction={(to) => void act(to)} />
      {settingUp && <WikiSetUpDialog space={space} onClose={() => setSettingUp(false)} />}
    </>
  );
}

/**
 * The Wiki of an account with no wiki (mock 41): the same card, whose first step makes one. A wiki describes a
 * repository, so with no workspace on one there is nothing to offer yet, and the step says so — once the
 * workspaces are read, so neither a first look nor a failed read says it of an account that has them.
 */
export function WikiFirstStartCard() {
  const { choices, read } = useWikiWorkspaceChoices();
  const [creating, setCreating] = useState(false);
  const card = wikiStartFirstCard(!read || choices.some((choice) => choice.repository !== null));
  return (
    <>
      <WikiStartSteps
        card={card}
        busy={false}
        onAction={() => setCreating(true)}
        underLead={<WikiTrashLink sentence={wikiTrashHoldsWhenEmpty} className="wk-trash-link-start" />}
      />
      {creating && <WikiCreateDialog onClose={() => setCreating(false)} />}
    </>
  );
}
