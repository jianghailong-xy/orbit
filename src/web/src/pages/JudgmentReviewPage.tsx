import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Spin, Tag } from 'antd';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  adaptJudgmentEvidence,
  type JudgmentEvidenceArtifact,
  type JudgmentEvidenceCommand,
  type JudgmentEvidenceCriterion,
  type JudgmentEvidenceFallbackReason,
} from '../lib/judgmentEvidence';
import { encodeId, routeId } from '../lib/idCodec';
import {
  judgmentReviewPath,
  shortDigest,
  type JudgmentReview,
} from '../lib/judgments';

const when = (value?: string | null): string => value
  ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '未提供';

const shortCommit = (value: string | null): string => {
  if (!value) return '未提供';
  return value.length > 14 ? `${value.slice(0, 12)}…` : value;
};

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const temporary = document.createElement('textarea');
  temporary.value = value;
  temporary.setAttribute('readonly', '');
  temporary.style.position = 'fixed';
  temporary.style.opacity = '0';
  document.body.appendChild(temporary);
  temporary.select();
  document.execCommand('copy');
  temporary.remove();
}

function CopyTextButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="text"
      className="judgment-copy-button"
      icon={copied ? <CheckOutlined /> : <CopyOutlined />}
      aria-label={copied ? `${label}已复制` : label}
      onClick={async () => {
        await copyText(value);
        setCopied(true);
      }}
    >
      {copied ? '已复制' : label}
    </Button>
  );
}

function LazyDetails({
  className,
  id,
  summary,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  className?: string;
  id?: string;
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  return (
    <details
      id={id}
      className={className}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (controlledOpen === undefined) setLocalOpen(next);
        onOpenChange?.(next);
      }}
    >
      <summary>{summary}</summary>
      {open ? children : null}
    </details>
  );
}

function RawJsonFact({ label, value }: { label: string; value: unknown }) {
  const json = JSON.stringify(value, null, 2) ?? 'undefined';
  return (
    <section className="judgment-raw-fact" aria-label={label}>
      <div className="judgment-raw-head">
        <h3>{label}</h3>
        <CopyTextButton value={json} label={`复制${label}`} />
      </div>
      <pre className="judgment-json">{json}</pre>
    </section>
  );
}

function CommandFact({ command }: { command: JudgmentEvidenceCommand }) {
  return (
    <article className="judgment-command-fact">
      <div className="judgment-command-head">
        <span>{command.label ?? '命令'}</span>
        <span>{command.exitCode === null ? 'exit code 未提供' : `exit ${command.exitCode}`}</span>
      </div>
      <code>{command.command}</code>
      {command.keyOutput && (
        <div className="judgment-key-output">
          <span>关键输出</span>
          <pre>{command.keyOutput}</pre>
        </div>
      )}
      {command.fullOutput && (
        <LazyDetails
          className="judgment-output-details"
          summary={<span>查看完整原始输出</span>}
        >
          <pre className="judgment-full-output">{command.fullOutput}</pre>
        </LazyDetails>
      )}
    </article>
  );
}

function ArtifactFact({ artifact }: { artifact: JudgmentEvidenceArtifact }) {
  return (
    <article className="judgment-artifact-fact">
      <strong>{artifact.title}</strong>
      {artifact.facts.length > 0 && (
        <dl>
          {artifact.facts.map((fact) => (
            <div key={`${fact.label}-${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
          ))}
        </dl>
      )}
    </article>
  );
}

function CriterionCard({ criterion }: { criterion: JudgmentEvidenceCriterion }) {
  const relatedCount = criterion.commands.length + criterion.artifacts.length;
  return (
    <li className="judgment-criterion-card">
      <div className="judgment-criterion-head">
        <h3><span aria-hidden="true">{criterion.ordinal}.</span> {criterion.text}</h3>
        <div
          className={`judgment-submitter-claim ${criterion.submitterClaimsPass ? 'is-pass' : 'is-other'}`}
          aria-label={`提交者结论：${criterion.submitterConclusion}`}
        >
          <span>提交者结论</span>
          <strong>
            {criterion.submitterClaimsPass
              ? `声称通过（${criterion.submitterConclusion}）`
              : criterion.submitterConclusion}
          </strong>
        </div>
      </div>
      <dl className="judgment-criterion-finding">
        <dt>提交者 finding</dt>
        <dd>{criterion.finding ?? '未提供 finding'}</dd>
      </dl>
      {relatedCount > 0 ? (
        <LazyDetails
          className="judgment-criterion-evidence"
          summary={<span>查看关联命令与产物（{relatedCount}）</span>}
        >
          <div className="judgment-related-evidence">
            {criterion.commands.map((command) => <CommandFact key={command.id} command={command} />)}
            {criterion.artifacts.map((artifact) => <ArtifactFact key={artifact.id} artifact={artifact} />)}
          </div>
        </LazyDetails>
      ) : (
        <p className="judgment-no-related">该判据未声明关联命令或产物。</p>
      )}
    </li>
  );
}

const STATE_COPY: Record<JudgmentReview['reviewState'], {
  label: string;
  color: string;
  text: string;
}> = {
  ACTION_REQUIRED: {
    label: '当前版本 · 待审批',
    color: 'gold',
    text: '这是当前 evidence 版本。以下结论由提交者声明，请核对证据后再决定。',
  },
  AWAITING_NEW_EVIDENCE: {
    label: '等待补充证据',
    color: 'blue',
    text: '账户所有者已要求补充证据；任务等待新的 evidence revision。',
  },
  APPROVED: {
    label: '账户所有者已批准',
    color: 'green',
    text: '此 evidence 版本已经完成账户所有者签字，下面展示服务端重读后的事实。',
  },
  SUPERSEDED: {
    label: '已被新版本替代',
    color: 'default',
    text: '此请求已 superseded，只能作为历史审计查看，不能再提交决定。',
  },
  DECIDED: {
    label: '请求已决定',
    color: 'default',
    text: '此请求已经决定，只能作为历史审计查看。',
  },
  EVIDENCE_REVISED: {
    label: '已有新证据',
    color: 'blue',
    text: '要求补充的 evidence 已有新 revision；请打开 current request 后再决定。',
  },
};

const FALLBACK_COPY: Record<JudgmentEvidenceFallbackReason, string> = {
  MISSING_VERSION: '这份旧 evidence 未声明可识别的格式版本。',
  UNSUPPORTED_VERSION: '这份 evidence 的格式版本尚未受当前页面支持。',
  UNRECOGNIZED_V1_SHAPE: '这份旧版 v1 evidence 未携带可验证的结构化判据原文与逐条结论。',
  INCOMPLETE_CRITERIA: '这份 v1 evidence 的结构化判据不完整，无法安全形成逐条决策视图。',
};

function ApprovalImpact({ data, actionable }: { data: JudgmentReview; actionable: boolean }) {
  const impact = data.approvalImpact;
  const dependentNodes = data.derived.dependencyGraph.nodes.filter((node) => node.id !== data.task.id);
  return (
    <section className="judgment-review-section judgment-impact" aria-labelledby="judgment-impact-heading" aria-live="polite">
      <h2 id="judgment-impact-heading">批准后的影响</h2>
      {actionable && impact ? (
        <>
          <p className="judgment-section-intro">
            以下条件性结果由服务端随本次 request 返回；只有 exact request 与 digest 仍为 current 且签字成功时才成立。
          </p>
          <div className="judgment-impact-grid" data-authority={impact.authority}>
            <div><span>task</span><strong>派生为 {impact.task.resultingStatus}</strong></div>
            <div><span>request</span><strong>{impact.request.resultingStatus} · {impact.request.decision}</strong></div>
            <div><span>signal</span><strong>{impact.signal.resultingOpen ? '保持开放' : '关闭'}</strong></div>
            <div><span>blocker</span><strong>{impact.blocker.resultingOpen ? '保持开放' : '关闭'}</strong></div>
          </div>
          <p className="judgment-authority-note">不预估下游任务；决定成功后，本页会再次读取服务端事实。</p>
        </>
      ) : actionable ? (
        <p className="judgment-no-impact" data-testid="no-authoritative-impact">
          当前响应未提供可显示的权威影响；本页不做前端预估，决定成功后再重读服务端。
        </p>
      ) : (
        <>
          <p className="judgment-section-intro">当前请求不可再决定；以下是本次服务端读取到的事实。</p>
          <div className="judgment-impact-grid" data-authority="SERVER_READ">
            <div><span>task</span><strong>{data.derived.taskStatus}</strong></div>
            <div>
              <span>request</span>
              <strong>{data.request.status}{data.request.decision ? ` · ${data.request.decision}` : ''}</strong>
            </div>
            <div><span>signal</span><strong>{data.derived.signalOpen ? '开放' : '已关闭'}</strong></div>
            <div><span>blocker</span><strong>{data.derived.blockerOpen ? '开放' : '已关闭'}</strong></div>
          </div>
          {dependentNodes.length > 0 && (
            <div className="judgment-server-dependencies">
              <h3>服务端重读的直接依赖</h3>
              <ul className="judgment-dependencies">
                {dependentNodes.map((node) => (
                  <li key={node.id}>
                    <Link to={`/tasks/${encodeId(node.id)}`}>{node.title}</Link>
                    <span>{node.status} · {node.dependencyState}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function JudgmentReviewPage() {
  const requestId = routeId(useParams().id);
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const decisionRef = useRef<HTMLTextAreaElement>(null);
  const currentRequestRef = useRef<HTMLAnchorElement>(null);
  const focusedRequestRef = useRef<string | null>(null);
  const review = useQuery({
    queryKey: ['judgment', requestId],
    queryFn: () => api<JudgmentReview>(`/judgments/${encodeURIComponent(requestId!)}`),
    enabled: Boolean(requestId),
  });

  useEffect(() => {
    setNote('');
    setInlineError(null);
    setHistoryOpen(false);
    setAuditOpen(false);
  }, [requestId]);
  useEffect(() => {
    if (review.isSuccess && focusedRequestRef.current !== requestId) {
      focusedRequestRef.current = requestId;
      headingRef.current?.focus();
    }
  }, [review.isSuccess, requestId]);
  useEffect(() => {
    if (inlineError) errorRef.current?.focus();
  }, [inlineError]);

  const refreshRelated = async (data: JudgmentReview) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['judgments'] }),
      qc.invalidateQueries({ queryKey: ['task', data.task.id] }),
      qc.invalidateQueries({ queryKey: ['tasks'] }),
      data.task.projectId
        ? qc.invalidateQueries({ queryKey: ['project', data.task.projectId] })
        : Promise.resolve(),
      qc.invalidateQueries({ queryKey: ['projects'] }),
    ]);
  };

  const decide = useMutation({
    mutationFn: (action: 'PASS' | 'REQUEST_MORE_EVIDENCE') => {
      if (!review.data || !requestId) throw new Error('审阅请求尚未准备好。');
      return api<JudgmentReview>(`/judgments/${encodeURIComponent(requestId)}/decision`, {
        method: 'POST',
        body: {
          requestId: review.data.request.id,
          evidenceDigest: review.data.evidence.digest,
          action,
          note: note.trim(),
        },
      });
    },
    onMutate: () => setInlineError(null),
    onSuccess: async (serverRead) => {
      setNote('');
      await refreshRelated(serverRead);
      // 决定之后再次读取服务端；不在客户端乐观写 DONE/request/signal/blocker/依赖。
      await review.refetch();
    },
    onError: async (error: Error) => {
      // 原始服务端拒绝保留在页面内，再刷新 current revision；用户可以据此恢复焦点。
      setInlineError(error.message);
      if (review.data) await refreshRelated(review.data);
      await review.refetch();
    },
  });

  const presentation = useMemo(
    () => adaptJudgmentEvidence(review.data?.evidence.structured),
    [review.data?.evidence.structured],
  );

  if (!requestId) {
    return <Alert type="error" showIcon title="无法加载审批请求" description="链接缺少 request id。" />;
  }
  if (review.isLoading) {
    return <div className="judgment-loading" role="status" aria-label="正在加载审批请求"><Spin /></div>;
  }
  if (review.isError || !review.data) {
    return (
      <Alert
        type="error"
        showIcon
        title="无法加载审批请求"
        description={review.error instanceof Error ? review.error.message : undefined}
        action={(
          <Button
            danger
            loading={review.isFetching}
            disabled={review.isFetching}
            onClick={() => review.refetch()}
          >
            重试
          </Button>
        )}
      />
    );
  }

  const data = review.data;
  const state = STATE_COPY[data.reviewState];
  const actionable = data.isCurrent && data.reviewState === 'ACTION_REQUIRED';
  const canonicalRequestId = routeId(data.request.id);
  const canonicalCurrentRequestId = routeId(data.currentEvidence.requestId);
  const currentRequestLink = canonicalCurrentRequestId
    && canonicalCurrentRequestId !== canonicalRequestId
      ? judgmentReviewPath(canonicalCurrentRequestId)
      : null;
  const actor = data.evidence.actorName
    ?? (data.evidence.actorType === 'AGENT' ? 'Agent 提交者' : '账户用户');
  const passClaimCount = presentation.kind === 'SUPPORTED'
    ? presentation.criteria.filter((criterion) => criterion.submitterClaimsPass).length
    : 0;

  return (
    <article className="judgment-page judgment-review-page">
      <Link className="judgment-back-link" to="/judgments">← 待我判定</Link>
      <header className="judgment-review-head">
        <div>
          <div className="judgment-title-row">
            <h1 ref={headingRef} tabIndex={-1} className="page-title">审阅完成证据</h1>
            <Tag color={state.color}>{state.label}</Tag>
          </div>
          <Link className="judgment-task-title" to={`/tasks/${encodeId(data.task.id)}`}>{data.task.title}</Link>
          <p className="judgment-task-scope">
            <span>人工签字（HUMAN_SIGNOFF）</span>
            <span>task {data.derived.taskStatus}</span>
          </p>
        </div>
      </header>

      <Alert
        className="judgment-state-alert"
        type={data.reviewState === 'APPROVED' ? 'success' : actionable ? 'info' : 'warning'}
        showIcon
        title={state.text}
        description={currentRequestLink ? (
          <Link ref={currentRequestRef} to={currentRequestLink}>
            打开 current evidence r{data.currentEvidence.revision} →
          </Link>
        ) : undefined}
      />

      {inlineError && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="judgment-inline-error">
          <strong>决定未记录。</strong>
          <span>{inlineError}</span>
          <Button
            danger
            onClick={() => {
              setInlineError(null);
              decide.reset();
              if (actionable) decisionRef.current?.focus();
              else if (currentRequestRef.current) currentRequestRef.current.focus();
              else headingRef.current?.focus();
            }}
            disabled={decide.isPending}
          >
            关闭错误
          </Button>
        </div>
      )}

      <section className="judgment-evidence-identity" aria-labelledby="judgment-evidence-heading">
        <div className="judgment-identity-head">
          <div>
            <h2 id="judgment-evidence-heading">Evidence 身份</h2>
            <span>证据 r{data.evidence.revision}</span>
          </div>
          <Tag color={data.isCurrent ? 'green' : 'default'}>
            {data.isCurrent ? `current r${data.currentEvidence.revision}` : `非 current · current r${data.currentEvidence.revision}`}
          </Tag>
        </div>
        <dl className="judgment-identity-facts">
          <div><dt>提交者 / 时间</dt><dd>{actor} · <time dateTime={data.evidence.submittedAt}>{when(data.evidence.submittedAt)}</time></dd></div>
          <div><dt>commit</dt><dd><code title={data.evidence.commit ?? undefined}>{shortCommit(data.evidence.commit)}</code></dd></div>
          <div className="judgment-identity-digest">
            <dt>evidence digest</dt>
            <dd><code title={data.evidence.digest}>{shortDigest(data.evidence.digest)}</code></dd>
          </div>
        </dl>
        <CopyTextButton value={data.evidence.digest} label="复制完整 digest" />
        {!data.isCurrent && (
          <div className="judgment-current-replacement">
            <span>current evidence r{data.currentEvidence.revision}</span>
            <code title={data.currentEvidence.digest}>{shortDigest(data.currentEvidence.digest)}</code>
            <CopyTextButton value={data.currentEvidence.digest} label="复制 current digest" />
          </div>
        )}
      </section>

      <section className="judgment-criteria" aria-labelledby="judgment-criteria-heading">
        <div className="judgment-section-title-row">
          <h2 id="judgment-criteria-heading">完成判据</h2>
          {presentation.kind === 'SUPPORTED' && (
            <span className="judgment-claim-count">
              {passClaimCount}/{presentation.criteria.length} 项提交者声称通过
            </span>
          )}
        </div>
        {presentation.kind === 'SUPPORTED' ? (
          <>
            <p className="judgment-criteria-notice">逐条内容由不可变 evidence 确定性呈现；提交者的 PASS 不是账户所有者批准。</p>
            <ol className="judgment-criterion-list">
              {presentation.criteria.map((criterion) => (
                <CriterionCard key={criterion.key} criterion={criterion} />
              ))}
            </ol>
          </>
        ) : (
          <Alert
            className="judgment-compatibility-alert"
            type="warning"
            showIcon
            title="此 evidence 暂不能按判据展示"
            description={(
              <div>
                <p>{FALLBACK_COPY[presentation.reason]} 页面不会拆解 acceptanceCriteria 散文，也不会补造缺失结论。</p>
                <Button onClick={() => setAuditOpen(true)}>在通用审计查看器中查看原始事实</Button>
              </div>
            )}
          />
        )}
      </section>

      <ApprovalImpact data={data} actionable={actionable} />

      <section className="judgment-decision" aria-labelledby="judgment-decision-heading">
        <div className="judgment-decision-title">
          <h2 id="judgment-decision-heading">决定说明</h2>
          <span>必填</span>
        </div>
        <label htmlFor="judgment-decision-note">记录你核对了什么，或明确还缺少什么</label>
        <textarea
          id="judgment-decision-note"
          ref={decisionRef}
          rows={5}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={!actionable || decide.isPending}
          required
          aria-required="true"
          aria-describedby="judgment-decision-help judgment-decision-status"
          placeholder="例如：已核对 commit、两种手机视口与完整测试输出……"
        />
        <p id="judgment-decision-help">
          批准会绑定当前 request 与 exact evidenceDigest；要求补充证据不会更改 task status。
        </p>
        <p id="judgment-decision-status" className="sr-only" role="status" aria-live="polite">
          {decide.isPending ? '正在提交决定，请勿重复操作。' : actionable ? '可以填写决定说明。' : '此请求不可再决定。'}
        </p>
        <div className="judgment-decision-actions" aria-busy={decide.isPending}>
          <Button
            loading={decide.isPending && decide.variables === 'REQUEST_MORE_EVIDENCE'}
            disabled={!actionable || !note.trim() || decide.isPending}
            onClick={() => decide.mutate('REQUEST_MORE_EVIDENCE')}
          >
            要求补充证据
          </Button>
          <Button
            type="primary"
            loading={decide.isPending && decide.variables === 'PASS'}
            disabled={!actionable || !note.trim() || decide.isPending}
            onClick={() => decide.mutate('PASS')}
          >
            批准此证据版本
          </Button>
        </div>
      </section>

      <LazyDetails
        className="judgment-review-disclosure judgment-history-panel"
        summary={(
          <span className="judgment-disclosure-summary">
            <strong>历史版本</strong>
            <span>{data.history.length} 个 revision</span>
          </span>
        )}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      >
        <div className="judgment-history">
          {data.history.map((entry) => {
            const historyRequest = entry.requests[entry.requests.length - 1];
            return (
              <article key={entry.id} className="judgment-history-entry">
                <div>
                  <strong>证据 r{entry.revision}</strong>
                  <span>{shortDigest(entry.digest)}</span>
                  <span>{entry.isCurrentEvidence ? 'current evidence' : historyRequest?.status ?? '历史记录'}</span>
                </div>
                <dl>
                  <div><dt>提交者</dt><dd>{entry.actorName ?? entry.actorType}</dd></div>
                  <div><dt>时间</dt><dd>{when(entry.submittedAt)}</dd></div>
                  <div><dt>commit</dt><dd>{shortCommit(entry.commit)}</dd></div>
                  <div><dt>决定</dt><dd>{historyRequest?.decision ?? historyRequest?.status ?? '无'}</dd></div>
                </dl>
                {historyRequest?.decisionNote && <p>决定说明：{historyRequest.decisionNote}</p>}
                {historyRequest?.signoff && <p>签字证据：{historyRequest.signoff.evidence}</p>}
              </article>
            );
          })}
        </div>
      </LazyDetails>

      <LazyDetails
        id="judgment-audit"
        className="judgment-review-disclosure judgment-audit-panel"
        summary={(
          <span className="judgment-disclosure-summary">
            <strong>技术与审计详情 · 原始 JSON</strong>
            <span>默认折叠</span>
          </span>
        )}
        open={auditOpen}
        onOpenChange={setAuditOpen}
      >
        <div className="judgment-audit-content">
          <p>以下内容按 API JSON 值安全渲染；可逐项复制用于审计。</p>
          <RawJsonFact label="criterion 原始对象" value={data.criterion} />
          <RawJsonFact label="structured evidence 原始 JSON" value={data.evidence.structured} />
          <RawJsonFact label="test summary 原始 JSON" value={data.evidence.testSummary} />
          <RawJsonFact label="history revision 原始 JSON" value={data.history} />
        </div>
      </LazyDetails>
    </article>
  );
}
