import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Tag } from 'antd';
import { api, ApiError } from '../api';
import { encodeId } from '../lib/idCodec';
import { shortDigest } from '../lib/judgments';

/**
 * The owner's decision on an agent's proposal to change what this project counts as done.
 *
 * The proposal itself has already been written and has changed nothing: the criteria in force are
 * untouched until this card is answered. So this component's job is to make the change legible
 * enough to answer honestly —
 * which is why it renders the whole eight-item decision protocol and a per-criterion diff rather
 * than a sentence and a Confirm button. A reader who cannot see that a criterion moved from
 * HUMAN_SIGNOFF to VERIFICATION cannot consent to it.
 *
 * `expectedCardDigest` is the load-bearing detail. It is the identity of the exact rendering below,
 * and the server refuses any decision that does not carry the current one — so a proposal the agent
 * revised while this card was open is REFUSED and re-rendered, never approved on the reader's
 * behalf. There is no CTA capability in this surface at all: the decision travels on the owner's
 * already-authenticated connection, so nothing here is forwardable.
 */
export interface CriteriaProposalDiffEntry {
  changeKind: 'ADDED' | 'REMOVED' | 'MODIFIED';
  definitionId: string;
  summary: string;
  textChanged: boolean;
  completionCriterionChanged: boolean;
  verificationMethodChanged: boolean;
  text: { before: string | null; after: string | null };
  completionCriterion: { before: string | null; after: string | null };
  verificationMethod: { before: string | null; after: string | null };
}

export interface CriteriaProposalCard {
  title: string;
  headline: string;
  reason: string;
  whyNotAgent: string;
  options: Array<{ value: 'APPROVE' | 'DENY'; label: string }>;
  impacts: { APPROVE: string; DENY: string };
  recommendation: string;
  noActionConsequence: string;
  cost: string;
  deadline: string;
  resumeBehavior: string;
}

export interface CriteriaProposalRead {
  projectId: string;
  currentCriteriaDigest: string;
  effectiveCriteria: Array<{ definitionId: string; text: string; completionCriterion: string }>;
  proposal: {
    id: string;
    cardDigest: string;
    reasonCode: string;
    status: string;
    baseMatchesCurrentCriteria: boolean;
    card: CriteriaProposalCard;
    semanticDiff: {
      changedCriteria: CriteriaProposalDiffEntry[];
      counts: { added: number; removed: number; modified: number; unchanged: number };
      completionCriterionChanged: boolean;
      verificationMethodChanged: boolean;
    };
  } | null;
}

export function criteriaProposalPath(projectId: string): string {
  return `/projects/${encodeURIComponent(encodeId(projectId))}/criteria-proposal`;
}

export function criteriaProposalDecisionPath(projectId: string): string {
  return `${criteriaProposalPath(projectId)}/decision`;
}

/** Never render server prose as UI text; a typed code is what the reader can act on. */
export function criteriaProposalFailure(error: unknown): { code: string; message: string } {
  const code = error instanceof ApiError
    ? error.code ?? (error.status === 404 ? 'NOT_AVAILABLE_TO_OWNER' : 'REQUEST_FAILED')
    : 'NETWORK_UNCERTAIN';
  if (code === 'CRITERIA_PROPOSAL_CARD_STALE') {
    return { code, message: '提议在你阅读期间被改写了；已重新载入，请看过新的差异再决定。' };
  }
  if (code === 'CRITERIA_PROPOSAL_ALREADY_SETTLED') {
    return { code, message: '这份提议已被新的提议顶替或已有结论；已重新载入当前状态。' };
  }
  if (code === 'CRITERIA_PROPOSAL_BASE_MOVED') {
    return { code, message: '这份提议所基于的契约已经变了；请让 agent 基于当前契约重新提议。' };
  }
  if (code === 'OWNER_RATIFICATION_ACTOR_FORBIDDEN') {
    return { code, message: '只有账号所有者能决定验收标准的修改；本次没有提交任何决定。' };
  }
  if (code === 'NETWORK_UNCERTAIN') {
    return { code, message: '网络结果未知；可以用同一幂等键安全重试，或重新读取当前提议。' };
  }
  return { code, message: '决定未得到可确认的提交结果；请重新读取当前提议后再操作。' };
}

function DiffRow({ entry }: { entry: CriteriaProposalDiffEntry }) {
  const colour = entry.changeKind === 'ADDED'
    ? 'green'
    : entry.changeKind === 'REMOVED' ? 'red' : 'gold';
  return (
    <li className="criteria-proposal-diff-row">
      <Tag color={colour}>{entry.changeKind}</Tag>
      <div className="criteria-proposal-diff-body">
        <div className="criteria-proposal-diff-summary">{entry.summary}</div>
        <dl className="criteria-proposal-diff-fields">
          <dt>断言</dt>
          <dd>
            {entry.textChanged
              ? `${entry.text.before ?? '（新增）'} → ${entry.text.after ?? '（删除）'}`
              : '未变'}
          </dd>
          <dt>completionCriterion</dt>
          <dd>
            {entry.completionCriterionChanged
              ? `${entry.completionCriterion.before ?? '（无）'} → ${entry.completionCriterion.after ?? '（无）'}`
              : '未变'}
          </dd>
          <dt>verificationMethod</dt>
          <dd>
            {entry.verificationMethodChanged
              ? `${entry.verificationMethod.before ?? '（无）'} → ${entry.verificationMethod.after ?? '（无）'}`
              : '未变'}
          </dd>
        </dl>
      </div>
    </li>
  );
}

export function ProjectCriteriaProposalCard({ projectId }: { projectId?: string | null }) {
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const [read, setRead] = useState<CriteriaProposalRead | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useState<'APPROVE' | 'DENY' | null>(null);
  const [outcome, setOutcome] = useState<'APPROVE' | 'DENY' | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setRead(await api<CriteriaProposalRead>(criteriaProposalPath(projectId)));
    } catch (error) {
      // A project with nothing pending is the ordinary case, not an error worth shouting about.
      if (error instanceof ApiError && error.status === 404) { setRead(null); return; }
      setFailure(criteriaProposalFailure(error));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const proposal = read?.proposal ?? null;

  const decide = async (decision: 'APPROVE' | 'DENY') => {
    if (!projectId || !proposal || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(decision);
    setFailure(null);
    try {
      await api(criteriaProposalDecisionPath(projectId), {
        method: 'POST',
        body: {
          decision,
          proposalId: proposal.id,
          // Approve what you SAW: the identity of this exact rendering.
          expectedCardDigest: proposal.cardDigest,
          idempotencyKey: `criteria-proposal:web:v1:${proposal.id}:${decision}`,
        },
      });
      setOutcome(decision);
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    } catch (error) {
      setFailure(criteriaProposalFailure(error));
    } finally {
      inFlight.current = false;
      setSubmitting(null);
      // Whatever happened, the card the reader now sees is the server's current truth.
      await load();
    }
  };

  if (!projectId) return null;
  if (outcome) {
    return (
      <Alert
        type={outcome === 'APPROVE' ? 'success' : 'info'}
        showIcon
        message={outcome === 'APPROVE'
          ? '已批准：新的验收标准已生效。'
          : '已拒绝：生效中的验收标准没有变化，拒绝已被记录。'}
      />
    );
  }
  if (!proposal) return failure ? <Alert type="warning" showIcon message={failure.message} /> : null;

  const card = proposal.card;
  const diff = proposal.semanticDiff;
  return (
    <section className="criteria-proposal-card" aria-label="acceptance criteria proposal">
      <header>
        <Tag color="purple">{proposal.reasonCode}</Tag>
        <strong>{card.title}</strong>
        <span className="criteria-proposal-digest">card {shortDigest(proposal.cardDigest)}</span>
      </header>
      <p className="criteria-proposal-headline">{card.headline}</p>
      <Alert
        type="info"
        showIcon
        message="提议本身没有改动任何东西"
        description={`生效中的验收标准仍然是原来那一份（标准集 ${shortDigest(read!.currentCriteriaDigest)}），直到你在这张卡片上作出决定。`}
      />
      <h4>会变的是这些</h4>
      <ul className="criteria-proposal-diff">
        {diff.changedCriteria.map((entry) => (
          <DiffRow entry={entry} key={entry.definitionId} />
        ))}
      </ul>
      <p className="criteria-proposal-counts">
        新增 {diff.counts.added} · 删除 {diff.counts.removed} · 修改 {diff.counts.modified} · 未动 {diff.counts.unchanged}
      </p>
      <dl className="criteria-proposal-protocol">
        <dt>为什么这件事不能由 agent 决定</dt><dd>{card.whyNotAgent}</dd>
        <dt>批准会怎样</dt><dd>{card.impacts.APPROVE}</dd>
        <dt>拒绝会怎样</dt><dd>{card.impacts.DENY}</dd>
        <dt>建议</dt><dd>{card.recommendation}</dd>
        <dt>什么都不做会怎样</dt><dd>{card.noActionConsequence}</dd>
        <dt>代价</dt><dd>{card.cost}</dd>
        <dt>期限</dt><dd>{card.deadline}</dd>
        <dt>决定之后会自动恢复什么</dt><dd>{card.resumeBehavior}</dd>
      </dl>
      {failure && <Alert type="warning" showIcon message={failure.message} />}
      {!proposal.baseMatchesCurrentCriteria && (
        <Alert
          type="warning"
          showIcon
          message="这份提议所基于的那套验收标准已经变了；批准会被服务器拒绝。"
        />
      )}
      <div className="criteria-proposal-actions">
        {card.options.map((option) => (
          <Button
            key={option.value}
            type={option.value === 'APPROVE' ? 'primary' : 'default'}
            loading={submitting === option.value}
            disabled={submitting !== null}
            onClick={() => { void decide(option.value); }}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
