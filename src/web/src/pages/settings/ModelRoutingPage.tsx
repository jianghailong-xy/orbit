import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { WorkflowReportGroup } from '@orbit/shared';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../../components/settings';
import { ModelTierCell, QualityCell } from '../../components/ModelTiers';
import { Button } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';
import { workspacesQuery } from '../../lib/queries';
import {
  DEFAULT_REPORT_PERIOD,
  REPORT_PERIODS,
  SUBAGENTS_FOOT,
  WORKFLOWS_FOOT,
  costText,
  durationText,
  percent,
  periodPhrase,
  plural,
  reportPeriod,
  routingSections,
  subagentRoutingReportQuery,
  subagentTotals,
  workflowTotals,
  type ReportPeriod,
  type ReportView,
  type RoutingModelBlock,
  type RoutingModelRow,
  type RunFigures,
  type TierRuns,
} from '../../lib/routingReport';
import { modelTierText, priceText, QUALITY_FOOT, subagentTiersQuery, tierText, type ProviderTierRow } from '../../lib/subagentTiers';
import { usePreferences } from './preferences';
import { PERSONAL_SETTINGS as S } from './settingsIndex';
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from '../../components/ui/Tooltip';

/** The Agent filter's value for every Agent: a public id is never this word. */
const ALL_AGENTS = 'all';

/** Each row's one line, kept with its title in the Settings index; the full text is the control's tooltip. */
export const ROUTING_HINTS = {
  modelRouting: {
    short: S.modelRouting.description,
    full: "Coordinators suggest a tier for each task, and a SubAgent's size sets its own. Task runs and SubAgents run on a model of that tier from your providers. Off: tasks keep their Agent's model and SubAgents their parent session's.",
  },
  optimizeFor: {
    short: S.optimizeFor.description,
    full:
      'SubAgents pick a model, then the account that runs it. Cost: whichever quota expires first, on any model of the tier, subscriptions before metered keys. ' +
      'Balance: your preferred model, on its account whose quota expires first; another model of the tier takes over when every account of it is near its limit, ' +
      "or when another's weekly quota is about to reset unused. Intelligence: the strongest model, kept while any of its accounts can run. " +
      'Task runs still rank every account by quota.',
  },
} as const;

/**
 * Settings → Providers → Model routing: what was Model tiers and the Routing report, on one page. First the account's
 * two routing switches (Route by tier, and Optimize For under it), then every model with the tier it is
 * routed at — set here — beside how its runs went in the period (docs/subagent-design.md §7,
 * docs/subagent-workflow-design.md §8 P4). The view, period and Agent live in the address, so a link opens the same
 * report; they filter the runs, not the tiers.
 */
export function ModelRoutingPage() {
  const { prefs, save } = usePreferences();
  const [params, setParams] = useSearchParams();
  const view: ReportView = params.get('view') === 'workflows' ? 'workflows' : 'subagents';
  const period = reportPeriod(params.get('period'));
  const agentId = params.get('agent');
  const report = useQuery(subagentRoutingReportQuery(period, agentId));
  const tiers = useQuery(subagentTiersQuery());
  const workspaces = useQuery(workspacesQuery());
  const setParam = (key: string, value: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });

  const subagents = report.data?.subagents ?? [];
  const workflows = report.data?.workflows ?? [];
  const agents = [
    { value: ALL_AGENTS, label: 'All agents' },
    ...((workspaces.data ?? []) as Array<{ id: string; name: string }>).map((agent) => ({ value: agent.id, label: agent.name })),
  ];
  const tabs: Array<{ key: ReportView; label: string; count: number | null }> = [
    { key: 'subagents', label: 'SubAgents', count: report.data ? subagentTotals(subagents).runs : null },
    { key: 'workflows', label: 'Workflows', count: report.data ? workflowTotals(workflows).runs : null },
  ];
  const h = ROUTING_HINTS;

  return (
    <div className="settings-page settings-page--wide routing-report-page">
      <SettingsHeader title="Model routing" description="Which tier each model takes SubAgent work at, and how that work went." />

      <SettingsSection title="Routing">
        <SettingsCard>
          {/* Absent means on: only turning it off is ever written. */}
          <SettingsRow
            anchor={S.modelRouting.anchor}
            title={S.modelRouting.title}
            description={h.modelRouting.short}
            tooltip={h.modelRouting.full}
            control={
              <Switch
                aria-label="Route by tier"
                checked={prefs.modelRouting !== false}
                onCheckedChange={(v) => save.mutate({ modelRouting: v })}
                loading={save.isPending}
              />
            }
          />
          {/* Account-wide since 2026-11-19 (board docs/mocks/routing-mode-account); absent means Balance. Only
              Route by tier reads it, so it shows only while that is on (owner, 2026-11-20); the saved
              value is kept while it is off. */}
          {prefs.modelRouting !== false && (
            <SettingsRow
              anchor={S.optimizeFor.anchor}
              title={S.optimizeFor.title}
              description={h.optimizeFor.short}
              tooltip={h.optimizeFor.full}
              control={
                <Segmented<'cost' | 'balance' | 'intelligence'>
                  aria-label="Optimize For"
                  value={prefs.optimizeFor ?? 'balance'}
                  onValueChange={(v) => save.mutate({ optimizeFor: v })}
                  options={[
                    { value: 'cost', label: 'Cost' },
                    { value: 'balance', label: 'Balance' },
                    { value: 'intelligence', label: 'Intelligence' },
                  ]}
                />
              }
            />
          )}
          {/* Absent means off (docs/routing-account-health-design.md §7.5): a pinned task whose account can't run holds. */}
          <SettingsRow
            anchor={S.relaxBlockedPins.anchor}
            title={S.relaxBlockedPins.title}
            description={S.relaxBlockedPins.description}
            control={
              <Switch
                aria-label="Run pinned tasks elsewhere"
                checked={prefs.relaxBlockedPins === true}
                onCheckedChange={(v) => save.mutate({ relaxBlockedPins: v })}
                loading={save.isPending}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Models"
        action={
          <div className="routing-report-filters">
            <Select<ReportPeriod>
              aria-label="Period"
              options={REPORT_PERIODS}
              value={period}
              onValueChange={(value) => setParam('period', !value || value === DEFAULT_REPORT_PERIOD ? null : value)}
            />
            <Select
              aria-label="Agent"
              options={agents}
              value={agentId ?? ALL_AGENTS}
              onValueChange={(value) => setParam('agent', !value || value === ALL_AGENTS ? null : value)}
            />
          </div>
        }
      >
        <div className="following-tabs" role="tablist" aria-label="Model routing">
          {tabs.map(({ key, label, count }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              className={`following-tab${view === key ? ' is-on' : ''}`}
              onClick={() => setParam('view', key === 'subagents' ? null : key)}
            >
              {label}
              {count !== null && <span className="following-count">{count}</span>}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="routing-report-panel">
          {report.isPending || (view === 'subagents' && tiers.isPending) ? (
            <div className="following-empty">
              <Spinner aria-busy="true" />
            </div>
          ) : report.isError || (view === 'subagents' && tiers.isError) ? (
            <div className="following-empty">
              Couldn’t load the report: {(report.error ?? tiers.error)?.message}{' '}
              <Button size="small" onClick={() => void (report.isError ? report.refetch() : tiers.refetch())}>
                Retry
              </Button>
            </div>
          ) : view === 'subagents' ? (
            <ModelsView providers={tiers.data?.providers ?? []} report={report.data} period={period} />
          ) : (
            <WorkflowsView groups={workflows} period={period} />
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

function ModelsView({
  providers,
  report,
  period,
}: {
  providers: ProviderTierRow[];
  report: { subagents: Parameters<typeof subagentTotals>[0] };
  period: ReportPeriod;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showIdle, setShowIdle] = useState(false);
  const groups = report.subagents;
  const sections = routingSections(providers, groups);
  if (groups.length === 0 && sections.tiered.length === 0 && sections.idle.length === 0)
    return <div className="following-empty">No SubAgents ran {periodPhrase(period)}.</div>;

  const totals = subagentTotals(groups);
  const done = percent(totals.done, totals.ended);
  const noSize = percent(totals.noSize, totals.routed);
  const outside = sections.tiered.filter((row) => row.outsideRuns > 0).length;
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {groups.length === 0 ? (
        <p className="routing-report-totals">No SubAgents ran {periodPhrase(period)}.</p>
      ) : (
        <p className="routing-report-totals">
          <b>{plural(totals.runs, 'run')}</b>
          {totals.workflowCalls > 0 && `, ${totals.workflowCalls} of them workflow call${totals.workflowCalls === 1 ? '' : 's'}`}
          {done !== null && (
            <>
              {' · '}
              <b>{done}%</b> done
            </>
          )}
          {` · ${totals.movedOn} moved on`}
          {noSize !== null && ` · ${noSize}% without a size`}
          {outside > 0 && (
            <>
              {' · '}
              <span className="model-routing-outside">
                {outside === 1 ? '1 model' : `${outside} models`} ran outside {outside === 1 ? 'its tier' : 'their tiers'}
              </span>
            </>
          )}
        </p>
      )}
      <div className="routing-report-scroll">
        <table className="routing-report-table model-routing-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Tier</th>
              <th>Quality</th>
              <th>Price / M out</th>
              <th>Ran at</th>
              <th className="is-num">Runs</th>
              <th className="is-num">Done</th>
            </tr>
          </thead>
          <tbody>
            {sections.tiered.length > 0 && <SectionRow title="Routed by tier" />}
            {sections.tiered.map((block) => (
              <ModelBlock key={block.key} block={block} ranAt="tiers" open={open.has(block.key)} onToggle={() => toggle(block.key)} />
            ))}
            {sections.named.length > 0 && <SectionRow title="Called by name" note="The SubAgent named its model, so no tier was picked." />}
            {sections.named.map((block) => (
              <ModelBlock key={block.key} block={block} ranAt="Named" open={open.has(`named:${block.key}`)} onToggle={() => toggle(`named:${block.key}`)} />
            ))}
            {sections.notRouted.length > 0 && <SectionRow title="Not routed" />}
            {sections.notRouted.map((block) => (
              <ModelBlock key={block.key} block={block} ranAt="Not routed" open={open.has(`not-routed:${block.key}`)}
                onToggle={() => toggle(`not-routed:${block.key}`)} />
            ))}
            {sections.idle.length > 0 && (
              <tr className="model-routing-section">
                <td colSpan={COLUMNS}>
                  <button type="button" className="model-routing-fold" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)}>
                    {showIdle ? '▾' : '▸'} No tier, no runs · {plural(sections.idle.length, 'model')}
                  </button>
                </td>
              </tr>
            )}
            {showIdle && sections.idle.map((block) => (
              <ModelBlock key={block.key} block={block} ranAt="tiers" open={open.has(`idle:${block.key}`)} onToggle={() => toggle(`idle:${block.key}`)} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="routing-report-foot">{SUBAGENTS_FOOT}</p>
      <p className="routing-report-foot">{QUALITY_FOOT}</p>
    </>
  );
}

/** The table's columns: Model, Tier, Quality, Price, Ran at, Runs, Done. */
const COLUMNS = 7;

function SectionRow({ title, note }: { title: string; note?: string }) {
  return (
    <tr className="model-routing-section">
      <td colSpan={COLUMNS}>
        {title}
        {note && <span className="model-routing-section-note">{note}</span>}
      </td>
    </tr>
  );
}

/**
 * One model: its name, Quality and the runs of every account listing it, summed. A model on one account is one row,
 * its provider beside its name. A model on several reads "N accounts" and opens, closed at first, to a row per account:
 * its provider, its tier (a menu where the owner may set it), its price and its runs. The model's own Tier and Price are
 * its accounts' when they all agree, else "Varies".
 */
function ModelBlock({
  block,
  ranAt,
  open,
  onToggle,
}: {
  block: RoutingModelBlock;
  ranAt: 'tiers' | 'Named' | 'Not routed';
  open: boolean;
  onToggle: () => void;
}) {
  const single = block.accounts.length === 1 ? block.accounts[0] : null;
  const first = block.accounts[0];
  const quality = block.accounts.find((account) => account.model)?.model ?? null;
  const tiers = new Set(block.accounts.map((account) => (account.model ? modelTierText(account.model) : '—')));
  const prices = new Set(block.accounts.map((account) => (account.provider && account.model ? priceText(account.model, account.provider.billing) : '—')));
  const varies = <span className="model-tiers-muted">Varies</span>;
  return (
    <>
      <tr className={open ? 'is-open' : undefined}>
        <td>
          {single ? (
            // The arrow's room kept, so every model's name starts in the same place whether or not it opens.
            <span className="model-routing-open model-routing-no-open">
              <span aria-hidden="true">▸</span>
              <span className="routing-report-model">{block.modelLabel}</span>
            </span>
          ) : (
            <button type="button" className="model-routing-open" aria-expanded={open} onClick={onToggle}>
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
              <span className="routing-report-model">{block.modelLabel}</span>
            </button>
          )}
          <span className="routing-report-provider">{single ? single.providerLabel : plural(block.accounts.length, 'account')}</span>
          {ranAt === 'tiers' && block.outsideRuns > 0 && (
            <div className="model-routing-flag">{single ? outsideText(single) : `${plural(block.outsideRuns, 'run')} outside its tier`}</div>
          )}
        </td>
        <td>
          {single?.provider && single.model ? <ModelTierCell provider={single.provider} model={single.model} />
            : tiers.size === 1 ? [...tiers][0] : varies}
        </td>
        <td className="model-tiers-quality">{quality ? <QualityCell model={quality} /> : '—'}</td>
        <td className="model-tiers-price">{prices.size === 1 ? [...prices][0] : varies}</td>
        <RunCells figures={block} tiers={block.tiers} ranAt={ranAt} />
      </tr>
      {open && !single && block.accounts.map((account) => (
        <tr key={account.key} className="model-routing-account">
          <td>
            <span className="model-routing-account-name">{account.providerLabel ?? first.providerLabel}</span>
            {ranAt === 'tiers' && account.outsideRuns > 0 && <div className="model-routing-flag">{outsideText(account)}</div>}
          </td>
          <td>{account.provider && account.model ? <ModelTierCell provider={account.provider} model={account.model} /> : '—'}</td>
          <td />
          <td className="model-tiers-price">{account.provider && account.model ? priceText(account.model, account.provider.billing) : '—'}</td>
          <RunCells figures={account} tiers={account.tiers} ranAt={ranAt} />
        </tr>
      ))}
    </>
  );
}

/** "20 runs at S, outside M", or for a model with no tier "No tier set, but routed 12 times". */
function outsideText(account: RoutingModelRow): string {
  const at = account.tiers.filter((tier) => tier.outside).map((tier) => tier.tier);
  return account.model && account.model.levels.length === 0
    ? `No tier set, but routed ${plural(account.outsideRuns, 'time')}`
    : `${plural(account.outsideRuns, 'run')} at ${at.join(' · ')}, outside ${tierText(account.model?.levels ?? [])}`;
}

/** Ran at, Runs and Done of a model or one of its accounts. */
function RunCells({ figures, tiers, ranAt }: { figures: RunFigures; tiers: TierRuns[]; ranAt: 'tiers' | 'Named' | 'Not routed' }) {
  const share = percent(figures.done, figures.ended);
  return (
    <>
      <td>
        {ranAt !== 'tiers' ? (
          <span className="routing-report-tier-word">{ranAt}</span>
        ) : figures.runs === 0 ? (
          <span className="routing-report-tier-word">No runs</span>
        ) : (
          <TierBar tiers={tiers} runs={figures.runs} />
        )}
      </td>
      <td className={`is-num${figures.runs === 0 ? ' is-zero' : ''}`}>{figures.runs}</td>
      <td className={`is-num${share === null ? ' is-zero' : ''}`}>{share === null ? '—' : `${share}%`}</td>
    </>
  );
}

/** The tiers a model's runs were routed at, as one bar: a segment per tier, striped where it is outside the tier. Its
 *  tooltip, per segment, gives that tier's runs and share done. */
function TierBar({ tiers, runs }: { tiers: TierRuns[]; runs: number }) {
  const label = tiers.map((tier) => `${tier.tier} ${tier.runs}${tier.outside ? ' (outside its tier)' : ''}`).join(', ');
  return (
    <div className="model-routing-bar" role="img" aria-label={`Ran at ${label}`}>
      {tiers.map((tier) => (
        <Fragment key={tier.tier}>
          <Tooltip content={`${tier.tier}: ${plural(tier.runs, 'run')}${percent(tier.done, tier.ended) === null ? '' : `, ${percent(tier.done, tier.ended)}% done`}`} delay={TEXT_TOOLTIP_DELAY_MS}>
            <i
              className={`model-routing-bar-${tier.tier}${tier.outside ? ' is-outside' : ''}`}
              style={{ flexGrow: tier.runs }}
            >
              {tier.runs / runs >= 0.15 ? tier.tier : ''}
            </i>
          </Tooltip>
        </Fragment>
      ))}
    </div>
  );
}

function WorkflowsView({ groups, period }: { groups: WorkflowReportGroup[]; period: ReportPeriod }) {
  if (groups.length === 0) return <div className="following-empty">No workflows ran {periodPhrase(period)}.</div>;
  const totals = workflowTotals(groups);
  return (
    <>
      <p className="routing-report-totals">
        <b>{plural(totals.runs, 'run')}</b> of {plural(totals.workflows, 'workflow')}
        {' · '}
        <b>{plural(totals.calls, 'call')}</b>, {totals.failedCalls} failed
        {' · '}
        <b>{costText(totals.costUsd)}</b>
      </p>
      <div className="routing-report-scroll">
        <table className="routing-report-table">
          <thead>
            <tr>
              <th>Workflow</th>
              <th className="is-num">Runs</th>
              <th className="is-num">Calls</th>
              <th className="is-num">Failed</th>
              <th className="is-num">Cost</th>
              <th className="is-num">Duration</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.name}>
                <td>
                  <div className="routing-report-name">
                    {group.name}
                    {group.running > 0 && <span className="routing-report-running chat-tone-agent">{group.running} running</span>}
                  </div>
                  {group.description && <div className="routing-report-desc">{group.description}</div>}
                </td>
                <td className="is-num">{group.runs}</td>
                <td className="is-num">{group.calls}</td>
                <td className={`is-num${group.failedCalls > 0 ? ' is-bad' : ' is-zero'}`}>{group.failedCalls}</td>
                <td className="is-num">{costText(group.costUsd)}</td>
                <td className="is-num">{durationText(group.durationP50Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="routing-report-foot">{WORKFLOWS_FOOT}</p>
    </>
  );
}
