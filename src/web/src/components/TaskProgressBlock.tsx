import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons';
import {
  agentDetail,
  agentLane,
  agentNow,
  progressFooter,
  progressPhaseGroups,
  type TaskProgress,
  type TaskProgressAgent,
} from '@orbit/shared';

/**
 * How far a background workflow (or agent) has got: its agents by phase — done, running with the
 * tool it is on, queued — and the totals underneath. The same block opens under the Workflow card
 * in the conversation and under its row in the tray; the words are @orbit/shared's
 * `taskProgressCopy`, which OrbitKit's `TaskProgressView` draws word for word.
 */
export function TaskProgressBlock({ progress }: { progress: TaskProgress }) {
  const groups = progressPhaseGroups(progress);
  const footer = progressFooter(progress);
  if (groups.length === 0 && !footer) return null;
  return (
    <div className="agent-progress">
      {groups.map((g, i) => (
        <div className="agent-progress-phase" key={`${i}-${g.title}`}>
          {(g.title || groups.length > 1) && (
            <div className="agent-progress-head">
              {g.title}
              <span className="agent-progress-count">
                {g.done}/{g.total}
              </span>
            </div>
          )}
          {g.agents.map((a) => (
            <AgentRow key={a.index} agent={a} />
          ))}
        </div>
      ))}
      {footer && <div className="agent-progress-foot">{footer}</div>}
    </div>
  );
}

function AgentRow({ agent }: { agent: TaskProgressAgent }) {
  const lane = agentLane(agent);
  const now = agentNow(agent);
  const detail = agentDetail(agent);
  return (
    <div className={`agent-progress-agent is-${lane}`} title={agent.error || undefined}>
      <AgentLaneIcon lane={lane} />
      <span className="agent-progress-label">{agent.label}</span>
      {now && <span className="agent-progress-now">{now}</span>}
      {detail && <span className="agent-progress-detail">{detail}</span>}
    </div>
  );
}

function AgentLaneIcon({ lane }: { lane: ReturnType<typeof agentLane> }) {
  if (lane === 'done') return <CheckCircleFilled className="chat-tool-status ok" />;
  if (lane === 'failed') return <CloseCircleFilled className="chat-tool-status err" />;
  if (lane === 'running') return <LoadingOutlined spin className="chat-tool-status running" />;
  return <span className="agent-progress-queued" aria-label="queued" />;
}
