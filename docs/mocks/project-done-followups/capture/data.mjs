const T = '/root/.orbit/worktrees/67abea98-cec7-5593-80f0-8a0ef57346a7';
const { FIXTURE_IDS, FIXED_NOW } = await import(`${T}/src/web/ui-migration/fixtures.mjs`);
const { uuidToBase62 } = await import(`${T}/src/shared/dist/index.js`);
export const id = (s) => uuidToBase62(`0196e000-0000-7000-8000-${s.padStart(12, '0')}`);
export const PID = FIXTURE_IDS.project;
const at = (d) => d;
const task = (n, title, status, extra = {}) => ({ taskId: id(String(900 + n)), title, status, completionCriterion: 'OWNER_CONFIRMED', requiredAction: 'HAVE_THE_ACCOUNT_OWNER_CONFIRM_IN_THE_APP', criterionRevision: 1, criterionRevisionStale: false, ...extra });
export function criteria(kind) {
  const base = [
    { ordinal: 1, text: 'Phase 0 design documents are written and reviewed (placeholder text).', satisfied: true },
    { ordinal: 2, text: 'The content pipeline runs end to end on the staging account (91 tasks).', satisfied: true },
    { ordinal: 3, text: 'Operators can review and publish a generated asset (2 tasks).', satisfied: true },
    { ordinal: 4, text: 'External prerequisites settled: SMS provider, WeChat Open Platform app, payment merchant, ICP filing.', satisfied: false,
      unmet: [{ clause: 'SERVING_WORK_UNSETTLED', heldUpBy: [task(4, 'Settle external prerequisites (SMS, WeChat, payment, ICP)', 'OPEN')] }] },
  ];
  return base.map((c) => ({ id: id(String(600 + c.ordinal)), key: `c${c.ordinal}`, revision: 1, landing: 'UNKNOWN',
    verificationMethod: c.ordinal === 4 ? 'Check each item on its provider console: SMS template approved, WeChat app approved, merchant number active, ICP number on the MIIT site.' : 'Read the task evidence.',
    independence: 'INDEPENDENT', conflicts: [], remedy: null, unmet: c.unmet ?? [], ...c }));
}
export function project(over = {}) {
  return { id: PID, title: 'CBAI AI 视觉内容平台 Phase 0 实施', status: 'OPEN',
    goal: 'Stand up Phase 0 of the AI visual content platform: design, pipeline on staging, operator review, and the external accounts it needs.',
    instructions: 'Work runs in shared isolation; documents live in the team drive.',
    acceptanceCriteriaItems: criteria(), createdAt: '2026-10-20T02:00:00Z', updatedAt: FIXED_NOW, lastActivityAt: FIXED_NOW,
    _count: { tasks: 155 }, tasksByStatus: { OPEN: 1, DONE: 154 },
    buckets: { running: 0, ready: 0, blocked: 0, awaitingVerification: 0, done: 154, failed: 0, cancelled: 0 },
    attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null },
    coordinatorEnabled: true, maxConcurrentTasks: 3, configRevision: '4', startedAt: '2026-10-20T02:10:00Z', pausedAt: null,
    blockers: { open: [], resolved: [], resolvedCount: 0 }, acceptedGaps: [], ...over };
}
export const integration = {
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: `project/${PID}`, upstreamRef: 'main', source: 'EXPLICIT',
  locked: false, startedAt: null, mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED',
  mergeCheckTimeoutSeconds: null, escalationSeconds: 7200, commitsAheadOfUpstream: null, deliveryMode: 'PLATFORM',
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET', lastUpstreamSyncAt: null, upstreamChosenAt: '2026-10-20T02:10:00Z',
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED', integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'UNKNOWN', inFlight: null,
  landingCheckCommand: null, landingCheckCommandAbsentReason: 'FALLS_BACK_TO_MERGE_CHECK',
  lastMainBranch: { branch: 'main', repository: 'example/cbai', chosenAt: '2026-10-20T02:10:00Z' },
};
export function confirmCriteria() {
  const rows = [
    ['Phase 0 design documents are written and reviewed.', true],
    ['The content pipeline runs end to end on the staging account.', true],
    ['SMS provider is live: the verification template is approved.', false],
    ['WeChat Open Platform app is approved.', false],
    ['Payment merchant account is active.', false],
    ['ICP filing is approved for cbai.example.cn.', false],
    ['The production domain resolves to the ingress.', false],
    ['The privacy policy is published at /privacy and names the SMS vendor.', false],
  ];
  return rows.map(([text, satisfied], i) => ({ id: id(String(650 + i)), key: `k${i}`, ordinal: i + 1, revision: i === 7 ? 2 : 1, text, satisfied, landing: 'UNKNOWN',
    verificationMethod: 'Check the provider console.', independence: 'INDEPENDENT', conflicts: [], remedy: null, unmet: [] }));
}
