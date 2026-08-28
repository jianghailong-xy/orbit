import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Spin, Tag } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { HumanDecisionProtocolCard } from '../components/HumanDecisionProtocolCard';
import { routeId } from '../lib/idCodec';
import {
  outcomeDecisionPath,
  type OutcomeDecisionView,
} from '../lib/outcomeSurfaces';

export function OutcomeDecisionReviewPage() {
  const requestId = routeId(useParams().requestId);
  const qc = useQueryClient();
  const view = useQuery({
    queryKey: ['outcome-decision', requestId],
    queryFn: () => api<OutcomeDecisionView>(outcomeDecisionPath(requestId!)),
    enabled: Boolean(requestId),
  });
  const decide = useMutation({
    mutationFn: (choice: unknown) => {
      if (!requestId || !view.data?.cta) throw new Error('此 CTA 已失效，请刷新收件箱。');
      const binding = view.data.cta.binding;
      return api(outcomeDecisionPath(requestId), {
        method: 'POST',
        body: {
          ...binding,
          idempotencyKey: `web-owner-decision:${String(binding.requestRevision)}`,
          decision: { choice },
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['outcomes'] });
      await view.refetch();
    },
  });
  if (!requestId) return <Alert type="error" showIcon message="决策链接无效" />;
  if (view.isLoading) return <div className="judgment-loading"><Spin /></div>;
  if (view.isError || !view.data) {
    return <Alert type="error" showIcon message="无法读取决策请求" description={view.error instanceof Error ? view.error.message : undefined} />;
  }
  return (
    <article className="judgment-page judgment-review-page">
      <Link className="judgment-back-link" to="/judgments">← 待我判定</Link>
      <header className="judgment-review-head">
        <h1 className="page-title">项目下一步决策</h1>
        <Tag>{String(view.data.semantic.reason.code ?? 'OWNER_DECISION')}</Tag>
      </header>
      <HumanDecisionProtocolCard protocol={view.data.decision} />
      {view.data.cta ? (
        <section className="judgment-decision">
          <h2>选择</h2>
          <div className="judgment-decision-actions">
            {view.data.decision.options.map((option, index) => (
              <Button key={index} type={index === 0 ? 'primary' : 'default'} loading={decide.isPending} onClick={() => decide.mutate(option)}>
                {typeof option === 'string' ? option : JSON.stringify(option)}
              </Button>
            ))}
          </div>
        </section>
      ) : <Alert type="warning" showIcon message="此 CTA 已失效" description={view.data.ctaUnavailableReason} />}
    </article>
  );
}
