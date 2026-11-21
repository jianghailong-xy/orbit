import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { SubagentReportGroup, WorkflowReportGroup } from '@orbit/shared';
import { SettingsHeader } from '../../components/settings';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { workspacesQuery } from '../../lib/queries';
import {
  DEFAULT_REPORT_PERIOD,
  REPORT_PERIODS,
  SUBAGENTS_FOOT,
  WORKFLOWS_FOOT,
  costText,
  durationText,
  isRoutedTier,
  percent,
  periodPhrase,
  plural,
  reportPeriod,
  subagentRoutingReportQuery,
  subagentTotals,
  tierLabel,
  workflowTotals,
  type ReportPeriod,
  type ReportView,
} from '../../lib/routingReport';

/** The Agent filter's value for every Agent: a public id is never this word. */
const ALL_AGENTS = 'all';

/**
 * Settings → Routing report (docs/subagent-design.md §7, docs/subagent-workflow-design.md §8 P4, board
 * docs/mocks/subagent-workflow/08-report.html): how the work Orbit routed went, in two views of one read: SubAgents by
 * the tier and model routing picked, and Orbit workflows by name, whose calls the SubAgents view counts among its runs.
 * The view, period and Agent live in the address, so a link opens the same report.
 */
export function RoutingReportPage() {
  const [params, setParams] = useSearchParams();
  const view: ReportView = params.get('view') === 'workflows' ? 'workflows' : 'subagents';
  const period = reportPeriod(params.get('period'));
  const agentId = params.get('agent');
  const report = useQuery(subagentRoutingReportQuery(period, agentId));
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

  return (
    <div className="settings-page settings-page--wide routing-report-page">
      <SettingsHeader
        title="Routing report"
        description="How the work Orbit routed went: which tier and model ran it, how often it finished, and what it cost."
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
      />
      <div className="following-tabs" role="tablist" aria-label="Routing report">
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
        {report.isPending ? (
          <div className="following-empty">
            <Spinner aria-busy="true" />
          </div>
        ) : report.isError ? (
          <div className="following-empty">
            Couldn’t load the report: {report.error.message}{' '}
            <Button size="small" onClick={() => void report.refetch()}>
              Retry
            </Button>
          </div>
        ) : view === 'subagents' ? (
          <SubagentsView groups={subagents} period={period} />
        ) : (
          <WorkflowsView groups={workflows} period={period} />
        )}
      </div>
    </div>
  );
}

function SubagentsView({ groups, period }: { groups: SubagentReportGroup[]; period: ReportPeriod }) {
  if (groups.length === 0) return <div className="following-empty">No SubAgents ran {periodPhrase(period)}.</div>;
  const totals = subagentTotals(groups);
  const done = percent(totals.done, totals.ended);
  const noSize = percent(totals.noSize, totals.routed);
  return (
    <>
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
      </p>
      <div className="routing-report-scroll">
        <table className="routing-report-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Model</th>
              <th className="is-num">Runs</th>
              <th className="is-num">Done</th>
              <th className="is-num">Cost</th>
              <th className="is-num">Moved on</th>
              <th className="is-num">No size</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const routed = isRoutedTier(group.tier);
              const share = percent(group.done, group.ended);
              const noSizeShare = percent(group.noSize, group.runs);
              return (
                <tr key={`${group.tier} ${group.provider} ${group.model}`}>
                  <td>
                    {routed ? (
                      <span className="routing-report-tier">{group.tier}</span>
                    ) : (
                      <span className="routing-report-tier-word">{tierLabel(group.tier)}</span>
                    )}
                  </td>
                  <td>
                    <span className="routing-report-model">{group.modelLabel ?? 'No model'}</span>
                    {group.providerLabel && <span className="routing-report-provider">{group.providerLabel}</span>}
                  </td>
                  <td className="is-num">{group.runs}</td>
                  <td className="is-num">{share === null ? '—' : `${share}%`}</td>
                  <td className="is-num">{costText(group.costUsd)}</td>
                  <td className={`is-num${!routed || group.movedOn === 0 ? ' is-zero' : ''}`}>{routed ? group.movedOn : '—'}</td>
                  <td className={`is-num${!routed || group.noSize === 0 ? ' is-zero' : ''}`}>
                    {routed && noSizeShare !== null ? `${noSizeShare}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="routing-report-foot">{SUBAGENTS_FOOT}</p>
    </>
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
