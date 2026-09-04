import type { TaskCompletionCriterionValue } from './task-completion-criterion';

/** Stable wire identity for a question that asks the caller to reconsider a criterion choice. */
export const TASK_CRITERION_SHAPE_ADVICE_CODE = 'TASK_CRITERION_SHAPE_ADVICE';

/** The create field that records why a caller deliberately kept the questioned choice. */
export const TASK_CRITERION_OVERRIDE_REASON_FIELD =
  'completionCriterionOverrideReason' as const;

/** Audit prose is useful, but a task row is not an unbounded document store. */
export const MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS = 2_000;

export interface TaskCriterionShapeRule {
  criterion: TaskCompletionCriterionValue;
  /** Literal, case-insensitive substrings. No stemming, tokenisation or inferred synonyms. */
  keywords: readonly string[];
  reason: string;
}

/**
 * The whole heuristic, intentionally small and readable.
 *
 * It is data rather than NLP. Adding a phrase changes only this table and its focused tests. The
 * evaluator advises only when exactly one criterion's row matches; mixed or unknown wording is
 * left alone, because a missed prompt is cheaper than confidently questioning an ambiguous one.
 *
 * There is deliberately no EVIDENCE_JUDGMENT row, and the reason is not that nobody answers it:
 * one independent session — one that did not do the work and did not author the evidence — decides
 * the evidence revision its decision references, and a CONFIRM there is what settles the task. The
 * reason is that this table reads WORDING, and no wording says WHO will decide. Its former
 * keywords — authorization, irreversibility, a value at stake — describe what the work costs, not
 * whether an independent decider exists for it, so advising a caller towards that criterion on
 * those words would be a guess about a fact the acceptance prose does not contain.
 */
export const TASK_CRITERION_SHAPE_RULES: readonly TaskCriterionShapeRule[] = [
  {
    criterion: 'EXECUTABLE',
    keywords: ['spec 通过', '测试全绿', '退出码', '命令', '不新增失败', 'typecheck'],
    reason: 'these phrases usually describe a mechanically decidable command or exit-code result',
  },
  {
    criterion: 'VERIFICATION',
    keywords: ['改对了吗', '符合意图', '是否覆盖', '是否合理', '独立复核'],
    reason: 'these phrases usually ask for independent judgment about correctness or intent',
  },
];

export interface TaskCriterionShapeAdviceInput {
  acceptanceCriteria?: string | null;
  completionCriterion?: TaskCompletionCriterionValue | null;
}

export interface TaskCriterionShapeAdvice {
  code: typeof TASK_CRITERION_SHAPE_ADVICE_CODE;
  kind: 'ADVISORY';
  advisory: true;
  declaredCriterion: TaskCompletionCriterionValue;
  suggestedCriterion: TaskCompletionCriterionValue;
  matchedKeywords: string[];
  reason: string;
}

function matchesFor(text: string, rule: TaskCriterionShapeRule): string[] {
  const normalised = text.normalize('NFKC').toLocaleLowerCase('en-US');
  return [...new Set(rule.keywords.filter((keyword) =>
    normalised.includes(keyword.normalize('NFKC').toLocaleLowerCase('en-US')),
  ))];
}

/**
 * Return a question, never a validity verdict.
 *
 * Declaration consistency remains the hard boundary in `taskCompletionDeclarationError`. This
 * function deliberately knows nothing about commands, policies, or verifier links: it compares
 * only the prose shape with an already-declared peer criterion. Unknown and mixed language returns
 * null, as does a matching choice.
 */
export function taskCriterionShapeAdvice(
  input: TaskCriterionShapeAdviceInput,
  rules: readonly TaskCriterionShapeRule[] = TASK_CRITERION_SHAPE_RULES,
): TaskCriterionShapeAdvice | null {
  const text = input.acceptanceCriteria?.trim();
  const declaredCriterion = input.completionCriterion ?? null;
  if (!text || declaredCriterion == null) return null;

  const matches = rules
    .map((rule) => ({ rule, matchedKeywords: matchesFor(text, rule) }))
    .filter((match) => match.matchedKeywords.length > 0);
  // Conservative by construction: mixed signals and unknown prose do not produce advice.
  if (matches.length !== 1) return null;

  const [{ rule, matchedKeywords }] = matches;
  if (rule.criterion === declaredCriterion) return null;
  const quoted = matchedKeywords.map((keyword) => `“${keyword}”`).join(', ');
  return {
    code: TASK_CRITERION_SHAPE_ADVICE_CODE,
    kind: 'ADVISORY',
    advisory: true,
    declaredCriterion,
    suggestedCriterion: rule.criterion,
    matchedKeywords,
    reason:
      `Acceptance criteria matched ${rule.criterion} shape ${quoted}: ${rule.reason}. ` +
      `The declared criterion is ${declaredCriterion}.`,
  };
}

/** Trim audit prose once, at the write boundary; null means no override was recorded. */
export function normaliseTaskCriterionOverrideReason(
  reason: string | null | undefined,
): string | null {
  const normalised = reason?.trim() ?? '';
  return normalised === '' ? null : normalised;
}

/** The structured 409 body every transport can present as a question rather than a hard refusal. */
export function taskCriterionShapeAdviceBody(advice: TaskCriterionShapeAdvice) {
  return {
    ...advice,
    message:
      `${advice.reason} Use ${advice.suggestedCriterion}, or keep ` +
      `${advice.declaredCriterion} and provide a non-blank ` +
      `${TASK_CRITERION_OVERRIDE_REASON_FIELD}.`,
    requiredAction: 'USE_SUGGESTED_CRITERION_OR_EXPLAIN_OVERRIDE',
    overrideReasonField: TASK_CRITERION_OVERRIDE_REASON_FIELD,
  } as const;
}
