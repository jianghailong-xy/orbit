import { Alert, Tag } from 'antd';
import type { HumanDecisionProtocol } from '../lib/outcomeSurfaces';

const show = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);

export function HumanDecisionProtocolCard({ protocol }: { protocol: HumanDecisionProtocol }) {
  return (
    <section className="judgment-evidence-identity" aria-label="Human decision request">
      <div className="judgment-identity-head">
        <h2>真正需要你的决定</h2>
        <Tag color="gold">{protocol.decisionType}</Tag>
      </div>
      <dl className="judgment-identity-facts">
        <div><dt>Agent 已完成</dt><dd>{protocol.agentWorkCompleted.length ? show(protocol.agentWorkCompleted) : '尚无可自动完成的步骤'}</dd></div>
        <div><dt>whyNotAgent</dt><dd>{protocol.whyNotAgent}</dd></div>
        <div><dt>选项</dt><dd>{show(protocol.options)}</dd></div>
        <div><dt>影响</dt><dd>{show(protocol.impacts)}</dd></div>
        <div><dt>推荐项</dt><dd>{show(protocol.recommendation)}</dd></div>
        <div><dt>成本</dt><dd>{show(protocol.cost)}</dd></div>
        <div><dt>期限</dt><dd>{show(protocol.deadline)}</dd></div>
        <div><dt>不处理后果</dt><dd>{show(protocol.noActionConsequence)}</dd></div>
        <div><dt>决定后</dt><dd>{show(protocol.resumeBehavior)}</dd></div>
      </dl>
      <Alert type="info" showIcon message="提交后会按上面的续跑路径自动唤醒 Agent；无需另建任务。" />
    </section>
  );
}
