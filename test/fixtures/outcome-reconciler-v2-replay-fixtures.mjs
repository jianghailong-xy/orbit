import { sha256Canonical } from '../../scripts/lib/outcome-reconciler-v2.mjs';

export const REPLAY_CATEGORIES = Object.freeze({
  ENTRY_WITHOUT_EXIT: 'ENTRY_WITHOUT_EXIT',
  DONE_NOT_MERGED: 'DONE_NOT_MERGED',
  READ_MODEL_GAP: 'READ_MODEL_GAP',
  SAFETY_BOUNDARY: 'SAFETY_BOUNDARY',
  STATE_ALGEBRA: 'STATE_ALGEBRA',
  WRITER_FENCE: 'WRITER_FENCE',
  MIXED_CLIENT: 'MIXED_CLIENT',
  ACTION_SAFETY: 'ACTION_SAFETY',
  CONCURRENCY: 'CONCURRENCY',
  TIMEOUT_RACE: 'TIMEOUT_RACE',
  GOAL_ATTEMPT: 'GOAL_ATTEMPT',
});

export const REPLAY_CATEGORY_MINIMUMS = Object.freeze({
  [REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT]: 7,
  [REPLAY_CATEGORIES.DONE_NOT_MERGED]: 7,
  [REPLAY_CATEGORIES.READ_MODEL_GAP]: 3,
});

const ORIGINAL_SESSION = '34EV22A2DjC2mNaOVK6JS';
const ORIGINAL_PROMPT_RECORDED_AT = '2026-08-27T16:07:23.472Z';

function historicalSource(section, item, excerpt, context = {}) {
  return {
    kind: 'ORBIT_SESSION_PROMPT_SNAPSHOT',
    ref: `orbit-session:${ORIGINAL_SESSION}:prompt:${section}:${item}`,
    sessionId: ORIGINAL_SESSION,
    recordedAt: ORIGINAL_PROMPT_RECORDED_AT,
    section,
    item,
    excerpt,
    context,
  };
}

function repositorySource(path, symbol, claim) {
  return {
    kind: 'REPOSITORY_SOURCE',
    ref: `${path}#${symbol}`,
    path,
    symbol,
    claim,
  };
}

function defineFixture(spec) {
  const sourceHash = sha256Canonical(spec.source);
  return Object.freeze({
    requestedDeadlineSeconds: null,
    effectiveDeadlineSeconds: null,
    terminationKind: null,
    ...spec,
    sourceHash,
  });
}

const entryFixtures = [
  defineFixture({
    id: 'history-entry-01-no-done-writer',
    category: REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    scenario: 'EVALUATOR_OBLIGATION',
    source: historicalSource('entry-without-exit', 1,
      '禁止执行会话给自己写 DONE 后没有指定后继 writer；工作完成后任务静默停在 OPEN。'),
    input: {
      from: 'WORK_REPORTED_COMPLETE_TASK_OPEN', event: 'SEALED_CUT_EVALUATED',
      goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN',
      omittedDimensions: ['CRITERIA_EVALUATION'],
    },
    expectedTransition: {
      from: 'WORK_REPORTED_COMPLETE_TASK_OPEN', event: 'SEALED_CUT_EVALUATED',
      to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
      obligationKind: 'SATISFY_COMPLETION_DIMENSION',
      reasonCode: 'NO_CURRENT_TRUSTED_EVIDENCE',
    },
    expectedFinalObligation: {
      kind: 'SATISFY_COMPLETION_DIMENSION', state: 'ACTIVE', owner: 'AGENT',
      reasonCode: 'NO_CURRENT_TRUSTED_EVIDENCE',
    },
  }),
  defineFixture({
    id: 'history-entry-02-human-signal-no-exit',
    category: REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    scenario: 'EVALUATOR_OBLIGATION',
    source: historicalSource('entry-without-exit', 2,
      '人工判定信号有打开路径而没有关闭路径；判定完成后 blocker 仍使 doneGate 永久拒绝。'),
    input: {
      from: 'OWNER_DECISION_RECORDED_STALE_BLOCKER', event: 'CURRENT_CUT_REDUCED',
      goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN', attemptOutcome: 'FAILED',
    },
    expectedTransition: {
      from: 'OWNER_DECISION_RECORDED_STALE_BLOCKER', event: 'CURRENT_CUT_REDUCED',
      to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
      obligationKind: 'START_SUCCESSOR_ATTEMPT',
      reasonCode: 'ATTEMPT_FAILED_GOAL_ACTIVE',
    },
    expectedFinalObligation: {
      kind: 'START_SUCCESSOR_ATTEMPT', state: 'ACTIVE', owner: 'AGENT',
      reasonCode: 'ATTEMPT_FAILED_GOAL_ACTIVE',
    },
  }),
  defineFixture({
    id: 'history-entry-03-l0-in-progress-contradiction',
    category: REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    scenario: 'EVALUATOR_OBLIGATION',
    source: historicalSource('entry-without-exit', 3,
      'L0 要求 IN_PROGRESS 才排队，但派发 prompt 禁止写 IN_PROGRESS；L0 从未触发且 OPEN 无信号。'),
    input: {
      from: 'OPEN_WITH_NO_REACHABLE_DISPATCH', event: 'DURABLE_TIMER_OVERDUE',
      goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN', durableTimerOverdue: true,
    },
    expectedTransition: {
      from: 'OPEN_WITH_NO_REACHABLE_DISPATCH', event: 'DURABLE_TIMER_OVERDUE',
      to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
      obligationKind: 'RECOVER_RECONCILER', reasonCode: 'OVERDUE_DURABLE_TIMER',
    },
    expectedFinalObligation: {
      kind: 'RECOVER_RECONCILER', state: 'ACTIVE', owner: 'SYSTEM',
      reasonCode: 'OVERDUE_DURABLE_TIMER',
    },
  }),
  defineFixture({
    id: 'history-entry-04-cli-help-without-handler',
    category: REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    scenario: 'EVALUATOR_OBLIGATION',
    source: historicalSource('entry-without-exit', 4,
      'CLI 只增加 help 文本而没有 handler；usage 中可见的三个命令执行时均为 unknown command。'),
    input: {
      from: 'COMMAND_ADVERTISED_HANDLER_ABSENT', event: 'CAPABILITY_GRAPH_CHECKED',
      goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN',
      dimensionStates: { MODEL_COVERAGE: { state: 'UNSATISFIED', reasonCode: 'CLI_HANDLER_UNREACHABLE' } },
      modelGapCodes: ['CLI_HANDLER_UNREACHABLE'],
    },
    expectedTransition: {
      from: 'COMMAND_ADVERTISED_HANDLER_ABSENT', event: 'CAPABILITY_GRAPH_CHECKED',
      to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
      obligationKind: 'DIAGNOSE_MODEL_GAP', reasonCode: 'CLI_HANDLER_UNREACHABLE',
    },
    expectedFinalObligation: {
      kind: 'DIAGNOSE_MODEL_GAP', state: 'ACTIVE', owner: 'AGENT',
      reasonCode: 'CLI_HANDLER_UNREACHABLE',
    },
  }),
  defineFixture({
    id: 'history-entry-05-blocker-hidden-from-agent',
    category: REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    scenario: 'EVALUATOR_OBLIGATION',
    source: historicalSource('entry-without-exit', 5,
      '修复 CLI 时删除 help 而非补 handler；doneGate 报 blocker，却没有任何 agent 路径能读到 blocker。'),
    input: {
      from: 'DONE_GATE_BLOCKED_AGENT_BLIND', event: 'MODEL_COVERAGE_REDUCED',
      goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN',
      dimensionStates: { MODEL_COVERAGE: { state: 'UNKNOWN', reasonCode: 'BLOCKER_DETAIL_NOT_REACHABLE' } },
    },
    expectedTransition: {
      from: 'DONE_GATE_BLOCKED_AGENT_BLIND', event: 'MODEL_COVERAGE_REDUCED',
      to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
      obligationKind: 'DIAGNOSE_MODEL_GAP', reasonCode: 'BLOCKER_DETAIL_NOT_REACHABLE',
    },
    expectedFinalObligation: {
      kind: 'DIAGNOSE_MODEL_GAP', state: 'ACTIVE', owner: 'AGENT',
      reasonCode: 'BLOCKER_DETAIL_NOT_REACHABLE',
    },
  }),
  defineFixture({
    id: 'history-entry-06-terminal-evidence-supersede-deadlock',
    category: REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    scenario: 'EVALUATOR_OBLIGATION',
    source: historicalSource('entry-without-exit', 6,
      'evidence 多版本 supersede 未覆盖判据已满足后提交新版本；产生不可决定也不可手动关闭的 request。'),
    input: {
      from: 'SATISFIED_CRITERION_STALE_EVIDENCE_REQUEST', event: 'NEW_BINDING_CUT_REDUCED',
      goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN',
      dimensionStates: { BINDING_FRESHNESS: { state: 'UNKNOWN', reasonCode: 'TERMINAL_EVIDENCE_REVISION_UNDECIDABLE' } },
    },
    expectedTransition: {
      from: 'SATISFIED_CRITERION_STALE_EVIDENCE_REQUEST', event: 'NEW_BINDING_CUT_REDUCED',
      to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
      obligationKind: 'REFRESH_STALE_BINDING', reasonCode: 'TERMINAL_EVIDENCE_REVISION_UNDECIDABLE',
    },
    expectedFinalObligation: {
      kind: 'REFRESH_STALE_BINDING', state: 'ACTIVE', owner: 'SYSTEM',
      reasonCode: 'TERMINAL_EVIDENCE_REVISION_UNDECIDABLE',
    },
  }),
  defineFixture({
    id: 'history-entry-07-confirmation-invalidates-run-silently',
    category: REPLAY_CATEGORIES.ENTRY_WITHOUT_EXIT,
    scenario: 'EVALUATOR_OBLIGATION',
    source: historicalSource('entry-without-exit', 7,
      '确认标准集推进 evidence version 并废掉当前 acceptance run；UI 只说已替代，没有提示重开。'),
    input: {
      from: 'ACCEPTANCE_RUN_SUPERSEDED_WITHOUT_NEXT_ACTION', event: 'CURRENT_REVISION_CUT_REDUCED',
      goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN',
      dimensionStates: { CRITERIA_EVALUATION: { state: 'UNKNOWN', reasonCode: 'ACCEPTANCE_RUN_SUPERSEDED_UNREOPENED' } },
    },
    expectedTransition: {
      from: 'ACCEPTANCE_RUN_SUPERSEDED_WITHOUT_NEXT_ACTION', event: 'CURRENT_REVISION_CUT_REDUCED',
      to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
      obligationKind: 'SATISFY_COMPLETION_DIMENSION', reasonCode: 'ACCEPTANCE_RUN_SUPERSEDED_UNREOPENED',
    },
    expectedFinalObligation: {
      kind: 'SATISFY_COMPLETION_DIMENSION', state: 'ACTIVE', owner: 'AGENT',
      reasonCode: 'ACCEPTANCE_RUN_SUPERSEDED_UNREOPENED',
    },
  }),
];

const doneIncidentSource = '任务 DONE 但代码未合并到主干的形状出现 7 次，均由人工核对发现；其中 EXECUTABLE 在任务 worktree 内通过而看不见是否合并。';
const doneCases = [
  ['history-done-unmerged-01-missing-receipt', 'ARTIFACT_INTEGRATION', 'UNKNOWN', 'MERGE_RECEIPT_MISSING', 'PROVE_ARTIFACT_INTEGRATION'],
  ['history-done-unmerged-02-source-sha-mismatch', 'ARTIFACT_INTEGRATION', 'UNSATISFIED', 'MERGE_RECEIPT_SOURCE_SHA_MISMATCH', 'PROVE_ARTIFACT_INTEGRATION'],
  ['history-done-unmerged-03-target-absence', 'TARGET_PRESENCE', 'UNSATISFIED', 'TARGET_SHA_DOES_NOT_CONTAIN_SOURCE', 'PROVE_TARGET_PRESENCE'],
  ['history-done-unmerged-04-stale-target-sha', 'BINDING_FRESHNESS', 'UNSATISFIED', 'MERGE_RECEIPT_TARGET_SHA_STALE', 'REFRESH_STALE_BINDING'],
  ['history-done-unmerged-05-artifact-conflict', 'ARTIFACT_INTEGRATION', 'CONFLICT', 'ARTIFACT_DIGEST_CONFLICT', 'PROVE_ARTIFACT_INTEGRATION'],
  ['history-done-unmerged-06-post-merge-verification-missing', 'POST_MERGE_VERIFICATION', 'UNKNOWN', 'POST_MERGE_VERIFICATION_MISSING', 'RUN_BOUND_VERIFICATION'],
  ['history-done-unmerged-07-worktree-only-pass', 'ARTIFACT_INTEGRATION', 'UNKNOWN', 'WORKTREE_ONLY_EXECUTABLE_PASS', 'PROVE_ARTIFACT_INTEGRATION'],
];

const doneFixtures = doneCases.map(([id, dimension, state, reasonCode, obligationKind], index) => defineFixture({
  id,
  category: REPLAY_CATEGORIES.DONE_NOT_MERGED,
  scenario: 'EVALUATOR_OBLIGATION',
  source: historicalSource('done-not-merged', index + 1, doneIncidentSource, {
    occurrenceOrdinal: index + 1,
    normalizedFault: reasonCode,
  }),
  input: {
    from: 'TASK_DONE_CLAIM_WITHOUT_CURRENT_INTEGRATION_PROOF',
    event: 'TARGET_BOUND_CUT_EVALUATED', goalDisposition: 'ACHIEVED', taskStatusClaim: 'DONE',
    dimensionStates: { [dimension]: { state, reasonCode } },
  },
  expectedTransition: {
    from: 'TASK_DONE_CLAIM_WITHOUT_CURRENT_INTEGRATION_PROOF',
    event: 'TARGET_BOUND_CUT_EVALUATED', to: 'GOAL_ACTIVE_WITH_OBLIGATION', closed: false,
    obligationKind, reasonCode,
  },
  expectedFinalObligation: { kind: obligationKind, state: 'ACTIVE', owner: null, reasonCode },
}));

const visibilityCases = [
  ['history-read-gap-01-unmerged-not-announced', 'ARTIFACT_INTEGRATION', 'UNMERGED_WORK_NOT_ANNOUNCED', 'PROVE_ARTIFACT_INTEGRATION',
    '系统拥有 merge receipt、merge-base 和 merge evidence，却没有主动暴露该合未合。'],
  ['history-read-gap-02-inbox-done-gate-diverge', 'CRITERIA_EVALUATION', 'INBOX_DONE_GATE_DIVERGENCE', 'SATISFY_COMPLETION_DIMENSION',
    '收件箱说没有待办，doneGate 说仍有非 PASS 标准；两个读模型都没有对方的信息。'],
  ['history-read-gap-03-invalidated-run-hidden', 'BINDING_FRESHNESS', 'CONFIRMATION_INVALIDATED_RUN_HIDDEN', 'REFRESH_STALE_BINDING',
    '确认标准集废掉 acceptance run 后只显示已替代，未提示重开 run。'],
];

const visibilityFixtures = visibilityCases.map(([id, dimension, reasonCode, obligationKind, excerpt], index) => defineFixture({
  id,
  category: REPLAY_CATEGORIES.READ_MODEL_GAP,
  scenario: 'SURFACE_EVALUATOR',
  source: historicalSource('known-but-not-prompted', index + 1, excerpt),
  input: {
    from: 'KNOWN_GAP_HIDDEN', event: 'CANONICAL_PROJECTION_REBUILT',
    goalDisposition: 'ACTIVE', taskStatusClaim: 'OPEN',
    dimensionStates: { [dimension]: { state: 'UNKNOWN', reasonCode } },
  },
  expectedTransition: {
    from: 'KNOWN_GAP_HIDDEN', event: 'CANONICAL_PROJECTION_REBUILT',
    to: 'VISIBLE_ON_ALL_SIX_SURFACES', closed: false, obligationKind, reasonCode, surfaceCount: 6,
  },
  expectedFinalObligation: { kind: obligationKind, state: 'ACTIVE', owner: null, reasonCode },
}));

const safetyFixtures = [
  defineFixture({
    id: 'boundary-owner-credential-forgery', category: REPLAY_CATEGORIES.SAFETY_BOUNDARY,
    scenario: 'OWNER_CREDENTIAL_BOUNDARY',
    source: historicalSource('authority-boundary', 1,
      '执行会话曾在 apiserver 容器内铸造 owner JWT；HUMAN_ONLY 不能被宣称为真人在场证明。'),
    input: { from: 'AGENT_PRESENTS_MINTED_OWNER_CREDENTIAL', event: 'AUTHORITY_PROVENANCE_CHECKED' },
    expectedTransition: {
      from: 'AGENT_PRESENTS_MINTED_OWNER_CREDENTIAL', event: 'AUTHORITY_PROVENANCE_CHECKED',
      to: 'MUTATION_REFUSED', closed: false, obligationKind: 'REQUEST_NEW_AUTHORIZATION',
      reasonCode: 'OWNER_CREDENTIAL_PROVENANCE_UNTRUSTED',
    },
    expectedFinalObligation: { kind: 'REQUEST_NEW_AUTHORIZATION', state: 'ACTIVE', owner: 'OWNER', reasonCode: 'OWNER_CREDENTIAL_PROVENANCE_UNTRUSTED' },
  }),
  defineFixture({
    id: 'boundary-production-data-write', category: REPLAY_CATEGORIES.SAFETY_BOUNDARY,
    scenario: 'PRODUCTION_DATA_BOUNDARY',
    source: historicalSource('production-boundary', 1,
      '验收未限定测试项目时，执行会话在生产项目写入 11 条 INCONCLUSIVE；fixture 不得把验收文字当生产写授权。'),
    input: { from: 'ACCEPTANCE_FIXTURE_TARGETS_PRODUCTION', event: 'ENVIRONMENT_SCOPE_CHECKED' },
    expectedTransition: {
      from: 'ACCEPTANCE_FIXTURE_TARGETS_PRODUCTION', event: 'ENVIRONMENT_SCOPE_CHECKED',
      to: 'MUTATION_REFUSED', closed: false, obligationKind: 'REQUEST_RISK_ACCEPTANCE',
      reasonCode: 'PRODUCTION_TARGET_OUTSIDE_FIXTURE_AUTHORITY',
    },
    expectedFinalObligation: { kind: 'REQUEST_RISK_ACCEPTANCE', state: 'ACTIVE', owner: 'OWNER', reasonCode: 'PRODUCTION_TARGET_OUTSIDE_FIXTURE_AUTHORITY' },
  }),
  defineFixture({
    id: 'boundary-forged-fact-payload', category: REPLAY_CATEGORIES.SAFETY_BOUNDARY,
    scenario: 'FACT_FORGERY',
    source: repositorySource('scripts/lib/outcome-reconciler-v2.mjs', 'validateCanonicalFact',
      'payload digest and principal/binding provenance are checked before a claim may become proof'),
    input: { from: 'TAMPERED_FACT_PRESENTED', event: 'TRUST_ENVELOPE_VALIDATED' },
    expectedTransition: {
      from: 'TAMPERED_FACT_PRESENTED', event: 'TRUST_ENVELOPE_VALIDATED',
      to: 'FACT_REJECTED', closed: false, obligationKind: 'REPAIR_FACT_CUT',
      reasonCode: 'PAYLOAD_DIGEST_MISMATCH',
    },
    expectedFinalObligation: { kind: 'REPAIR_FACT_CUT', state: 'ACTIVE', owner: 'SYSTEM', reasonCode: 'PAYLOAD_DIGEST_MISMATCH' },
  }),
];

const propertyFixtures = [
  defineFixture({
    id: 'property-five-state-total-algebra', category: REPLAY_CATEGORIES.STATE_ALGEBRA,
    scenario: 'FIVE_STATE_ALGEBRA',
    source: repositorySource('contracts/outcome-reconciler-v2.contract.json', 'stateAlgebra',
      'five-state combine table is total and closure rejects UNKNOWN, UNSATISFIED and CONFLICT'),
    input: { from: 'FIVE_STATE_MATRIX_DECLARED', event: 'PROPERTY_MATRIX_ENUMERATED' },
    expectedTransition: {
      from: 'FIVE_STATE_MATRIX_DECLARED', event: 'PROPERTY_MATRIX_ENUMERATED',
      to: 'TOTAL_COMMUTATIVE_ASSOCIATIVE_IDEMPOTENT', closed: true,
      obligationKind: 'NONE', reasonCode: 'FIVE_STATE_PROPERTIES_HOLD', pairCount: 25, tripleCount: 125,
    },
    expectedFinalObligation: { kind: 'NONE', state: 'RESOLVED', owner: 'SYSTEM', reasonCode: 'FIVE_STATE_PROPERTIES_HOLD' },
  }),
  defineFixture({
    id: 'writer-fence-direct-done-refused', category: REPLAY_CATEGORIES.WRITER_FENCE,
    scenario: 'WRITER_FENCE',
    source: repositorySource('src/apiserver/prisma/migrations/0193_task_done_writer_fence/migration.sql', 'task_done_canonical_writer_fence',
      'a bare status=DONE update is refused without its declared completion fact'),
    input: { from: 'TASK_OPEN_NO_COMPLETION_FACT', event: 'LEGACY_WRITER_UPDATES_DONE' },
    expectedTransition: {
      from: 'TASK_OPEN_NO_COMPLETION_FACT', event: 'LEGACY_WRITER_UPDATES_DONE',
      to: 'WRITE_REFUSED_TASK_OPEN', closed: false,
      obligationKind: 'SATISFY_COMPLETION_DIMENSION', reasonCode: 'TASK_DONE_CANONICAL_FACT_REQUIRED',
    },
    expectedFinalObligation: { kind: 'SATISFY_COMPLETION_DIMENSION', state: 'ACTIVE', owner: 'AGENT', reasonCode: 'TASK_DONE_CANONICAL_FACT_REQUIRED' },
  }),
  defineFixture({
    id: 'mixed-client-v1-claim-only', category: REPLAY_CATEGORIES.MIXED_CLIENT,
    scenario: 'MIXED_CLIENT_V1',
    source: repositorySource('contracts/outcome-reconciler-v2.contract.json', 'compatibilityBoundary',
      'known V1 writes translate to claims and may not mint authority, ratify, write projections or direct DONE'),
    input: { from: 'V1_DIRECT_DONE_REQUESTED', event: 'MIXED_CLIENT_BOUNDARY_APPLIED' },
    expectedTransition: {
      from: 'V1_DIRECT_DONE_REQUESTED', event: 'MIXED_CLIENT_BOUNDARY_APPLIED',
      to: 'CLAIM_RECORDED_DIRECT_DONE_REFUSED', closed: false,
      obligationKind: 'SATISFY_COMPLETION_DIMENSION', reasonCode: 'LEGACY_DONE_IS_CLAIM_ONLY',
    },
    expectedFinalObligation: { kind: 'SATISFY_COMPLETION_DIMENSION', state: 'ACTIVE', owner: 'AGENT', reasonCode: 'LEGACY_DONE_IS_CLAIM_ONLY' },
  }),
  defineFixture({
    id: 'mixed-client-unknown-revision-refused', category: REPLAY_CATEGORIES.MIXED_CLIENT,
    scenario: 'MIXED_CLIENT_UNKNOWN',
    source: repositorySource('contracts/outcome-reconciler-v2.contract.json', 'unknownRevision',
      'unknown protocol revisions fail closed with a structured upgrade or rollback action'),
    input: { from: 'UNKNOWN_CLIENT_REVISION', event: 'MIXED_CLIENT_BOUNDARY_APPLIED' },
    expectedTransition: {
      from: 'UNKNOWN_CLIENT_REVISION', event: 'MIXED_CLIENT_BOUNDARY_APPLIED',
      to: 'WRITE_REFUSED_WITH_UPGRADE_ACTION', closed: false,
      obligationKind: 'DIAGNOSE_MODEL_GAP', reasonCode: 'UNKNOWN_PROTOCOL_REVISION',
    },
    expectedFinalObligation: { kind: 'DIAGNOSE_MODEL_GAP', state: 'ACTIVE', owner: 'AGENT', reasonCode: 'UNKNOWN_PROTOCOL_REVISION' },
  }),
  defineFixture({
    id: 'action-revoked-authority', category: REPLAY_CATEGORIES.ACTION_SAFETY,
    scenario: 'ACTION_REVOKED',
    source: repositorySource('src/apiserver/prisma/migrations/0196_outcome_constrained_action_executor/migration.sql', 'outcome_begin_action_commit',
      'authority and preconditions are rechecked at the commit fence'),
    input: { from: 'ACTION_INTENT_READY', event: 'AUTHORITY_REVOKED_BEFORE_COMMIT' },
    expectedTransition: {
      from: 'ACTION_INTENT_READY', event: 'AUTHORITY_REVOKED_BEFORE_COMMIT',
      to: 'ACTION_REFUSED', closed: false, obligationKind: 'REQUEST_NEW_AUTHORIZATION',
      reasonCode: 'AUTHORITY_REVOKED_AT_COMMIT',
    },
    expectedFinalObligation: { kind: 'REQUEST_NEW_AUTHORIZATION', state: 'ACTIVE', owner: 'OWNER', reasonCode: 'AUTHORITY_REVOKED_AT_COMMIT' },
  }),
  defineFixture({
    id: 'action-budget-exhausted', category: REPLAY_CATEGORIES.ACTION_SAFETY,
    scenario: 'ACTION_OVER_BUDGET',
    source: repositorySource('scripts/lib/outcome-reconciler-v2.mjs', 'validateActionSafetyEnvelope',
      'an action charge exceeding the bound budget fails closed'),
    input: { from: 'ACTION_INTENT_OVER_BUDGET', event: 'SAFETY_ENVELOPE_VALIDATED' },
    expectedTransition: {
      from: 'ACTION_INTENT_OVER_BUDGET', event: 'SAFETY_ENVELOPE_VALIDATED',
      to: 'ACTION_REFUSED', closed: false, obligationKind: 'REQUEST_RISK_ACCEPTANCE',
      reasonCode: 'ACTION_BUDGET_EXCEEDED',
    },
    expectedFinalObligation: { kind: 'REQUEST_RISK_ACCEPTANCE', state: 'ACTIVE', owner: 'OWNER', reasonCode: 'ACTION_BUDGET_EXCEEDED' },
  }),
  defineFixture({
    id: 'action-compensation-missing', category: REPLAY_CATEGORIES.ACTION_SAFETY,
    scenario: 'ACTION_NO_COMPENSATION',
    source: repositorySource('scripts/lib/outcome-reconciler-v2.mjs', 'validateActionSafetyEnvelope',
      'side effects require a compensator or explicit manual recovery path'),
    input: { from: 'SIDE_EFFECT_INTENT_NO_RECOVERY', event: 'SAFETY_ENVELOPE_VALIDATED' },
    expectedTransition: {
      from: 'SIDE_EFFECT_INTENT_NO_RECOVERY', event: 'SAFETY_ENVELOPE_VALIDATED',
      to: 'ACTION_REFUSED', closed: false, obligationKind: 'REMEDIATE_SIDE_EFFECT',
      reasonCode: 'COMPENSATION_OR_MANUAL_RECOVERY_REQUIRED',
    },
    expectedFinalObligation: { kind: 'REMEDIATE_SIDE_EFFECT', state: 'ACTIVE', owner: 'AGENT', reasonCode: 'COMPENSATION_OR_MANUAL_RECOVERY_REQUIRED' },
  }),
];

const concurrencyFixtures = [
  defineFixture({
    id: 'concurrency-idempotent-fact-ingress', category: REPLAY_CATEGORIES.CONCURRENCY,
    scenario: 'CONCURRENT_FACT_IDEMPOTENCY',
    source: repositorySource('src/apiserver/prisma/migrations/0194_outcome_canonical_fact_ingress/migration.sql', 'outcome_ingest_canonical_fact',
      'one idempotency key allocates one canonical fact under concurrent writers'),
    input: { from: 'EIGHT_CONCURRENT_IDENTICAL_FACT_WRITES', event: 'STREAM_LOCK_AND_IDEMPOTENCY_CHECK' },
    expectedTransition: {
      from: 'EIGHT_CONCURRENT_IDENTICAL_FACT_WRITES', event: 'STREAM_LOCK_AND_IDEMPOTENCY_CHECK',
      to: 'ONE_CANONICAL_FACT', closed: true, obligationKind: 'NONE', reasonCode: 'IDEMPOTENT_FACT_LINEARIZED', writerCount: 8, factCount: 1,
    },
    expectedFinalObligation: { kind: 'NONE', state: 'RESOLVED', owner: 'SYSTEM', reasonCode: 'IDEMPOTENT_FACT_LINEARIZED' },
  }),
  defineFixture({
    id: 'concurrency-cut-before-late-fact', category: REPLAY_CATEGORIES.CONCURRENCY,
    scenario: 'LINEARIZABLE_CUT',
    source: repositorySource('src/apiserver/prisma/migrations/0194_outcome_canonical_fact_ingress/migration.sql', 'outcome_seal_evaluation_cut',
      'a sealed cut holds the stream lock and excludes a fact that linearizes after the seal'),
    input: { from: 'CUT_AND_LATE_FACT_RACE', event: 'STREAM_LOCK_SERIALIZES_CUT_FIRST' },
    expectedTransition: {
      from: 'CUT_AND_LATE_FACT_RACE', event: 'STREAM_LOCK_SERIALIZES_CUT_FIRST',
      to: 'SEALED_CUT_EXCLUDES_LATE_FACT', closed: true, obligationKind: 'NONE', reasonCode: 'CUT_LINEARIZED_BEFORE_LATE_FACT', watermarkDelta: 1,
    },
    expectedFinalObligation: { kind: 'NONE', state: 'RESOLVED', owner: 'SYSTEM', reasonCode: 'CUT_LINEARIZED_BEFORE_LATE_FACT' },
  }),
  defineFixture({
    id: 'concurrency-single-active-successor', category: REPLAY_CATEGORIES.CONCURRENCY,
    scenario: 'SINGLE_SUCCESSOR',
    source: repositorySource('src/apiserver/prisma/migrations/0200_executable_acceptance_runtime_contract/migration.sql', 'task_dependency_tail_id',
      'successor identity is idempotent and dependency reads resolve through one current chain tail'),
    input: { from: 'TWELVE_CONCURRENT_SUCCESSOR_CLAIMS', event: 'IDEMPOTENCY_KEY_CONFLICT_RESOLVED' },
    expectedTransition: {
      from: 'TWELVE_CONCURRENT_SUCCESSOR_CLAIMS', event: 'IDEMPOTENCY_KEY_CONFLICT_RESOLVED',
      to: 'ONE_ACTIVE_SUCCESSOR', closed: true, obligationKind: 'NONE', reasonCode: 'SUCCESSOR_IDENTITY_LINEARIZED', claimantCount: 12, successorCount: 1,
    },
    expectedFinalObligation: { kind: 'NONE', state: 'RESOLVED', owner: 'SYSTEM', reasonCode: 'SUCCESSOR_IDENTITY_LINEARIZED' },
  }),
];

const timeoutSource = historicalSource('watchdog-timeout-race', 1,
  '真实 Watchdog 验收 requested timeout=1200 秒与 legacy runner hardMax=120 秒竞争；旧任务 FAILED、系统记录 exit=-1，后继任务接管。', {
    legacyTaskId: '34Elz5t7HAZZRf6ruE73y',
    legacySessionId: '3RIgJAt2GsNCTVoKKfOvK',
    successorTaskId: '34Ex0SFCY6DpfvW2I4ydE',
    replayTaskId: '34EVtJuwMDJkbocbCPllX',
    canaryTaskId: '34EVtJyRwtCxw0Dv9yE6N',
  });

const timeoutFixtures = [
  defineFixture({
    id: 'timeout-v2-rejects-1200-on-hardmax-120', category: REPLAY_CATEGORIES.TIMEOUT_RACE,
    scenario: 'TIMEOUT_REJECT', source: timeoutSource,
    requestedDeadlineSeconds: 1200,
    input: { from: 'ADMISSION_REQUESTED', event: 'NEGOTIATE_WITH_LEGACY_HARDMAX_120' },
    expectedTransition: {
      from: 'ADMISSION_REQUESTED', event: 'NEGOTIATE_WITH_LEGACY_HARDMAX_120',
      to: 'ADMISSION_REJECTED', closed: false, obligationKind: 'DIAGNOSE_MODEL_GAP',
      reasonCode: 'RUNNER_HARD_MAX_INSUFFICIENT', spawnCount: 0,
    },
    expectedFinalObligation: { kind: 'DIAGNOSE_MODEL_GAP', state: 'ACTIVE', owner: 'AGENT', reasonCode: 'RUNNER_HARD_MAX_INSUFFICIENT' },
  }),
  defineFixture({
    id: 'timeout-v2-admits-exact-1200', category: REPLAY_CATEGORIES.TIMEOUT_RACE,
    scenario: 'TIMEOUT_ADMIT', source: timeoutSource,
    requestedDeadlineSeconds: 1200, effectiveDeadlineSeconds: 1200,
    input: { from: 'SUCCESSOR_ADMISSION_REQUESTED', event: 'NEGOTIATE_WITH_HARDMAX_1200' },
    expectedTransition: {
      from: 'SUCCESSOR_ADMISSION_REQUESTED', event: 'NEGOTIATE_WITH_HARDMAX_1200',
      to: 'ADMITTED_WITH_EXACT_DEADLINE', closed: true, obligationKind: 'NONE',
      reasonCode: 'REQUESTED_EQUALS_EFFECTIVE_DEADLINE', spawnCount: 0,
    },
    expectedFinalObligation: { kind: 'NONE', state: 'RESOLVED', owner: 'SYSTEM', reasonCode: 'REQUESTED_EQUALS_EFFECTIVE_DEADLINE' },
  }),
  defineFixture({
    id: 'goal-attempt-typed-timeout-continuation', category: REPLAY_CATEGORIES.GOAL_ATTEMPT,
    scenario: 'TYPED_TIMEOUT_CONTINUATION', source: timeoutSource,
    requestedDeadlineSeconds: 1200, effectiveDeadlineSeconds: 120,
    terminationKind: 'TIMED_OUT',
    input: { from: 'LEGACY_UNTYPED_EXIT_MINUS_ONE', event: 'DEADLINE_EVIDENCE_REPLAYED' },
    expectedTransition: {
      from: 'LEGACY_UNTYPED_EXIT_MINUS_ONE', event: 'DEADLINE_EVIDENCE_REPLAYED',
      to: 'GOAL_ACTIVE_WITH_SUCCESSOR_OBLIGATION', closed: false,
      obligationKind: 'START_SUCCESSOR_ATTEMPT', reasonCode: 'ATTEMPT_TIMED_OUT_GOAL_ACTIVE',
      terminationKind: 'TIMED_OUT',
    },
    expectedFinalObligation: { kind: 'START_SUCCESSOR_ATTEMPT', state: 'ACTIVE', owner: 'AGENT', reasonCode: 'ATTEMPT_TIMED_OUT_GOAL_ACTIVE' },
  }),
  defineFixture({
    id: 'timeout-legacy-reconstruction-successor-recovery', category: REPLAY_CATEGORIES.TIMEOUT_RACE,
    scenario: 'LEGACY_TIMEOUT_SUCCESSOR_RECOVERY', source: timeoutSource,
    requestedDeadlineSeconds: 1200, effectiveDeadlineSeconds: 120,
    terminationKind: 'TIMED_OUT',
    input: { from: 'FAILED_UNTYPED_EXIT_MINUS_ONE', event: 'AUDIT_PRESERVING_REPLAY_AND_SUCCESSOR_TAKEOVER' },
    expectedTransition: {
      from: 'FAILED_UNTYPED_EXIT_MINUS_ONE', event: 'AUDIT_PRESERVING_REPLAY_AND_SUCCESSOR_TAKEOVER',
      to: 'SUCCESSOR_OWNS_GOAL_AND_DOWNSTREAM_READY', closed: true,
      obligationKind: 'NONE', reasonCode: 'SUCCESSOR_COMPLETED_DOWNSTREAM_RECOVERED',
      terminationKind: 'TIMED_OUT', legacyAuditPreserved: true,
      successorCount: 1, downstreamState: 'READY',
    },
    expectedFinalObligation: { kind: 'NONE', state: 'RESOLVED', owner: 'SYSTEM', reasonCode: 'SUCCESSOR_COMPLETED_DOWNSTREAM_RECOVERED' },
  }),
];

export const REPLAY_FIXTURES = Object.freeze([
  ...entryFixtures,
  ...doneFixtures,
  ...visibilityFixtures,
  ...safetyFixtures,
  ...propertyFixtures,
  ...concurrencyFixtures,
  ...timeoutFixtures,
]);

export function replayFixtureById(id) {
  const fixture = REPLAY_FIXTURES.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`unknown replay fixture: ${id}`);
  return fixture;
}
