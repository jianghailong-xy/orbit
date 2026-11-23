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
  type RoutingModelRow,
} from '../../lib/routingReport';
import { priceText, QUALITY_FOOT, subagentTiersQuery, tierText, type ProviderTierRow } from '../../lib/subagentTiers';
import { usePreferences } from './preferences';
import { PERSONAL_SETTINGS as S } from './settingsIndex';

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
    full: 'Cost spends subscriptions before metered keys. Balance spends the quota that expires first, then the most room. Intelligence puts the strongest model first.',
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
          {' · '}
          <b>{costText(totals.costUsd)}</b>
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
              <th className="is-num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {sections.tiered.length > 0 && <SectionRow title="Routed by tier" />}
            {sections.tiered.map((row) => (
              <ModelRow key={row.key} row={row} ranAt="tiers" open={open.has(row.key)} onToggle={() => toggle(row.key)} />
            ))}
            {sections.named.length > 0 && <SectionRow title="Called by name" note="The SubAgent named its model, so no tier was picked." />}
            {sections.named.map((row) => (
              <ModelRow key={row.key} row={row} ranAt="Named" />
            ))}
            {sections.notRouted.length > 0 && <SectionRow title="Not routed" />}
            {sections.notRouted.map((row) => (
              <ModelRow key={row.key} row={row} ranAt="Not routed" />
            ))}
            {sections.idle.length > 0 && (
              <tr className="model-routing-section">
                <td colSpan={8}>
                  <button type="button" className="model-routing-fold" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)}>
                    {showIdle ? '▾' : '▸'} No tier, no runs · {plural(sections.idle.length, 'model')}
                  </button>
                </td>
              </tr>
            )}
            {showIdle && sections.idle.map((row) => <ModelRow key={row.key} row={row} ranAt="tiers" />)}
          </tbody>
        </table>
      </div>
      <p className="routing-report-foot">{SUBAGENTS_FOOT}</p>
      <p className="routing-report-foot">{QUALITY_FOOT}</p>
    </>
  );
}

function SectionRow({ title, note }: { title: string; note?: string }) {
  return (
    <tr className="model-routing-section">
      <td colSpan={8}>
        {title}
        {note && <span className="model-routing-section-note">{note}</span>}
      </td>
    </tr>
  );
}

/**
 * One model: its name and provider, its tier (a menu where the owner may set it), its price, the tiers its runs were
 * routed at as a bar (striped where that tier is not one it is set to now), and its runs, share done and cost. A routed
 * row opens to its runs tier by tier.
 */
function ModelRow({
  row,
  ranAt,
  open = false,
  onToggle,
}: {
  row: RoutingModelRow;
  ranAt: 'tiers' | 'Named' | 'Not routed';
  open?: boolean;
  onToggle?: () => void;
}) {
  const share = percent(row.done, row.ended);
  const opens = ranAt === 'tiers' && row.tiers.length > 0 && !!onToggle;
  const outsideTiers = row.tiers.filter((tier) => tier.outside).map((tier) => tier.tier);
  return (
    <>
      <tr className={[open && 'is-open', row.continued && !open && 'model-routing-continued'].filter(Boolean).join(' ') || undefined}>
        <td className={row.continues ? 'model-routing-same' : undefined}>
          {row.continues ? (
            opens ? (
              <button type="button" className="model-routing-open" aria-expanded={open} onClick={onToggle} aria-label={`${row.modelLabel} on ${row.providerLabel}`}>
                <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span className="routing-report-provider">{row.providerLabel}</span>
              </button>
            ) : (
              // The arrow's room kept, so a block's providers line up whether or not they open.
              <span className="model-routing-open model-routing-no-open">
                <span aria-hidden="true">▸</span>
                <span className="routing-report-provider" aria-label={`${row.modelLabel} on ${row.providerLabel}`}>{row.providerLabel}</span>
              </span>
            )
          ) : opens ? (
            <button type="button" className="model-routing-open" aria-expanded={open} onClick={onToggle}>
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
              <span className="routing-report-model">{row.modelLabel}</span>
            </button>
          ) : (
            <span className="routing-report-model">{row.modelLabel}</span>
          )}
          {!row.continues && row.providerLabel && <span className="routing-report-provider">{row.providerLabel}</span>}
          {ranAt === 'tiers' && row.outsideRuns > 0 && (
            <div className="model-routing-flag">
              {row.model && row.model.levels.length === 0
                ? `No tier set, but routed ${plural(row.outsideRuns, 'time')}`
                : `${plural(row.outsideRuns, 'run')} at ${outsideTiers.join(' · ')}, outside ${tierText(row.model?.levels ?? [])}`}
            </div>
          )}
        </td>
        <td>{row.provider && row.model ? <ModelTierCell provider={row.provider} model={row.model} /> : '—'}</td>
        <td className="model-tiers-quality">{row.continues ? null : row.model ? <QualityCell model={row.model} pooledWith={row.pooledWith} /> : '—'}</td>
        <td className="model-tiers-price">{row.provider && row.model ? priceText(row.model, row.provider.billing) : '—'}</td>
        <td>
          {ranAt !== 'tiers' ? (
            <span className="routing-report-tier-word">{ranAt}</span>
          ) : row.runs === 0 ? (
            <span className="routing-report-tier-word">No runs</span>
          ) : (
            <TierBar row={row} />
          )}
        </td>
        <td className={`is-num${row.runs === 0 ? ' is-zero' : ''}`}>{row.runs}</td>
        <td className={`is-num${share === null ? ' is-zero' : ''}`}>{share === null ? '—' : `${share}%`}</td>
        <td className={`is-num${row.runs === 0 ? ' is-zero' : ''}`}>{row.runs === 0 ? '—' : costText(row.costUsd)}</td>
      </tr>
      {open &&
        row.tiers.map((tier) => {
          const tierShare = percent(tier.done, tier.ended);
          return (
            <tr key={tier.tier} className="model-routing-tier">
              <td>
                <span className="routing-report-tier">{tier.tier}</span>
                {tier.outside && <span className="model-routing-flag">outside its tier</span>}
              </td>
              <td colSpan={4} className="is-zero">
                {tier.movedOn > 0 ? `${tier.movedOn} moved on` : ''}
              </td>
              <td className="is-num">{tier.runs}</td>
              <td className="is-num">{tierShare === null ? '—' : `${tierShare}%`}</td>
              <td className="is-num">{costText(tier.costUsd)}</td>
            </tr>
          );
        })}
    </>
  );
}

/** The share of a model's runs at each tier, S to XL; a tier it is not set to now is striped. */
function TierBar({ row }: { row: RoutingModelRow }) {
  const label = row.tiers.map((tier) => `${tier.tier} ${tier.runs}${tier.outside ? ' (outside its tier)' : ''}`).join(', ');
  return (
    <div className="model-routing-bar" role="img" aria-label={`Ran at ${label}`}>
      {row.tiers.map((tier) => (
        <Fragment key={tier.tier}>
          <i
            className={`model-routing-bar-${tier.tier}${tier.outside ? ' is-outside' : ''}`}
            style={{ flexGrow: tier.runs }}
            title={`${tier.tier}: ${plural(tier.runs, 'run')}`}
          >
            {tier.runs / row.runs >= 0.15 ? tier.tier : ''}
          </i>
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
