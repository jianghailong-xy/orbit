import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DownOutlined,
  LoadingOutlined,
  RightOutlined,
} from '@ant-design/icons';
import {
  workflowElapsed,
  workflowFinishedLine,
  workflowFinishedOutcome,
  workflowFinishedTitle,
  workflowModel,
  type WorkflowCall,
  type WorkflowChild,
  type WorkflowFinished,
  type WorkflowItem,
} from '../lib/orbitWorkflow';
import { WorkflowRunsCtx } from '../lib/workflowRuns';
import { ExportCtx } from './ToolBlocks';
import './OrbitWorkflowBlock.css';

/** A clock for a running workflow's time, ticking only while `on`. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

function CallStatus({ call }: { call: WorkflowCall }) {
  switch (call.state) {
    case 'running':
      return <LoadingOutlined className="chat-tool-status running" spin aria-label="running" />;
    case 'done':
      return <CheckCircleFilled className="chat-tool-status ok" aria-label="done" />;
    case 'failed':
      return <CloseCircleFilled className="chat-tool-status err" aria-label="failed" />;
    case 'stopped':
      return <span className="owf-stop" role="img" aria-label="stopped" />;
    default:
      return <span className="owf-queued">Queued</span>;
  }
}

/**
 * One `agent()` call: its label, a line of what it returned (or was asked), tier · model · cost and its state.
 * A click opens the call's SubAgent card beneath it, as today's SubAgent block draws it.
 */
function CallRow({ call, card }: { call: WorkflowCall; card: (id: string) => ReactNode }) {
  const exp = useContext(ExportCtx);
  const [open, setOpen] = useState(false);
  const queued = call.state === 'queued';
  const toggle = () => setOpen((v) => !v);
  return (
    <>
      <div
        className={`owf-call is-${call.state}${open ? ' is-open' : ''}`}
        data-workflow-call={call.id}
        role={queued || exp ? undefined : 'button'}
        tabIndex={queued || exp ? undefined : 0}
        aria-expanded={queued || exp ? undefined : open}
        onClick={queued ? undefined : toggle}
        onKeyDown={
          queued
            ? undefined
            : (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggle();
                }
              }
        }
      >
        <span className="chat-tool-icon">
          <span className="chat-subagent-icon">✦</span>
        </span>
        <span className="owf-call-label">{call.label}</span>
        {call.line && <span className="owf-call-line">{call.line}</span>}
        {call.meta && <span className="owf-call-meta">{call.meta}</span>}
        <CallStatus call={call} />
      </div>
      {open && <div className="owf-call-card">{card(call.id)}</div>}
    </>
  );
}

function Items({ items, card }: { items: WorkflowItem[]; card: (id: string) => ReactNode }) {
  return (
    <>
      {items.map((item) =>
        item.kind === 'call' ? (
          <CallRow key={item.call.id} call={item.call} card={card} />
        ) : (
          <div key={`log${item.seq}`} className="owf-log" data-seq={item.seq}>
            {item.text}
          </div>
        ),
      )}
    </>
  );
}

function EndMark({ status }: { status: string }) {
  switch (status) {
    case 'RUNNING':
      return <LoadingOutlined className="chat-tool-status running" spin aria-label="running" />;
    case 'DONE':
      return <CheckCircleFilled className="chat-tool-status ok" aria-label="done" />;
    case 'FAILED':
      return <CloseCircleFilled className="chat-tool-status err" aria-label="failed" />;
    case 'INTERRUPTED':
      return <span className="owf-stop is-interrupted" role="img" aria-label="interrupted" />;
    default:
      return <span className="owf-stop" role="img" aria-label="stopped" />;
  }
}

/**
 * An Orbit workflow (`mcp__orbit__workflow`) as board parts 2 and 3 draw it: a head with done / started calls,
 * cost and an end mark, the phase and counts beneath while it runs, the banner for an interrupted, limited or
 * failed one, and, opened, its calls grouped by phase with the script's log lines where they fell.
 */
export function OrbitWorkflowBlock({
  node,
  running,
  title,
  source,
  card,
}: {
  node: { id: string; seq: number; children: readonly WorkflowChild[] };
  /** Whether the workflow call still runs, for when the server's workflow has not been read. */
  running: boolean;
  /** The call's own name for it (script meta · description), until the server's is read. */
  title?: string;
  /** The script, folded at the bottom of the open block. */
  source?: ReactNode;
  /** The SubAgent card of one of its calls, by the call's id. */
  card: (id: string) => ReactNode;
}) {
  const exp = useContext(ExportCtx);
  const { workflows, calls } = useContext(WorkflowRunsCtx);
  const view = workflows.get(node.id);
  const [open, setOpen] = useState(!!exp);
  const model = useMemo(() => workflowModel(view, node.children, calls, running), [view, node.children, calls, running]);
  const now = useTick(open && model.status === 'RUNNING' && !!view);
  const name = view ? [view.name, view.description].filter(Boolean).join(' · ') : title;
  const badge = open && view ? `${model.badge} · ${workflowElapsed(view, now)}` : model.badge;
  return (
    <div
      data-seq={node.seq}
      data-orbit-workflow={node.id}
      className={`chat-tool-card chat-tone-agent chat-tool-task owf${open ? ' is-open' : ''}`}
    >
      <div className="chat-tool-row" onClick={() => setOpen((v) => !v)}>
        <span className="chat-tool-caret">{open ? <DownOutlined /> : <RightOutlined />}</span>
        <span className="chat-tool-icon">
          <span className="chat-subagent-icon">✦</span>
        </span>
        <span className="chat-tool-name">Workflow</span>
        {name && <span className="chat-tool-summary">{name}</span>}
        <span className="chat-tool-meta owf-badge">{badge}</span>
        <EndMark status={model.status} />
      </div>
      {!open && model.live && <div className="chat-tool-live">{model.live}</div>}
      {model.banners.map((banner) => (
        <div key={banner.text} className={`owf-banner is-${banner.tone}`}>
          {banner.text}
        </div>
      ))}
      {open && (
        <div className="chat-tool-detail owf-detail">
          {model.sections.map((section, i) =>
            section.kind === 'log' ? (
              <div key={`log${section.seq}`} className="owf-log" data-seq={section.seq}>
                {section.text}
              </div>
            ) : (
              <div key={`g${i}`} className="owf-group">
                {section.group.phase && (
                  <div className="owf-group-h">
                    {section.group.phase} <span className="owf-group-c">{section.group.counts}</span>
                  </div>
                )}
                <div className="owf-group-calls">
                  <Items items={section.group.items} card={card} />
                </div>
              </div>
            ),
          )}
          {source && (
            <details className="chat-workflow-source" open={exp ? true : undefined}>
              <summary>Workflow source</summary>
              <div className="chat-tool-body">{source}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The turn the control plane opened when a workflow ended (`<orbit-workflow-finished>`), as board part 2 draws
 * it: one light purple strip per workflow, with its calls, time and cost, and what the script returned or why it
 * did not finish. The workflow's time comes from the server's workflow, when it has been read.
 */
export function WorkflowFinishedStrip({ wake, seq, queued }: { wake: WorkflowFinished; seq?: number; queued?: ReactNode }) {
  const { workflows } = useContext(WorkflowRunsCtx);
  const byId = useMemo(() => new Map([...workflows.values()].map((view) => [view.id, view])), [workflows]);
  return (
    <>
      {wake.runs.map((run) => {
        const view = byId.get(run.runId);
        const elapsed = view?.endedAt ? workflowElapsed(view, Date.parse(view.endedAt)) : null;
        const outcome = workflowFinishedOutcome(run);
        return (
          <div
            key={run.runId}
            className={`owf-wake${run.status === 'DONE' ? '' : ' is-failed'}`}
            data-seq={seq}
            data-workflow-run={run.runId}
          >
            <div className="owf-wake-line">
              <b>{workflowFinishedTitle(run)}</b> · {workflowFinishedLine(run, elapsed)}
            </div>
            {outcome && <div className="owf-wake-outcome">{outcome}</div>}
          </div>
        );
      })}
      {queued}
    </>
  );
}
