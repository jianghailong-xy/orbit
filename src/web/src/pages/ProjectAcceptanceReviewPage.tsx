import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Spin, Tag } from 'antd';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { encodeId, routeId } from '../lib/idCodec';
import {
  projectAcceptanceOverviewPath,
  projectAcceptanceVerdictPath,
  type ProjectAcceptanceCriterion,
  type ProjectAcceptanceCriterionDecision,
  type ProjectAcceptanceOverview,
  type ProjectAcceptanceRun,
  type ProjectAcceptanceVerdict,
} from '../lib/projectAcceptance';

type DraftVerdict = ProjectAcceptanceVerdict | '';

interface CriterionDraft {
  verdict: DraftVerdict;
  summary: string;
  evidenceTaskId: string;
  evidenceSessionId: string;
  command: string;
  exitCode: string;
}

const VERDICTS: ProjectAcceptanceVerdict[] = ['PASS', 'FAIL', 'INCONCLUSIVE'];
const VERDICT_COLOR: Record<ProjectAcceptanceVerdict | 'UNDECIDED', string> = {
  PASS: 'green',
  FAIL: 'red',
  INCONCLUSIVE: 'gold',
  UNDECIDED: 'default',
};

const when = (value: string): string => new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value));

function asEvidence(value: unknown): { command: string; exitCode: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { command: '', exitCode: '' };
  }
  const evidence = value as Record<string, unknown>;
  return {
    command: typeof evidence.command === 'string' ? evidence.command : '',
    exitCode: typeof (evidence.exitCode ?? evidence.actualExitCode) === 'number'
      && Number.isInteger(evidence.exitCode ?? evidence.actualExitCode)
      ? String(evidence.exitCode ?? evidence.actualExitCode)
      : '',
  };
}

function draftFrom(criterion: ProjectAcceptanceCriterion): CriterionDraft {
  const evidence = asEvidence(criterion.evidence);
  return {
    verdict: criterion.verdict ?? '',
    summary: criterion.summary ?? '',
    evidenceTaskId: criterion.evidenceTaskId ?? '',
    evidenceSessionId: criterion.evidenceSessionId ?? '',
    command: evidence.command,
    exitCode: evidence.exitCode,
  };
}

function decisionFrom(
  criterion: ProjectAcceptanceCriterion,
  draft: CriterionDraft,
): ProjectAcceptanceCriterionDecision {
  if (!draft.verdict) throw new Error(`判据 ${criterion.ordinal} 尚未回答。`);
  const summary = draft.summary.trim();
  const evidenceTaskId = draft.evidenceTaskId.trim();
  const evidenceSessionId = draft.evidenceSessionId.trim();
  const command = draft.command.trim();
  const exitCodeText = draft.exitCode.trim();
  const exitCode = exitCodeText === '' ? undefined : Number(exitCodeText);
  if (exitCode !== undefined && !Number.isInteger(exitCode)) {
    throw new Error(`判据 ${criterion.ordinal} 的退出码必须是整数。`);
  }
  const evidence = command || exitCode !== undefined
    ? { ...(command ? { command } : {}), ...(exitCode !== undefined ? { exitCode } : {}) }
    : undefined;
  return {
    ordinal: criterion.ordinal,
    criterionKey: criterion.criterionKey,
    ...(criterion.criterionId ? { criterionId: criterion.criterionId } : {}),
    verdict: draft.verdict,
    ...(summary ? { summary } : {}),
    ...(evidence ? { evidence } : {}),
    ...(evidenceTaskId ? { evidenceTaskId } : {}),
    ...(evidenceSessionId ? { evidenceSessionId } : {}),
  };
}

const Flat = ({ children }: { children?: ReactNode }) => <>{children}</>;
const INLINE_MARKDOWN = { p: Flat, h1: Flat, h2: Flat, h3: Flat, h4: Flat, h5: Flat, h6: Flat };

function ExistingEvidence({ criterion }: { criterion: ProjectAcceptanceCriterion }) {
  const evidence = asEvidence(criterion.evidence);
  return (
    <dl className="project-acceptance-existing-evidence">
      <div>
        <dt>evidenceTaskId</dt>
        <dd>{criterion.evidenceTaskId
          ? <Link to={`/tasks/${encodeId(criterion.evidenceTaskId)}`}>{criterion.evidenceTaskId}</Link>
          : '未提供'}</dd>
      </div>
      <div>
        <dt>evidenceSessionId</dt>
        <dd>{criterion.evidenceSessionId
          ? <Link to={`/sessions/${encodeId(criterion.evidenceSessionId)}`}>{criterion.evidenceSessionId}</Link>
          : '未提供'}</dd>
      </div>
      <div><dt>命令</dt><dd>{evidence.command || '未提供'}</dd></div>
      <div><dt>退出码</dt><dd>{evidence.exitCode || '未提供'}</dd></div>
    </dl>
  );
}

function CriterionDecisionCard({
  criterion,
  draft,
  disabled,
  onChange,
}: {
  criterion: ProjectAcceptanceCriterion;
  draft: CriterionDraft;
  disabled: boolean;
  onChange: (next: CriterionDraft) => void;
}) {
  const current = criterion.verdict ?? 'UNDECIDED';
  const automatic = criterion.completionCriterion !== 'HUMAN_SIGNOFF';
  const prefix = `project-acceptance-criterion-${criterion.ordinal}`;
  const set = <K extends keyof CriterionDraft>(key: K, value: CriterionDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };
  return (
    <li className="judgment-criterion-card project-acceptance-criterion-card">
      <div className="judgment-criterion-head">
        <h3>
          <span aria-hidden="true">{criterion.ordinal}.</span>{' '}
          <Markdown remarkPlugins={[remarkGfm]} components={INLINE_MARKDOWN}>
            {criterion.criterionText}
          </Markdown>
        </h3>
        <div className="project-acceptance-current-verdict">
          <Tag>{criterion.completionCriterion}</Tag>
          <span>当前 verdict</span>
          <Tag color={VERDICT_COLOR[current]}>{current}</Tag>
        </div>
      </div>

      <section className="project-acceptance-method" aria-label={`判据 ${criterion.ordinal} verificationMethod`}>
        <strong>verificationMethod</strong>
        <p>{criterion.verificationMethod ?? '旧版快照未记录 verificationMethod；请按当前项目定义人工核对。'}</p>
      </section>

      <ExistingEvidence criterion={criterion} />

      {automatic ? (
        <Alert
          type={current === 'FAIL' ? 'error' : current === 'PASS' ? 'success' : 'info'}
          showIcon
          title={`${criterion.completionCriterion} 由服务端自动求值`}
          description={criterion.summary ?? '等待声明的机械证据；这里没有人工降级 verdict。'}
        />
      ) : (
        <>

      <fieldset className="project-acceptance-verdict-field" disabled={disabled}>
        <legend>本次 verdict <span>必答</span></legend>
        <div className="project-acceptance-verdict-options">
          {VERDICTS.map((verdict) => (
            <button
              key={verdict}
              type="button"
              className={`project-acceptance-verdict-option is-${verdict.toLowerCase()}${draft.verdict === verdict ? ' is-selected' : ''}`}
              aria-pressed={draft.verdict === verdict}
              onClick={() => set('verdict', verdict)}
            >
              {verdict}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="project-acceptance-evidence-form">
        <label htmlFor={`${prefix}-task`}>
          evidenceTaskId
          <input
            id={`${prefix}-task`}
            value={draft.evidenceTaskId}
            disabled={disabled}
            onChange={(event) => set('evidenceTaskId', event.target.value)}
            placeholder="任务 public id（可选）"
          />
        </label>
        <label htmlFor={`${prefix}-session`}>
          evidenceSessionId
          <input
            id={`${prefix}-session`}
            value={draft.evidenceSessionId}
            disabled={disabled}
            onChange={(event) => set('evidenceSessionId', event.target.value)}
            placeholder="会话 public id（可选）"
          />
        </label>
        <label className="project-acceptance-command-input" htmlFor={`${prefix}-command`}>
          命令
          <input
            id={`${prefix}-command`}
            value={draft.command}
            disabled={disabled}
            onChange={(event) => set('command', event.target.value)}
            placeholder="例如 npm test -w @orbit/web（可选）"
          />
        </label>
        <label htmlFor={`${prefix}-exit`}>
          退出码
          <input
            id={`${prefix}-exit`}
            type="number"
            step="1"
            inputMode="numeric"
            value={draft.exitCode}
            disabled={disabled}
            onChange={(event) => set('exitCode', event.target.value)}
            placeholder="例如 0"
          />
        </label>
        <label className="project-acceptance-summary-input" htmlFor={`${prefix}-summary`}>
          判定说明
          <textarea
            id={`${prefix}-summary`}
            rows={3}
            value={draft.summary}
            disabled={disabled}
            onChange={(event) => set('summary', event.target.value)}
            placeholder="记录你核对了什么，或为什么无法判定（可选）"
          />
        </label>
      </div>
        </>
      )}
    </li>
  );
}

function stateCopy(run: ProjectAcceptanceRun): { type: 'info' | 'success' | 'warning'; title: string } {
  if (run.supersededAt) return { type: 'warning', title: '此 evidence version 已被替代，只能审计查看。' };
  if (run.verdict === 'PASS') return { type: 'success', title: '此项目验收已由服务端推导为 PASS。' };
  if (run.verdict) return { type: 'warning', title: `此项目验收已由服务端推导为 ${run.verdict}。` };
  return { type: 'info', title: '查看自动求值结果，并只回答需要人的 HUMAN_SIGNOFF 标准。' };
}

export function ProjectAcceptanceReviewPage() {
  const params = useParams();
  const projectId = routeId(params.projectId);
  const runId = routeId(params.runId);
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, CriterionDraft>>({});
  const [inlineError, setInlineError] = useState<string | null>(null);
  const initializedRun = useRef<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const review = useQuery({
    queryKey: ['project-acceptance', 'review', projectId, runId],
    queryFn: () => api<ProjectAcceptanceOverview>(projectAcceptanceOverviewPath(projectId!)),
    enabled: Boolean(projectId && runId),
  });
  const run = useMemo(
    () => review.data?.runs.find((candidate) => routeId(candidate.id) === runId) ?? null,
    [review.data?.runs, runId],
  );
  const humanCriteria = useMemo(
    () => run?.criteria.filter((criterion) => criterion.completionCriterion === 'HUMAN_SIGNOFF') ?? [],
    [run],
  );

  useEffect(() => {
    if (!run || initializedRun.current === run.id) return;
    initializedRun.current = run.id;
    setDrafts(Object.fromEntries(run.criteria.map((criterion) => [criterion.id, draftFrom(criterion)])));
    setInlineError(null);
  }, [run]);
  useEffect(() => {
    if (inlineError) errorRef.current?.focus();
  }, [inlineError]);

  const actionable = Boolean(
    run && !run.supersededAt && review.data?.status !== 'DONE',
  );
  const unanswered = humanCriteria.filter((criterion) => !drafts[criterion.id]?.verdict);
  const invalidExitCodes = humanCriteria.filter((criterion) => {
    const value = drafts[criterion.id]?.exitCode.trim() ?? '';
    return value !== '' && !Number.isInteger(Number(value));
  }) ?? [];
  const answeredCount = humanCriteria.length - unanswered.length;

  const submit = useMutation({
    mutationFn: () => {
      if (!projectId || !runId || !run) throw new Error('项目验收尚未准备好。');
      if (unanswered.length > 0) {
        throw new Error(`每条判据都要回答；尚未回答：${unanswered.map((item) => item.ordinal).join('、')}。`);
      }
      const criteria = humanCriteria.map(
        (criterion) => decisionFrom(criterion, drafts[criterion.id]!),
      );
      return api<ProjectAcceptanceRun>(projectAcceptanceVerdictPath(projectId, runId), {
        method: 'POST',
        body: { criteria },
      });
    },
    onMutate: () => setInlineError(null),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['project-acceptance'] }),
        qc.invalidateQueries({ queryKey: ['judgments'] }),
        qc.invalidateQueries({ queryKey: ['project', projectId] }),
        qc.invalidateQueries({ queryKey: ['projects'] }),
      ]);
      await review.refetch();
    },
    onError: (error: Error) => setInlineError(error.message),
  });

  if (!projectId || !runId) {
    return <Alert type="error" showIcon title="无法加载项目验收" description="链接缺少 project 或 run id。" />;
  }
  if (review.isLoading) {
    return <div className="judgment-loading" role="status" aria-label="正在加载项目验收"><Spin /></div>;
  }
  if (review.isError || !review.data) {
    return (
      <Alert
        type="error"
        showIcon
        title="无法加载项目验收"
        description={review.error instanceof Error ? review.error.message : undefined}
        action={<Button danger onClick={() => review.refetch()}>重试</Button>}
      />
    );
  }
  if (!run) {
    return <Alert type="error" showIcon title="找不到项目验收 run" description={`run ${runId} 不在该项目的最近记录中。`} />;
  }

  const state = stateCopy(run);
  const submitDisabled = !actionable
    || humanCriteria.length === 0
    || unanswered.length > 0
    || invalidExitCodes.length > 0
    || submit.isPending;

  return (
    <article className="judgment-page judgment-review-page project-acceptance-review-page">
      <Link className="judgment-back-link" to="/judgments">← 待我判定</Link>
      <header className="judgment-review-head">
        <div>
          <div className="judgment-title-row">
            <h1 className="page-title">项目验收判定</h1>
            <Tag color={VERDICT_COLOR[run.verdict ?? 'UNDECIDED']}>
              {run.verdict ?? '待逐条判定'}
            </Tag>
          </div>
          <Link className="judgment-task-title" to={`/projects/${encodeId(projectId)}`}>
            {review.data.projectTitle}
          </Link>
          <p className="judgment-task-scope">
            <span>项目级验收</span>
            <span>evidence version / attempt {run.attempt}</span>
            <span>project {review.data.status}</span>
          </p>
        </div>
      </header>

      <Alert
        className="judgment-state-alert project-criteria-confirmation"
        type="info"
        showIcon
        title="本页只处理逐项 HUMAN_SIGNOFF"
        description={`当前标准集 digest ${review.data.criteriaDigest}；改动这套标准要走 agent 提议、账号所有者在卡片上确认的通道，不在本页。`}
      />

      <Alert
        className="judgment-state-alert"
        type={state.type}
        showIcon
        title={state.title}
        description={actionable
          ? `人工标准已回答 ${answeredCount}/${humanCriteria.length}；尚有 ${unanswered.length} 条。其余 ${run.criteria.length - humanCriteria.length} 条由声明的机械判据自动求值。`
          : undefined}
      />

      {inlineError && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="judgment-inline-error">
          <strong>项目验收未记录。</strong>
          <span>{inlineError}</span>
          <Button danger disabled={submit.isPending} onClick={() => setInlineError(null)}>关闭错误</Button>
        </div>
      )}

      <section className="judgment-evidence-identity" aria-labelledby="project-acceptance-identity">
        <div className="judgment-identity-head">
          <div>
            <h2 id="project-acceptance-identity">Evidence 身份</h2>
            <span>run {run.id}</span>
          </div>
          <Tag color={run.supersededAt ? 'default' : 'green'}>
            {run.supersededAt ? 'superseded' : 'current evidence version'}
          </Tag>
        </div>
        <dl className="judgment-identity-facts">
          <div><dt>建立时间</dt><dd><time dateTime={run.startedAt}>{when(run.startedAt)}</time></dd></div>
          <div><dt>attempt</dt><dd>{run.attempt}</dd></div>
          <div><dt>当前 verdict</dt><dd>{run.verdict ?? 'UNDECIDED'}</dd></div>
        </dl>
      </section>

      <section className="judgment-criteria project-acceptance-criteria" aria-labelledby="project-acceptance-criteria-heading">
        <div className="judgment-section-title-row">
          <h2 id="project-acceptance-criteria-heading">标准求值</h2>
          <span className="judgment-claim-count">{answeredCount}/{humanCriteria.length} 条人工标准已回答</span>
        </div>
        <p className="judgment-criteria-notice">
          EXECUTABLE 与 VERIFICATION 只展示自动结果；仅 HUMAN_SIGNOFF 接受人的结论。
        </p>
        <ol className="judgment-criterion-list">
          {run.criteria.map((criterion) => (
            <CriterionDecisionCard
              key={criterion.id}
              criterion={criterion}
              draft={drafts[criterion.id] ?? draftFrom(criterion)}
              disabled={!actionable || submit.isPending || criterion.completionCriterion !== 'HUMAN_SIGNOFF'}
              onChange={(next) => setDrafts((current) => ({ ...current, [criterion.id]: next }))}
            />
          ))}
        </ol>
      </section>

      {humanCriteria.length > 0 ? (
      <section className="judgment-decision project-acceptance-submit" aria-labelledby="project-acceptance-submit-heading">
        <div className="judgment-decision-title">
          <h2 id="project-acceptance-submit-heading">提交完整项目验收</h2>
          <span>仅 HUMAN_SIGNOFF 必答</span>
        </div>
        <p id="project-acceptance-submit-help">
          {unanswered.length > 0
            ? `还需回答判据：${unanswered.map((criterion) => criterion.ordinal).join('、')}。`
            : invalidExitCodes.length > 0
              ? `退出码必须是整数：判据 ${invalidExitCodes.map((criterion) => criterion.ordinal).join('、')}。`
              : '全部判据已回答。最终 run verdict 由服务端根据逐条结论推导。'}
        </p>
        <div className="judgment-decision-actions project-acceptance-submit-actions" aria-busy={submit.isPending}>
          <Button
            type="primary"
            loading={submit.isPending}
            disabled={submitDisabled}
            aria-describedby="project-acceptance-submit-help"
            onClick={() => submit.mutate()}
          >
            提交 {humanCriteria.length} 条人工判定
          </Button>
        </div>
      </section>
      ) : (
        <Alert
          type="info"
          showIcon
          title="没有需要人工逐条判定的标准"
          description="EXECUTABLE / VERIFICATION 证据全部满足时项目会自动 DONE；这里不会制造 HUMAN_SIGNOFF。"
        />
      )}

      <details className="judgment-review-disclosure project-acceptance-audit">
        <summary>
          <span className="judgment-disclosure-summary">
            <strong>技术与审计详情 · 原始 JSON</strong>
            <span>默认折叠</span>
          </span>
        </summary>
        <div className="judgment-audit-content">
          <pre className="judgment-json">{JSON.stringify(run, null, 2)}</pre>
        </div>
      </details>
    </article>
  );
}
