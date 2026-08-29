import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Spin, Tag } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { HumanDecisionProtocolCard } from '../components/HumanDecisionProtocolCard';
import { routeId } from '../lib/idCodec';
import {
  ownerRatificationDecisionPath,
  ownerRatificationPath,
  type OwnerRatificationView,
} from '../lib/outcomeSurfaces';

export function OwnerRatificationReviewPage() {
  const projectId = routeId(useParams().projectId);
  const qc = useQueryClient();
  const view = useQuery({
    queryKey: ['owner-ratification', projectId],
    queryFn: () => api<OwnerRatificationView>(ownerRatificationPath(projectId!)),
    enabled: Boolean(projectId),
  });
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'DENY') => {
      const request = view.data?.decisionRequest;
      if (!request) throw new Error('此 Owner Ratification CTA 已失效。');
      return api(ownerRatificationDecisionPath(request.id), {
        method: 'POST',
        body: {
          requestRevision: request.requestRevision,
          contractDigest: view.data!.contractDigest,
          decision,
          idempotencyKey: `web-owner-ratification:${request.requestRevision}:${decision}`,
        },
      });
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['owner-ratification'] }),
        qc.invalidateQueries({ queryKey: ['outcomes'] }),
        qc.invalidateQueries({ queryKey: ['project-acceptance'] }),
      ]);
      await view.refetch();
    },
  });
  if (!projectId) return <Alert type="error" showIcon message="Owner Ratification 链接无效" />;
  if (view.isLoading) return <div className="judgment-loading"><Spin /></div>;
  if (view.isError || !view.data) return <Alert type="error" showIcon message="无法读取 Owner Ratification" />;
  const request = view.data.decisionRequest;
  return (
    <article className="judgment-page judgment-review-page">
      <Link className="judgment-back-link" to="/judgments">← 待我判定</Link>
      <header className="judgment-review-head">
        <h1 className="page-title">Owner Ratification</h1>
        <Tag color={view.data.ratified ? 'green' : 'gold'}>{view.data.ratified ? '已批准当前合约' : '待决定'}</Tag>
        <p>批准项目目标、风险、权限、预算、接收方与完成合约；这不是逐项 HUMAN_SIGNOFF。</p>
      </header>
      {request ? <HumanDecisionProtocolCard protocol={request.protocol} /> : (
        <Alert type="success" showIcon message="当前合约没有待批准请求" />
      )}
      {request && (
        <section className="judgment-decision">
          <h2>绑定当前 contract revision 的决定</h2>
          <div className="judgment-decision-actions">
            <Button type="primary" loading={decide.isPending} onClick={() => decide.mutate('APPROVE')}>批准当前合约</Button>
            <Button danger loading={decide.isPending} onClick={() => decide.mutate('DENY')}>拒绝</Button>
          </div>
        </section>
      )}
      <details><summary>合约与 semantic diff</summary><pre>{JSON.stringify({ semanticContract: view.data.semanticContract, semanticDiff: request?.semanticDiff }, null, 2)}</pre></details>
    </article>
  );
}
