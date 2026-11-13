import { createHash, randomUUID } from 'node:crypto';

/**
 * The tenant isolation census (docs/google-sign-in-design.md §5.6, §11 T1). Orbit keeps accounts
 * apart by `ownerId` and nothing else; once sign-up is open, a stranger shares the deployment with
 * everybody else, and a route that reads or writes another account's object by its id is a leak.
 *
 * Every route behind JwtAuthGuard whose path names something — `:id`, `:taskId`, `:userCode`, every
 * path parameter — is listed here exactly once: as a case, which `tenant-isolation.pg.spec.ts` sends
 * to the production apiserver over a real PostgreSQL, or in TENANT_ISOLATION_BY_HAND with why it
 * cannot be stood up there and the reading that proves it instead. So is every id a request carries
 * in its body or query (TENANT_ISOLATION_FIELD_CASES, below). `tenant-isolation-census.spec.ts` holds
 * both lists to the routes the app mounts, both ways: a route added with a path parameter, or an id
 * added to a request, with no line here is red in the merge check.
 *
 * What a case is held to, there: two accounts each hold a full set of objects (`Tenant`). B sends the
 * request on A's objects and is answered 404 or 403, and the database records no write at all while
 * it is answered. A then sends the very same request and is NOT answered 401, 403 or 404 — so B's
 * refusal is the account's doing, not a path, a body or a state that refuses everybody. A route whose
 * path names one object under another (`nested`) is sent once more on B's own parent with A's child
 * in it — B's session, A's approval — the shape a check on the parent alone lets through. That one is
 * B's own request, so it may be answered as one (removing a dependency B's task does not have is a
 * 200 that removes nothing); what it must be is answered exactly as the same request with an id that
 * names nothing is, and write nothing that names anything of A's.
 */

/** One account's objects, as a case names them. Each is that account's own, made for the census. */
export interface Tenant {
  userId: string;
  runnerId: string;
  /** Accounts on the runner (its `engines` snapshot), as the account routes address them. */
  runnerAccount: { engine: string; account: string };
  codexAccount: string;
  codexResetOperationId: string;
  /** A device enrollment this account approved. */
  deviceUserCode: string;
  /** An `orbit login` request this account approved. */
  cliLoginUserCode: string;
  /** A phone registered for the account's pushes: its token, and the key its registration answered. */
  deviceToken: string;
  deviceRegistrationId: string;
  workspaceId: string;
  /** Two permission rules of the workspace: the census reaches it under /agents and /workspaces. */
  agentRuleId: string;
  workspaceRuleId: string;
  sessionId: string;
  /** A LANDING session of the account's project, with its landing subject: the address a landing
   *  page and its check log are read through (`GET /sessions/:id/landing/log`). */
  landingSessionId: string;
  /** A session of the account working on `evidenceTaskId`, which its evidence names as its source. */
  evidenceSessionId: string;
  approvalId: string;
  /** A queued turn of the session. */
  turnId: string;
  /** An event of the session's transcript: its id, which a page around it names, and its seq. */
  eventId: string;
  eventSeq: number;
  sessionRequestId: string;
  folderId: string;
  tagId: string;
  attachmentId: string;
  taskId: string;
  commentId: string;
  /** A task of the project, judged on evidence, with one revision of evidence submitted. */
  evidenceTaskId: string;
  /** A comment on `evidenceTaskId`, which a legacy import names as its source. */
  evidenceCommentId: string;
  /** The task `taskId` depends on. */
  dependencyTaskId: string;
  listId: string;
  listRevision: number;
  projectId: string;
  /** A task in the project. */
  projectTaskId: string;
  /** An attempt at that task, opened by a session of the account. */
  attemptId: string;
  /** The project's one acceptance criterion, which an edit of the criteria names to keep it. */
  projectCriterionId: string;
  openItemId: string;
  doneRequestItemId: string;
  blockerId: string;
  fuseEpisodeId: string;
  handoffId: string;
  promotionId: string;
  /** A queued landing of `projectTaskId`. */
  integrationJobId: string;
  criteriaIntentId: string;
  /** The token that binds a decision to that proposal — what the owner's card answers it with. */
  criteriaCommitToken: string;
  providerId: string;
  poolId: string;
  /** A provider of the account's that is a member of the pool. */
  poolMemberId: string;
  /** A pool of the ChatGPT-login kind, which the codex-login routes address. */
  codexPoolId: string;
  sharedPoolId: string;
  /** Somebody else's shared pool the account is a member of — the one it can leave. */
  joinedSharedPoolId: string;
  /** An account that exists and is in none of the account's pools, to be added to one. */
  inviteeEmail: string;
  sharedPoolKeyId: string;
  /** Somebody else in the shared pool (neither A nor B). */
  sharedPoolPersonId: string;
  watchId: string;
  watchDeliveryId: string;
  wikiSpaceId: string;
  wikiEntryId: string;
  wikiChangesetId: string;
  /** The one op of that changeset, which a decision names. */
  wikiChangesetOpId: string;
  wikiPlanProposalId: string;
  wikiPlanVersion: number;
  wikiArticleSlug: string;
  wikiArticlePart: number;
  wikiDocSlug: string;
  /** The census document's one section, and the version a rewrite of it kept (`docs.versions`). */
  wikiDocSectionKey: string;
  wikiDocVersionId: string;
  /** A wiki chat of the space (a session with `wiki_chat_space_id`), and a rewrite card its agent drafted. */
  wikiChatId: string;
  wikiChatDraftId: string;
  /**
   * An applied plan card of the same chat (C17), whose press made a version the plan has since moved past: its Undo and
   * Try again read the plan and its builds past the card, so they are sent with this card.
   */
  wikiPlanCardId: string;
  wikiTopicSlug: string;
  /** A Feishu group connected to the account's app (docs/feishu-bot-design.md §8.1). */
  feishuChatRouteId: string;
  /** Another account, invited to reply in `sessionId` (docs/session-guests-design.md): its email, as the owner invites it. */
  guestEmail: string;
  /** For /admin/*: a user an administrator acts on (with a profile photo), one of its tokens, a global provider. */
  adminSubjectId: string;
  adminSubjectTokenId: string;
  adminProviderId: string;
  /** Objects a destructive route takes away, one each, so that no other case loses its own. */
  spare: {
    accessTokenId: string;
    adminProviderId: string;
    adminSubjectId: string;
    agentId: string;
    workspaceId: string;
    attachmentId: string;
    projectId: string;
    providerId: string;
    poolId: string;
    sharedPoolId: string;
    runnerId: string;
    folderId: string;
    sessionId: string;
    purgedSessionId: string;
    /** A wiki of the owner's in Trash, which the permanent delete takes (contract `space.trash.purge`). */
    trashedWikiSpaceId: string;
    tagId: string;
    shareLinkId: string;
    feishuChatRouteId: string;
    /** A second guest of `sessionId`, whom the owner's remove takes out. */
    guestUserId: string;
    listId: string;
    taskId: string;
  };
}

export interface TenantRequest {
  /** Every path parameter of the route. */
  params: Record<string, string | number>;
  query?: Record<string, string>;
  /** Headers that carry ids — the session-context ones (common/public-id-headers.ts) — beside the credential's. */
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent as the one file of a multipart/form-data body, instead of a JSON one. */
  file?: { name: string; type: string; content: string };
  /** The text parts sent beside that file. */
  fields?: Record<string, string>;
}

export interface TenantCase {
  /**
   * The request, on `of`'s objects. Where its body names somewhere to put something, it names the
   * caller's own (`mine`): B moving A's session into B's workspace, not into A's.
   */
  request: (of: Tenant, mine: Tenant) => TenantRequest;
  /** Path params naming something that lives under another param of the same path. */
  nested?: readonly string[];
}

/** The path parameters a route template names: `GET /tasks/:id/comments/:commentId` → id, commentId. */
export const paramsOf = (route: string): string[] => [...route.matchAll(/:(\w+)/g)].map((m) => m[1]);

const workspaceRoutes = (prefix: 'agents' | 'workspaces', ruleOf: (t: Tenant) => string, spareOf: (t: Tenant) => string) => ({
  [`GET /${prefix}/:id`]: { request: (of: Tenant) => ({ params: { id: of.workspaceId } }) },
  [`PATCH /${prefix}/:id`]: {
    request: (of: Tenant, mine: Tenant) => ({ params: { id: of.workspaceId }, body: { description: 'renamed by the census', runnerId: mine.runnerId } }),
  },
  [`DELETE /${prefix}/:id`]: { request: (of: Tenant) => ({ params: { id: spareOf(of) } }) },
  [`GET /${prefix}/:id/permission-rules`]: { request: (of: Tenant) => ({ params: { id: of.workspaceId } }) },
  [`DELETE /${prefix}/:id/permission-rules/:ruleId`]: {
    request: (of: Tenant) => ({ params: { id: of.workspaceId, ruleId: ruleOf(of) } }),
    nested: ['ruleId'],
  },
  [`POST /${prefix}/:id/repo-cleanup`]: { request: (of: Tenant) => ({ params: { id: of.workspaceId }, body: {} }) },
}) satisfies Record<string, TenantCase>;

/** A message for a session, under a client turn id of its own: a replayed one would be answered as a replay. */
const turn = (content: string) => ({ clientTurnId: `census-${content}-${randomUUID()}`, content });
/** A wiki chat's opening turn key: a UUID, as the chat's create takes nothing else (contract `chat.create`). */
const CENSUS_CHAT_TURN = randomUUID();

/**
 * A dependency graph branch cursor, minted the way the server mints one for `ownerId` (tasks.service
 * `encodeDependencyGraphBranchCursor`) — which a caller can do for itself, so B's names A's task.
 */
const graphCursor = (ownerId: string, focusTaskId: string, anchorTaskId = focusTaskId) =>
  Buffer.from(JSON.stringify({
    version: 1,
    ownerScope: createHash('sha256').update(`dependency-graph-owner:${ownerId}`).digest('base64url'),
    focusTaskId,
    anchorTaskId,
    direction: 'prerequisites',
  })).toString('base64url');

/** A completion-evidence envelope, as a run submits one. */
export const evidence = (claim: string) => ({
  claim,
  criterion: { key: 'census', text: 'the census holds' },
  checks: [{ kind: 'ARTIFACT', ref: 'census' }],
  gaps: [],
});

export const TENANT_ISOLATION_CASES: Readonly<Record<string, TenantCase>> = {
  // ── access tokens, and `orbit login` asking for one ─────────────────────────────────────────────
  'DELETE /access-tokens/:id': { request: (of) => ({ params: { id: of.spare.accessTokenId } }) },
  'GET /access-tokens/device/:userCode': { request: (of) => ({ params: { userCode: of.cliLoginUserCode } }) },
  'POST /access-tokens/device/:userCode/approve': { request: (of) => ({ params: { userCode: of.cliLoginUserCode } }) },
  'POST /access-tokens/device/:userCode/deny': { request: (of) => ({ params: { userCode: of.cliLoginUserCode } }) },

  // ── admin/*: an administrator acts on other accounts by design; a member is refused ─────────────
  'GET /admin/users/:id/access-tokens': { request: (of) => ({ params: { id: of.adminSubjectId } }) },
  // The subject has a profile photo: the administrator is answered its bytes.
  'GET /admin/users/:id/avatar': { request: (of) => ({ params: { id: of.adminSubjectId } }) },
  // Before the role and disabled cases below: the subject is still an enabled member, whom an administrator may view.
  'POST /admin/users/:id/impersonate': { request: (of) => ({ params: { id: of.adminSubjectId }, body: { reason: 'the census' } }) },
  'DELETE /admin/users/:id/access-tokens/:tokenId': {
    request: (of) => ({ params: { id: of.adminSubjectId, tokenId: of.adminSubjectTokenId } }),
  },
  'DELETE /admin/users/:id': { request: (of) => ({ params: { id: of.spare.adminSubjectId } }) },
  'PATCH /admin/users/:id/role': { request: (of) => ({ params: { id: of.adminSubjectId }, body: { role: 'ADMIN' } }) },
  // The subject is enabled, and an administrator besides it is too: the administrator disables it.
  'PATCH /admin/users/:id/disabled': { request: (of) => ({ params: { id: of.adminSubjectId }, body: { disabled: true } }) },
  // The subject has no Google account linked: the administrator is answered its sign-in methods as they are.
  'DELETE /admin/users/:id/identities/google': { request: (of) => ({ params: { id: of.adminSubjectId } }) },
  // The subject has no Feishu app connected: the administrator is answered that there was none to remove.
  'DELETE /admin/users/:id/feishu': { request: (of) => ({ params: { id: of.adminSubjectId } }) },
  // Outgoing email is not configured in the fixture: the administrator is answered 409 EMAIL_NOT_CONFIGURED, nothing written.
  'POST /admin/users/:id/welcome-email': { request: (of) => ({ params: { id: of.adminSubjectId } }) },
  // A Feishu group the account connected (§8.1): changed, and the spare one removed.
  'PATCH /integrations/feishu/chats/:id': { request: (of) => ({ params: { id: of.feishuChatRouteId }, body: { maxConcurrentSessions: 3 } }) },
  'DELETE /integrations/feishu/chats/:id': { request: (of) => ({ params: { id: of.spare.feishuChatRouteId } }) },
  'PATCH /admin/providers/:id': { request: (of) => ({ params: { id: of.adminProviderId }, body: { label: 'renamed by the census' } }) },
  // The wiki's support routes (contract `plan.jobs.rebuild.support`): the member's spaces read, and the administrator's
  // own space's build asked for — answered WIKI_RUNNER_EXECUTES under the census's default executor, and refused 403
  // to a member either way.
  'GET /admin/wiki/users/:id/spaces': { request: (of) => ({ params: { id: of.adminSubjectId } }) },
  'POST /admin/wiki/spaces/:id/plan/build': { request: (of) => ({ params: { id: of.wikiSpaceId }, body: { reason: 'the census' } }) },
  'DELETE /admin/providers/:id': { request: (of) => ({ params: { id: of.spare.adminProviderId } }) },

  // ── workspaces, under both of their names ────────────────────────────────────────────────────
  ...workspaceRoutes('agents', (t) => t.agentRuleId, (t) => t.spare.agentId),
  ...workspaceRoutes('workspaces', (t) => t.workspaceRuleId, (t) => t.spare.workspaceId),

  // ── attachments ──────────────────────────────────────────────────────────────────────────────
  'GET /attachments/:id': { request: (of) => ({ params: { id: of.attachmentId } }) },
  'DELETE /attachments/:id': { request: (of) => ({ params: { id: of.spare.attachmentId } }) },
  'PUT /attachments/:id/pin': { request: (of) => ({ params: { id: of.spare.attachmentId } }) },
  'DELETE /attachments/:id/pin': { request: (of) => ({ params: { id: of.spare.attachmentId } }) },

  // ── projects ─────────────────────────────────────────────────────────────────────────────────
  'GET /projects/:id': { request: (of) => ({ params: { id: of.projectId } }) },
  'PATCH /projects/:id': { request: (of) => ({ params: { id: of.projectId }, body: { title: 'renamed by the census' } }) },
  'DELETE /projects/:id': { request: (of) => ({ params: { id: of.spare.projectId } }) },
  'GET /projects/:id/panorama': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/panorama/blocking': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/panorama/ready': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/tasks/page': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/dependency-graph': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/tasks/:taskId/attempts': {
    request: (of) => ({ params: { id: of.projectId, taskId: of.projectTaskId } }),
    nested: ['taskId'],
  },
  'GET /projects/:id/tasks/:taskId/checkpoints': {
    request: (of) => ({ params: { id: of.projectId, taskId: of.projectTaskId } }),
    nested: ['taskId'],
  },
  'POST /projects/:id/tasks/:taskId/checkpoints': {
    request: (of) => ({
      params: { id: of.projectId, taskId: of.projectTaskId },
      body: {
        branch: 'census',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        baseSha: 'c'.repeat(40),
        scopeRevision: 1,
      },
    }),
    nested: ['taskId'],
  },
  'POST /projects/:id/tasks/:taskId/integration/retry': {
    request: (of) => ({ params: { id: of.projectId, taskId: of.projectTaskId }, body: { reason: 'the census' } }),
    nested: ['taskId'],
  },
  'POST /projects/:id/tasks/:taskId/integration/skip-merge-check': {
    request: (of) => ({ params: { id: of.projectId, taskId: of.projectTaskId }, body: { reason: 'the census' } }),
    nested: ['taskId'],
  },
  'GET /projects/:id/handoffs': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/handoffs/:handoffId/decision': {
    request: (of) => ({ params: { id: of.projectId, handoffId: of.handoffId }, body: { decision: 'DENY' } }),
    nested: ['handoffId'],
  },
  'POST /projects/:id/acceptance/merge-evidence': {
    request: (of) => ({
      params: { id: of.projectId },
      body: { requirementId: 'census', targetBranch: 'main', contentHash: 'd'.repeat(64) },
    }),
  },
  'GET /projects/:id/acceptance/confirmation': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/acceptance/confirmation': {
    request: (of) => ({ params: { id: of.projectId }, body: { criteriaDigest: 'e'.repeat(64) } }),
  },
  'POST /projects/:id/start': {
    request: (of) => ({
      params: { id: of.projectId },
      body: { criteriaDigest: 'e'.repeat(64), line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null },
    }),
  },
  'GET /projects/:id/done-check': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/done': {
    request: (of) => ({ params: { id: of.projectId }, body: { criteriaDigest: 'e'.repeat(64), acceptedGaps: [] } }),
  },
  'POST /projects/:id/pause': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/resume': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/criteria/:criterionKey/move': {
    request: (of) => ({
      params: { id: of.projectId, criterionKey: of.projectCriterionId },
      body: { newProject: { title: 'census follow-up' } },
    }),
  },
  'POST /projects/:id/sessions/complete': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/acceptance/criteria-decisions/pending': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/acceptance/criteria-decisions/:intentId': {
    request: (of) => ({
      params: { id: of.projectId, intentId: of.criteriaIntentId },
      body: { commitToken: of.criteriaCommitToken, decision: 'REJECT', baseSeal: '0'.repeat(64) },
    }),
    nested: ['intentId'],
  },
  'GET /projects/:id/open-items': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/fuse/:episodeId/resume': {
    request: (of) => ({ params: { id: of.projectId, episodeId: of.fuseEpisodeId }, body: {} }),
    nested: ['episodeId'],
  },
  'POST /projects/:id/open-items/:itemId/answer': {
    request: (of) => ({ params: { id: of.projectId, itemId: of.openItemId }, body: { text: 'the census' } }),
    nested: ['itemId'],
  },
  'POST /projects/:id/open-items/:itemId/return-to-coordinator': {
    request: (of) => ({ params: { id: of.projectId, itemId: of.openItemId } }),
    nested: ['itemId'],
  },
  'POST /projects/:id/open-items/:itemId/resolve': {
    request: (of) => ({ params: { id: of.projectId, itemId: of.openItemId }, body: { note: 'the census' } }),
    nested: ['itemId'],
  },
  // The fixture's item is a question, which Accept does not answer: the owner is told 409, which is
  // the door answering — another account's request finds no item at all.
  'POST /projects/:id/open-items/:itemId/accept': {
    request: (of) => ({ params: { id: of.projectId, itemId: of.openItemId } }),
    nested: ['itemId'],
  },
  'POST /projects/:id/done-requests/:itemId/decline': {
    request: (of) => ({ params: { id: of.projectId, itemId: of.doneRequestItemId }, body: { note: 'not yet' } }),
    nested: ['itemId'],
  },
  'POST /projects/:id/blockers/:blockerId/resolve': {
    request: (of) => ({ params: { id: of.projectId, blockerId: of.blockerId }, body: { reason: 'the census' } }),
    nested: ['blockerId'],
  },
  'GET /projects/:id/integration': { request: (of) => ({ params: { id: of.projectId } }) },
  'PATCH /projects/:id/integration': {
    request: (of) => ({ params: { id: of.projectId }, body: { exceptionEscalationSeconds: 900 } }),
  },
  'POST /projects/:id/coordinator': { request: (of, mine) => ({ params: { id: of.projectId }, body: { workspaceId: mine.workspaceId } }) },
  'POST /projects/:id/coordinator/replace': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/coordinator/status': { request: (of) => ({ params: { id: of.projectId } }) },
  'GET /projects/:id/pending-addressees': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/coordinator/rebind': {
    request: (of, mine) => ({ params: { id: of.projectId }, body: { workspaceId: mine.workspaceId } }),
  },
  'GET /projects/:id/share': { request: (of) => ({ params: { id: of.projectId } }) },
  'PUT /projects/:id/share': { request: (of) => ({ params: { id: of.projectId }, body: {} }) },
  'DELETE /projects/:id/share': { request: (of) => ({ params: { id: of.projectId } }) },
  'POST /projects/:id/integration/jobs/:jobId/retry': {
    request: (of) => ({ params: { id: of.projectId, jobId: of.integrationJobId } }),
    nested: ['jobId'],
  },
  // The owner's abandon (J-T10) and stop (J-T8) doors. Another account's project is a 404; on the
  // owner's own project the abandon names a QUEUED job (answered "not running") and the stop names
  // the task whose queued landing that job is (answered by the stop itself), so neither is refused
  // as an id that names nothing.
  'POST /projects/:id/integration/jobs/:jobId/abandon': {
    request: (of) => ({ params: { id: of.projectId, jobId: of.integrationJobId } }),
    nested: ['jobId'],
  },
  'POST /projects/:id/tasks/:taskId/integration/stop': {
    request: (of) => ({ params: { id: of.projectId, taskId: of.projectTaskId } }),
    nested: ['taskId'],
  },
  // §10.8's "look again", the owner's door: another account's project is a 404; on the owner's own
  // project an observation is queued.
  'POST /projects/:id/integration/observe': {
    request: (of) => ({ params: { id: of.projectId }, body: { reason: 'the census' } }),
  },
  'POST /projects/:id/promotions/:promotionId/integration/retry': {
    request: (of) => ({ params: { id: of.projectId, promotionId: of.promotionId }, body: { reason: 'the census' } }),
    nested: ['promotionId'],
  },
  'GET /projects/:projectId/promotions/current': { request: (of) => ({ params: { projectId: of.projectId } }) },
  'GET /projects/:projectId/promotions/merged': { request: (of) => ({ params: { projectId: of.projectId } }) },
  'POST /projects/:projectId/promotions/:promotionId/confirm': {
    request: (of) => ({ params: { projectId: of.projectId, promotionId: of.promotionId }, body: {} }),
    nested: ['promotionId'],
  },
  'POST /projects/:projectId/promotions/:promotionId/decline': {
    request: (of) => ({ params: { projectId: of.projectId, promotionId: of.promotionId } }),
    nested: ['promotionId'],
  },
  'POST /projects/:projectId/promotions/:promotionId/cancel': {
    request: (of) => ({ params: { projectId: of.projectId, promotionId: of.promotionId } }),
    nested: ['promotionId'],
  },

  // ── providers: the account's own, its pools, and the pools it shares with others ───────────────
  'GET /providers/mine/:id/key': { request: (of) => ({ params: { id: of.providerId } }) },
  'GET /providers/mine/:id/balance': { request: (of) => ({ params: { id: of.providerId } }) },
  'GET /providers/mine/:id/usage': { request: (of) => ({ params: { id: of.providerId } }) },
  // The account's own key is no Cursor key: it is answered that, which no key of anybody else's is.
  'POST /providers/mine/:id/key-check': { request: (of) => ({ params: { id: of.providerId } }) },
  'PATCH /providers/mine/:id': { request: (of) => ({ params: { id: of.providerId }, body: { label: 'renamed by the census' } }) },
  'DELETE /providers/mine/:id': { request: (of) => ({ params: { id: of.spare.providerId } }) },
  'GET /providers/pools/:id': { request: (of) => ({ params: { id: of.poolId } }) },
  'DELETE /providers/pools/:id': { request: (of) => ({ params: { id: of.spare.poolId } }) },
  'POST /providers/pools/:id/members': {
    request: (of, mine) => ({ params: { id: of.poolId }, body: { providerId: mine.providerId } }),
  },
  'DELETE /providers/pools/:id/members/:providerId': {
    request: (of) => ({ params: { id: of.poolId, providerId: of.poolMemberId } }),
    nested: ['providerId'],
  },
  'POST /providers/pools/:id/members/:memberId/pause': {
    request: (of) => ({ params: { id: of.poolId, memberId: of.poolMemberId }, body: { durationMinutes: 30 } }),
    nested: ['memberId'],
  },
  'GET /providers/pools/:id/codex-login': { request: (of) => ({ params: { id: of.codexPoolId } }) },
  'POST /providers/pools/:id/codex-login': { request: (of) => ({ params: { id: of.codexPoolId }, body: {} }) },
  'DELETE /providers/pools/:id/codex-login': { request: (of) => ({ params: { id: of.codexPoolId } }) },
  'DELETE /providers/pools/:id/codex-login/account': { request: (of) => ({ params: { id: of.codexPoolId } }) },
  'GET /providers/shared-pools/:id': { request: (of) => ({ params: { id: of.sharedPoolId } }) },
  'PATCH /providers/shared-pools/:id': {
    request: (of) => ({ params: { id: of.sharedPoolId }, body: { label: 'renamed by the census' } }),
  },
  'DELETE /providers/shared-pools/:id': { request: (of) => ({ params: { id: of.spare.sharedPoolId } }) },
  'POST /providers/shared-pools/:id/keys': {
    request: (of) => ({ params: { id: of.sharedPoolId }, body: { label: 'census key', apiKey: 'sk-census-key-0123456789' } }),
  },
  'PATCH /providers/shared-pools/:id/keys/:keyId': {
    request: (of) => ({ params: { id: of.sharedPoolId, keyId: of.sharedPoolKeyId }, body: { label: 'renamed by the census' } }),
    nested: ['keyId'],
  },
  'PUT /providers/shared-pools/:id/keys/:keyId/secret': {
    request: (of) => ({ params: { id: of.sharedPoolId, keyId: of.sharedPoolKeyId }, body: { apiKey: 'sk-census-key-9876543210' } }),
    nested: ['keyId'],
  },
  'DELETE /providers/shared-pools/:id/keys/:keyId': {
    request: (of) => ({ params: { id: of.sharedPoolId, keyId: of.sharedPoolKeyId } }),
    nested: ['keyId'],
  },
  'POST /providers/shared-pools/:id/leave': { request: (of) => ({ params: { id: of.joinedSharedPoolId } }) },
  'POST /providers/shared-pools/:id/people': {
    request: (of, mine) => ({ params: { id: of.sharedPoolId }, body: { email: mine.inviteeEmail } }),
  },
  'PATCH /providers/shared-pools/:id/people/:userId': {
    request: (of) => ({ params: { id: of.sharedPoolId, userId: of.sharedPoolPersonId }, body: { role: 'ADMIN' } }),
    nested: ['userId'],
  },
  'DELETE /providers/shared-pools/:id/people/:userId': {
    request: (of) => ({ params: { id: of.sharedPoolId, userId: of.sharedPoolPersonId } }),
    nested: ['userId'],
  },

  // ── runners ──────────────────────────────────────────────────────────────────────────────────
  'GET /runners/device/:userCode': { request: (of) => ({ params: { userCode: of.deviceUserCode } }) },
  'POST /runners/device/:userCode/approve': { request: (of) => ({ params: { userCode: of.deviceUserCode } }) },
  'POST /runners/device/:userCode/deny': { request: (of) => ({ params: { userCode: of.deviceUserCode } }) },
  'GET /runners/:id': { request: (of) => ({ params: { id: of.runnerId } }) },
  'PATCH /runners/:id': { request: (of) => ({ params: { id: of.runnerId }, body: { displayName: 'renamed by the census' } }) },
  'DELETE /runners/:id': { request: (of) => ({ params: { id: of.spare.runnerId } }) },
  // What a machine's finished sessions left behind holding uncommitted work. A's runner is not
  // B's to read, and one of A's sessions is not a checkout B may ask the diff of.
  'GET /runners/:id/abandoned-checkouts': { request: (of) => ({ params: { id: of.runnerId } }) },
  'GET /runners/:id/abandoned-checkouts/:sessionId': {
    request: (of) => ({ params: { id: of.runnerId, sessionId: of.sessionId } }),
  },
  'GET /runners/:id/login': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/login': { request: (of) => ({ params: { id: of.runnerId }, body: { engine: 'claude' } }) },
  'POST /runners/:id/login/code': { request: (of) => ({ params: { id: of.runnerId }, body: { code: 'census-code' } }) },
  'DELETE /runners/:id/login': { request: (of) => ({ params: { id: of.runnerId } }) },
  'DELETE /runners/:id/accounts/:engine/:account': {
    request: (of) => ({ params: { id: of.runnerId, ...of.runnerAccount } }),
  },
  'POST /runners/:id/accounts/:engine/default/restore': {
    request: (of) => ({ params: { id: of.runnerId, engine: of.runnerAccount.engine } }),
  },
  'PATCH /runners/:id/accounts/:engine/:account': {
    request: (of) => ({ params: { id: of.runnerId, ...of.runnerAccount }, body: { name: 'renamed by the census' } }),
  },
  'POST /runners/:id/accounts/:engine/:account/pause': {
    request: (of) => ({ params: { id: of.runnerId, ...of.runnerAccount }, body: { durationMinutes: 30 } }),
  },
  'DELETE /runners/:id/codex-accounts/:account': { request: (of) => ({ params: { id: of.runnerId, account: of.codexAccount } }) },
  'GET /runners/:id/install': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/install': { request: (of) => ({ params: { id: of.runnerId }, body: { engine: 'codex' } }) },
  'DELETE /runners/:id/install': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/engine-update': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/refresh-models': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/self-update': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/self-update/postpone': {
    request: (of) => ({ params: { id: of.runnerId }, body: { until: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'UTC' } }),
  },
  'POST /runners/:id/self-update/now': {
    request: (of) => ({ params: { id: of.runnerId }, body: { interruptTurns: true } }),
  },
  'POST /runners/:id/region-check': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/claude-history': { request: (of) => ({ params: { id: of.runnerId }, body: { workDir: '/census' } }) },
  'GET /runners/:id/claude-history': { request: (of) => ({ params: { id: of.runnerId }, query: { workDir: '/census' } }) },
  'POST /runners/:id/dir-probe': { request: (of) => ({ params: { id: of.runnerId }, body: { path: '/census' } }) },
  'GET /runners/:id/dir-probe': { request: (of) => ({ params: { id: of.runnerId }, query: { path: '/census' } }) },
  'POST /runners/:id/rotate-token': { request: (of) => ({ params: { id: of.runnerId } }) },
  'GET /runners/:id/codex-rate-limit-reset': { request: (of) => ({ params: { id: of.runnerId } }) },
  'POST /runners/:id/codex-rate-limit-reset': {
    request: (of) => ({
      params: { id: of.runnerId },
      body: { clientRequestId: '00000000-0000-4000-8000-00000000c0de', accountFingerprint: `cxa1_${'0'.repeat(32)}` },
    }),
  },
  'GET /runners/:id/codex-rate-limit-reset/:operationId': {
    request: (of) => ({ params: { id: of.runnerId, operationId: of.codexResetOperationId } }),
    nested: ['operationId'],
  },

  // ── session folders, tags, share links, requests between sessions ────────────────────────────
  'PATCH /session-folders/:id': { request: (of) => ({ params: { id: of.folderId }, body: { name: 'renamed by the census' } }) },
  'DELETE /session-folders/:id': { request: (of) => ({ params: { id: of.spare.folderId } }) },
  'PATCH /session-tags/:id': { request: (of) => ({ params: { id: of.tagId }, body: { name: 'renamed by the census' } }) },
  'DELETE /session-tags/:id': { request: (of) => ({ params: { id: of.spare.tagId } }) },
  'DELETE /share-links/:id': { request: (of) => ({ params: { id: of.spare.shareLinkId } }) },
  'GET /session-requests/:id': { request: (of) => ({ params: { id: of.sessionRequestId } }) },

  // ── sessions ─────────────────────────────────────────────────────────────────────────────────
  'GET /sessions/:id': { request: (of) => ({ params: { id: of.sessionId } }) },
  'GET /sessions/:id/compact': { request: (of) => ({ params: { id: of.sessionId } }) },
  // A landing session's check output (contract §2.9 LS2): the subject the session belongs to is the
  // account's, and another account's session is the same 404 as one that does not exist.
  'GET /sessions/:id/landing/log': { request: (of) => ({ params: { id: of.landingSessionId } }) },
  'PATCH /sessions/:id': { request: (of) => ({ params: { id: of.sessionId }, body: { title: 'renamed by the census' } }) },
  'DELETE /sessions/:id': { request: (of) => ({ params: { id: of.spare.sessionId } }) },
  'DELETE /sessions/:id/purge': { request: (of) => ({ params: { id: of.spare.purgedSessionId } }) },
  'GET /sessions/:id/artifacts': {
    request: (of) => ({ params: { id: of.sessionId }, query: { path: `/census/.orbit/uploads/${of.sessionId}/census.txt` } }),
  },
  'GET /sessions/:id/worktree-file': { request: (of) => ({ params: { id: of.sessionId }, query: { path: 'census.txt' } }) },
  'GET /sessions/:id/diff': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/diff/refresh': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/recap': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/turns': { request: (of) => ({ params: { id: of.sessionId }, body: turn('turn') }) },
  'POST /sessions/:id/turns/current-work-routing': { request: (of) => ({ params: { id: of.sessionId }, body: turn('routed') }) },
  'GET /sessions/:id/turns': { request: (of) => ({ params: { id: of.sessionId } }) },
  'DELETE /sessions/:id/turns/:turnId': {
    request: (of) => ({ params: { id: of.sessionId, turnId: of.turnId } }),
    nested: ['turnId'],
  },
  'POST /sessions/:id/turns/:turnId/steer': {
    request: (of) => ({ params: { id: of.sessionId, turnId: of.turnId } }),
    nested: ['turnId'],
  },
  'POST /sessions/:id/resume': { request: (of) => ({ params: { id: of.sessionId }, body: turn('resume') }) },
  // Session guests (docs/session-guests-design.md §7): the owner's People routes on A's session. The guest door is read
  // by hand (TENANT_ISOLATION_BY_HAND): the account that owns the session is no guest of it.
  'GET /sessions/:id/guests': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/guests': { request: (of) => ({ params: { id: of.sessionId }, body: { email: of.guestEmail } }) },
  'DELETE /sessions/:id/guests/:userId': { request: (of) => ({ params: { id: of.sessionId, userId: of.spare.guestUserId } }) },
  'PATCH /sessions/:id/config': { request: (of) => ({ params: { id: of.sessionId }, body: { effort: 'low' } }) },
  'PATCH /sessions/:id/account': { request: (of) => ({ params: { id: of.sessionId }, body: { account: 'automatic' } }) },
  'POST /sessions/:id/interrupt': { request: (of) => ({ params: { id: of.sessionId }, body: {} }) },
  'POST /sessions/:id/end': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/merge': { request: (of) => ({ params: { id: of.sessionId }, body: {} }) },
  'POST /sessions/:id/merge-repair': { request: (of) => ({ params: { id: of.sessionId }, body: {} }) },
  'GET /sessions/:id/merge-receipts': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/merge-receipts': {
    request: (of) => ({
      params: { id: of.sessionId },
      body: { result: 'MERGED', sourceSha: 'a'.repeat(40), targetBranch: 'main' },
    }),
  },
  'POST /sessions/:id/commit': { request: (of) => ({ params: { id: of.sessionId } }) },
  // Another account's session is not B's to throw work away from, whatever B knows of it.
  'POST /sessions/:id/checkout/discard': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/adopt-branch': { request: (of) => ({ params: { id: of.sessionId } }) },
  'GET /sessions/:id/retry-message': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/retry-message': { request: (of) => ({ params: { id: of.sessionId }, body: {} }) },
  'POST /sessions/:id/auto-retry': {
    request: (of) => ({ params: { id: of.sessionId }, body: { retryAt: new Date(Date.now() + 3_600_000).toISOString() } }),
  },
  'DELETE /sessions/:id/auto-retry': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/complete': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/archive': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/restore': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/pin': { request: (of) => ({ params: { id: of.sessionId } }) },
  'DELETE /sessions/:id/pin': { request: (of) => ({ params: { id: of.sessionId } }) },
  'GET /sessions/:id/move-targets': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/move': { request: (of, mine) => ({ params: { id: of.sessionId }, body: { workspaceId: mine.workspaceId } }) },
  'PUT /sessions/:id/tags': { request: (of, mine) => ({ params: { id: of.sessionId }, body: { tagIds: [mine.tagId] } }) },
  'GET /sessions/:id/approvals': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/approvals/:approvalId/decision': {
    request: (of) => ({ params: { id: of.sessionId, approvalId: of.approvalId }, body: { behavior: 'deny', message: 'the census' } }),
    nested: ['approvalId'],
  },
  'GET /sessions/:id/background': { request: (of) => ({ params: { id: of.sessionId } }) },
  'GET /sessions/:id/events': { request: (of) => ({ params: { id: of.sessionId } }) },
  'GET /sessions/:id/events/page': { request: (of) => ({ params: { id: of.sessionId } }) },
  'GET /sessions/:id/events/search': { request: (of) => ({ params: { id: of.sessionId }, query: { q: 'census' } }) },
  'GET /sessions/:id/events/:seq/full': { request: (of) => ({ params: { id: of.sessionId, seq: of.eventSeq } }) },
  'GET /sessions/:id/created-tasks': { request: (of) => ({ params: { id: of.sessionId } }) },
  'GET /sessions/:id/share': { request: (of) => ({ params: { id: of.sessionId } }) },
  'POST /sessions/:id/share': { request: (of) => ({ params: { id: of.sessionId } }) },
  'PUT /sessions/:id/share': { request: (of) => ({ params: { id: of.sessionId }, body: {} }) },
  'DELETE /sessions/:id/share': { request: (of) => ({ params: { id: of.sessionId } }) },

  // ── task lists ───────────────────────────────────────────────────────────────────────────────
  'GET /task-lists/:id': { request: (of) => ({ params: { id: of.listId } }) },
  'PATCH /task-lists/:id': { request: (of) => ({ params: { id: of.listId }, body: { title: 'renamed by the census' } }) },
  'DELETE /task-lists/:id': { request: (of) => ({ params: { id: of.spare.listId } }) },
  'POST /task-lists/:id/console': { request: (of, mine) => ({ params: { id: of.listId }, body: { workspaceId: mine.workspaceId } }) },
  'GET /task-lists/:id/revisions': { request: (of) => ({ params: { id: of.listId } }) },
  'POST /task-lists/:id/revisions/:version/restore': {
    request: (of) => ({ params: { id: of.listId, version: of.listRevision }, body: {} }),
  },

  // ── tasks ────────────────────────────────────────────────────────────────────────────────────
  'GET /tasks/:id': { request: (of) => ({ params: { id: of.taskId } }) },
  'GET /tasks/:id/row': { request: (of) => ({ params: { id: of.taskId } }) },
  'PATCH /tasks/:id': { request: (of) => ({ params: { id: of.taskId }, body: { title: 'renamed by the census' } }) },
  'DELETE /tasks/:id': { request: (of) => ({ params: { id: of.spare.taskId } }) },
  'GET /tasks/:id/attribution': { request: (of) => ({ params: { id: of.taskId } }) },
  'POST /tasks/:id/comments': { request: (of) => ({ params: { id: of.taskId }, body: { body: 'from the census' } }) },
  'DELETE /tasks/:id/comments/:commentId': {
    request: (of) => ({ params: { id: of.taskId, commentId: of.commentId } }),
    nested: ['commentId'],
  },
  'POST /tasks/:id/dependencies': {
    request: (of, mine) => ({ params: { id: of.taskId }, body: { dependsOnTaskId: mine.dependencyTaskId } }),
  },
  'DELETE /tasks/:id/dependencies/:dependsOnTaskId': {
    request: (of) => ({ params: { id: of.taskId, dependsOnTaskId: of.dependencyTaskId } }),
    nested: ['dependsOnTaskId'],
  },
  'GET /tasks/:id/dependency-graph': { request: (of) => ({ params: { id: of.taskId } }) },
  'POST /tasks/:id/dependency-graph/expand': {
    request: (of, mine) => ({
      params: { id: of.taskId },
      body: {
        anchorTaskId: of.taskId,
        direction: 'prerequisites',
        knownTaskIds: [of.taskId],
        loadedNeighborTaskIds: [],
        cursor: graphCursor(mine.userId, of.taskId),
      },
    }),
  },
  'POST /tasks/:id/dependency-graph/nodes': { request: (of) => ({ params: { id: of.taskId }, body: { taskIds: [of.taskId] } }) },
  'POST /tasks/:id/execute': { request: (of) => ({ params: { id: of.taskId }, body: {} }) },
  'GET /tasks/:id/progress': { request: (of) => ({ params: { id: of.taskId } }) },
  'POST /tasks/:id/progress': { request: (of) => ({ params: { id: of.taskId }, body: { phase: 'census' } }) },
  'GET /tasks/:id/share': { request: (of) => ({ params: { id: of.taskId } }) },
  'PUT /tasks/:id/share': { request: (of) => ({ params: { id: of.taskId }, body: {} }) },
  'DELETE /tasks/:id/share': { request: (of) => ({ params: { id: of.taskId } }) },
  'GET /tasks/:taskId/evidence': { request: (of) => ({ params: { taskId: of.evidenceTaskId } }) },
  'GET /tasks/:taskId/evidence/:revision/files': { request: (of) => ({ params: { taskId: of.evidenceTaskId, revision: '1' } }) },
  'POST /tasks/:taskId/evidence': {
    request: (of) => ({
      params: { taskId: of.evidenceTaskId },
      body: { sourceSessionId: of.evidenceSessionId, evidence: evidence('submitted by the census') },
    }),
  },
  'POST /tasks/:taskId/evidence/decision': {
    request: (of) => ({
      params: { taskId: of.evidenceTaskId },
      body: { decidingSessionId: of.sessionId, decision: 'SEND_BACK', evidenceRevision: '1', note: 'the census' },
    }),
  },
  'POST /tasks/:taskId/evidence/:revision/restart': {
    request: (of) => ({ params: { taskId: of.evidenceTaskId, revision: '1' }, body: {} }),
  },
  'POST /tasks/:taskId/evidence/legacy-import': {
    request: (of) => ({
      params: { taskId: of.evidenceTaskId },
      body: {
        sourceCommentId: of.evidenceCommentId,
        sourceSessionId: of.evidenceSessionId,
        evidence: evidence('imported by the census'),
        idempotencyKey: 'census-legacy-import',
        reviewNote: 'the census',
      },
    }),
  },
  'GET /tasks/:taskId/owner-confirmation': { request: (of) => ({ params: { taskId: of.taskId } }) },
  'POST /tasks/:taskId/owner-confirmation': {
    request: (of) => ({ params: { taskId: of.taskId }, body: { decision: 'SEND_BACK', note: 'the census' } }),
  },

  // ── watches ──────────────────────────────────────────────────────────────────────────────────
  'GET /watches/:id': { request: (of) => ({ params: { id: of.watchId } }) },
  'PATCH /watches/:id': { request: (of) => ({ params: { id: of.watchId }, body: { ttlSeconds: 3600 } }) },
  'POST /watches/:id/pause': { request: (of) => ({ params: { id: of.watchId } }) },
  'POST /watches/:id/resume': { request: (of) => ({ params: { id: of.watchId } }) },
  'POST /watches/:id/cancel': { request: (of) => ({ params: { id: of.watchId } }) },
  'POST /watches/deliveries/:id/retry': { request: (of) => ({ params: { id: of.watchDeliveryId } }) },

  // ── the wiki ─────────────────────────────────────────────────────────────────────────────────
  'GET /wiki/spaces/:id': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'PATCH /wiki/spaces/:id': { request: (of) => ({ params: { id: of.wikiSpaceId }, body: { title: 'renamed by the census' } }) },
  'GET /wiki/spaces/:id/entries': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/timeline': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/health': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/jobs': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/topics/:slug': { request: (of) => ({ params: { id: of.wikiSpaceId, slug: of.wikiTopicSlug } }) },
  'POST /wiki/spaces/:id/changesets': {
    request: (of) => ({
      params: { id: of.wikiSpaceId },
      body: { ops: [{ op: 'add_note', topic: of.wikiTopicSlug, body: 'from the census' }], rationale: 'the census', dryRun: true },
    }),
  },
  'GET /wiki/spaces/:id/workspaces': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'POST /wiki/spaces/:id/workspaces': {
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, body: { workspaceId: mine.workspaceId } }),
  },
  'DELETE /wiki/spaces/:id/workspaces/:workspaceId': {
    request: (of, mine) => ({ params: { id: of.wikiSpaceId, workspaceId: mine.workspaceId } }),
  },
  // The maintenance settings' probe and run now (contract `maintenance.probe`, `maintenance.run`): another account's space
  // is the plain 404 before any runner is asked or any run made.
  'POST /wiki/spaces/:id/maintenance/probe': {
    request: (of, mine) => ({ params: { id: of.wikiSpaceId }, body: { workspaceId: mine.workspaceId } }),
  },
  'POST /wiki/spaces/:id/maintenance/run': { request: (of) => ({ params: { id: of.wikiSpaceId }, body: {} }) },
  'DELETE /wiki/spaces/:id': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  // The Trash (contract `space.trash`): a restore of a wiki in use answers it as it is, and the permanent delete takes the
  // owner's spare wiki in Trash.
  'POST /wiki/spaces/:id/restore': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'DELETE /wiki/spaces/:id/purge': { request: (of) => ({ params: { id: of.spare.trashedWikiSpaceId } }) },
  // A space's wiki chats (contract `chat.routes`): another account's space is the plain 404 before anything is read.
  'GET /wiki/spaces/:id/chats': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'POST /wiki/spaces/:id/chats': {
    request: (of, mine) => ({
      params: { id: of.wikiSpaceId },
      body: { workspaceId: mine.workspaceId, content: 'from the census', clientTurnId: CENSUS_CHAT_TURN },
    }),
  },
  'POST /wiki/spaces/:id/verifications/reopen': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/articles': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/article-index': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/articles/:slug': { request: (of) => ({ params: { id: of.wikiSpaceId, slug: of.wikiArticleSlug } }) },
  'GET /wiki/spaces/:id/articles/:slug/:part': {
    request: (of) => ({ params: { id: of.wikiSpaceId, slug: of.wikiArticleSlug, part: of.wikiArticlePart } }),
  },
  'GET /wiki/spaces/:id/docs': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/doc-index': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/docs/:slug': { request: (of) => ({ params: { id: of.wikiSpaceId, slug: of.wikiDocSlug } }) },
  'GET /wiki/spaces/:id/docs/:slug/sections/:key/versions': {
    request: (of) => ({ params: { id: of.wikiSpaceId, slug: of.wikiDocSlug, key: of.wikiDocSectionKey } }),
  },
  'GET /wiki/spaces/:id/doc-changes': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  // The owner puts the census section back as its version kept it: written, never a 404.
  'POST /wiki/doc-versions/:id/restore': { request: (of) => ({ params: { id: of.wikiDocVersionId } }) },
  // A chat's cards and the owner's presses (contract `chat.drafts.read`, `chat.presses`): another account's chat or card is
  // the plain 404 before anything is read. The owner's own presses, in this order, apply the census card, find it applied
  // (edit and discard: 409) and leave it seen; Undo and Try again go to the applied plan card, whose plan moved past the
  // version its press made (undo: 409 WIKI_REVISION_CONFLICT; retry: 409, that version is not in force) — none a 401,
  // 403 or 404.
  'GET /wiki/chats/:id/drafts': { request: (of) => ({ params: { id: of.wikiChatId } }) },
  'GET /wiki/chat-drafts/:id': { request: (of) => ({ params: { id: of.wikiChatDraftId } }) },
  'POST /wiki/chat-drafts/:id/apply': { request: (of) => ({ params: { id: of.wikiChatDraftId } }) },
  'POST /wiki/chat-drafts/:id/edit': {
    request: (of) => ({ params: { id: of.wikiChatDraftId }, body: { ops: [{ seq: 0, changes: { title: 'From the census' } }] } }),
  },
  'POST /wiki/chat-drafts/:id/discard': { request: (of) => ({ params: { id: of.wikiChatDraftId } }) },
  'POST /wiki/chat-drafts/:id/undo': { request: (of) => ({ params: { id: of.wikiPlanCardId } }) },
  'POST /wiki/chat-drafts/:id/retry': { request: (of) => ({ params: { id: of.wikiPlanCardId } }) },
  'POST /wiki/chat-drafts/:id/seen': { request: (of) => ({ params: { id: of.wikiChatDraftId } }) },
  'GET /wiki/spaces/:id/share': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'PUT /wiki/spaces/:id/share': { request: (of) => ({ params: { id: of.wikiSpaceId }, body: {} }) },
  'DELETE /wiki/spaces/:id/share': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/plan': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/plan/versions': { request: (of) => ({ params: { id: of.wikiSpaceId } }) },
  'GET /wiki/spaces/:id/plan/versions/:version': {
    request: (of) => ({ params: { id: of.wikiSpaceId, version: of.wikiPlanVersion } }),
  },
  'POST /wiki/spaces/:id/plan/versions/:version/confirm': {
    request: (of) => ({ params: { id: of.wikiSpaceId, version: of.wikiPlanVersion }, body: {} }),
  },
  // The version in force (1, the census's confirmed one): the owner is answered WIKI_RUNNER_EXECUTES under the default
  // executor, never a 404.
  'POST /wiki/spaces/:id/plan/versions/:version/build': {
    request: (of) => ({ params: { id: of.wikiSpaceId, version: 1 }, body: {} }),
  },
  'POST /wiki/spaces/:id/plan/edits': { request: (of) => ({ params: { id: of.wikiSpaceId }, body: {} }) },
  'POST /wiki/spaces/:id/plan/redraft': { request: (of) => ({ params: { id: of.wikiSpaceId }, body: {} }) },
  'POST /wiki/plan-proposals/:id/decide': { request: (of) => ({ params: { id: of.wikiPlanProposalId }, body: { action: 'reject' } }) },
  'GET /wiki/entries/:id': { request: (of) => ({ params: { id: of.wikiEntryId } }) },
  'POST /wiki/entries/:id/confirm': { request: (of) => ({ params: { id: of.wikiEntryId } }) },
  'POST /wiki/entries/:id/reject': { request: (of) => ({ params: { id: of.wikiEntryId }, body: { reason: 'not_useful' } }) },
  'GET /wiki/changesets/:id': { request: (of) => ({ params: { id: of.wikiChangesetId } }) },
  'POST /wiki/changesets/:id/decide': {
    request: (of) => ({ params: { id: of.wikiChangesetId }, body: { decisions: [{ opId: of.wikiChangesetOpId, action: 'reject' }] } }),
  },
  'POST /wiki/changesets/:id/revert': { request: (of) => ({ params: { id: of.wikiChangesetId } }) },
};

/**
 * Routes the census cannot stand up against the production apiserver, each with why, and the reading
 * that shows the route finds its object only under the caller's own account. Kept as short as it can be.
 */
export const TENANT_ISOLATION_BY_HAND: Readonly<Record<string, string>> = {
  // ── main checkout (0534) ──
  'GET /workspaces/:id/main-checkout':
    'the workspace is read by (id, the caller, not deleted) before anything else, so another account\'s id answers 404 and nothing is queued (workspaces/main-checkout.service.ts:535); main-checkout.pg.spec.ts "actions are the owner\'s" sends it',
  'POST /workspaces/:id/main-checkout/actions':
    'a repeated requestId is looked up by (the caller, requestId) only; otherwise the workspace is read by (id, the caller, not deleted), 404 for another account\'s, before any row is written (workspaces/main-checkout.service.ts:170, :535); main-checkout.pg.spec.ts "actions are the owner\'s" sends it and counts no row written',
  'POST /workspaces/:id/main-checkout/actions/:requestId/cancel':
    'the request is read by (the caller, requestId) and must be of this workspace, 404 otherwise; the write is a compare-and-set on that row (workspaces/main-checkout.service.ts:276-280)',
  'GET /agents/:id/main-checkout':
    'the workspace is read by (id, the caller, not deleted) before anything else, so another account\'s id answers 404 and nothing is queued (workspaces/main-checkout.service.ts:535); main-checkout.pg.spec.ts "actions are the owner\'s" sends it',
  'POST /agents/:id/main-checkout/actions':
    'a repeated requestId is looked up by (the caller, requestId) only; otherwise the workspace is read by (id, the caller, not deleted), 404 for another account\'s, before any row is written (workspaces/main-checkout.service.ts:170, :535); main-checkout.pg.spec.ts "actions are the owner\'s" sends it and counts no row written',
  'POST /agents/:id/main-checkout/actions/:requestId/cancel':
    'the request is read by (the caller, requestId) and must be of this workspace, 404 otherwise; the write is a compare-and-set on that row (workspaces/main-checkout.service.ts:276-280)',
  // Session guests (docs/session-guests-design.md §7).
  'GET /guest-sessions/:id':
    "every guest route reads the caller's live session_guest row on that session first (session-guests/session-guests.service.ts:236) and answers the one 404 without it, so a session B was never invited to — A's included — is refused before anything is read or written; A, its owner, is no guest of it either, so neither account's request can be stood up from the census fixture. session-guests.pg.spec.ts (1) sends the invited guest's and a stranger's",
  'GET /guest-sessions/:id/events':
    "every guest route reads the caller's live session_guest row on that session first (session-guests/session-guests.service.ts:236) and answers the one 404 without it, so a session B was never invited to — A's included — is refused before anything is read or written; A, its owner, is no guest of it either, so neither account's request can be stood up from the census fixture. session-guests.pg.spec.ts (1) sends the invited guest's and a stranger's",
  'GET /guest-sessions/:id/events/:seq':
    "every guest route reads the caller's live session_guest row on that session first (session-guests/session-guests.service.ts:236) and answers the one 404 without it, so a session B was never invited to — A's included — is refused before anything is read or written; A, its owner, is no guest of it either, so neither account's request can be stood up from the census fixture. session-guests.pg.spec.ts (1) sends the invited guest's and a stranger's",
  'POST /guest-sessions/:id/turns':
    "every guest route reads the caller's live session_guest row on that session first (session-guests/session-guests.service.ts:236) and answers the one 404 without it, so a session B was never invited to — A's included — is refused before anything is read or written; A, its owner, is no guest of it either, so neither account's request can be stood up from the census fixture. session-guests.pg.spec.ts (1) sends the invited guest's and a stranger's",
  'DELETE /guest-sessions/:id/turns/:turnId':
    "every guest route reads the caller's live session_guest row on that session first (session-guests/session-guests.service.ts:236) and answers the one 404 without it, so a session B was never invited to — A's included — is refused before anything is read or written; A, its owner, is no guest of it either, so neither account's request can be stood up from the census fixture. session-guests.pg.spec.ts (1) sends the invited guest's and a stranger's; the turn is then looked up as the guest's own (session-guests/session-guests.service.ts:407)",
  'POST /guest-sessions/:id/turns/:turnId/steer':
    "every guest route reads the caller's live session_guest row on that session first (session-guests/session-guests.service.ts:236) and answers the one 404 without it, so a session B was never invited to — A's included — is refused before anything is read or written; A, its owner, is no guest of it either, so neither account's request can be stood up from the census fixture. session-guests.pg.spec.ts (1) sends the invited guest's and a stranger's; the turn is then looked up as the guest's own (session-guests/session-guests.service.ts:407)",
  'POST /guest-sessions/:id/leave':
    "every guest route reads the caller's live session_guest row on that session first (session-guests/session-guests.service.ts:236) and answers the one 404 without it, so a session B was never invited to — A's included — is refused before anything is read or written; A, its owner, is no guest of it either, so neither account's request can be stood up from the census fixture. session-guests.pg.spec.ts (1) sends the invited guest's and a stranger's",
  // ── criteria met by confirmation (0545) ────────────────────────────────────────────────────────
  'POST /projects/:id/criteria/:criterionId/confirmations': 'the criterion is read by (id, the project, the caller as the project\'s owner) before anything is read or written, so another account\'s project or criterion answers 404 (projects/project-criterion-confirmation.service.ts:244); project-criterion-confirmation.spec.ts reads the door',
  'POST /projects/:id/criteria/:criterionId/confirmations/withdraw': 'the criterion is read by (id, the project, the caller as the project\'s owner) before anything is read or written, so another account\'s project or criterion answers 404 (projects/project-criterion-confirmation.service.ts:244), and the UPDATE is keyed by that definition id',
  'POST /projects/:id/criteria/:criterionId/checks': 'the criterion is read by (id, the project, the caller as the project\'s owner) before anything is read or written, so another account\'s project or criterion answers 404 (projects/project-criterion-confirmation.service.ts:244); the check task is then filed through TasksService.create under the same owner',
  'GET /owner-requests/:id':
    'the request is read by (id, the caller) and nothing else, so another account\'s id answers 404 (owner-requests/owner-requests.service.ts:193); owner-requests.pg.spec.ts (f) sends it',
  'POST /owner-requests/:id/done':
    'read by (id, the caller) first, 404 for another account\'s id (owner-requests/owner-requests.service.ts:193), and the write is a compare-and-set on (id, the caller, PENDING) (owner-requests/owner-requests.service.ts:270); owner-requests.pg.spec.ts (f) sends it',
  'POST /owner-requests/:id/secret':
    'the request is read FOR UPDATE by (id, the caller) and nothing else, 404 for another account\'s id, and the grant takes its runner and session from that row, never from the body (owner-requests/owner-secrets.service.ts:244); owner-secrets.pg.spec.ts (h) sends it',
  'POST /owner-requests/:id/secret/cancel':
    'the grant is written by (request id, the caller) only; when that matched nothing the request is counted by (id, the caller), 404 for another account\'s (owner-requests/owner-secrets.service.ts:314); owner-secrets.pg.spec.ts (h) sends it',
  'POST /owner-requests/:id/secret/revoke':
    'the grant is read and written by (request id, the caller) only, 404 for another account\'s (owner-requests/owner-secrets.service.ts:332); owner-secrets.pg.spec.ts (h) sends it',
  'PUT /account-secrets/:id':
    'written by (id, the caller) only, and 404 when that matched nothing (owner-requests/owner-secrets.service.ts:404); owner-secrets.pg.spec.ts (h) sends another account\'s',
  'DELETE /account-secrets/:id':
    'deleted by (id, the caller) only, and 404 when that matched nothing (owner-requests/owner-secrets.service.ts:412); owner-secrets.pg.spec.ts (h) sends another account\'s',
  'POST /owner-requests/:id/decline':
    'read by (id, the caller) first, 404 for another account\'s id (owner-requests/owner-requests.service.ts:193), and the write is a compare-and-set on (id, the caller, PENDING) (owner-requests/owner-requests.service.ts:270)',
  'POST /admin/managed-runners/:id/volume-switch':
    'an administrator acts on another account\'s runner by design, and anybody else is refused 403 by AdminRoleGuard '
    + 'before anything is read (users/admin-role.guard.ts:21). The census server runs with managed runners off, where every '
    + 'caller, an administrator too, is answered 404 MANAGED_RUNNER_DISABLED before the role is asked (managed-runners/'
    + 'managed-runner-gate.ts:76), so no case of it can be answered there. On, the runner id finds that runner\'s mapping '
    + 'alone (managed-runners/managed-runner.service.ts:294), its volume is read only under that runner\'s own fixed name in '
    + 'the managed namespace (managed-runners/kubernetes-backend.ts:228), and a volume another mapping records is refused '
    + '(managed-runners/managed-runner-manager.ts:1460) — all of it, and a member\'s 403 with nothing written, sent over HTTP '
    + 'in managed-runners/managed-runner-volume-switch.pg.spec.ts',
};

// ── Ids a request carries in its body or query ────────────────────────────────────────────────────
//
// A path names the object a route acts on; a body or query names others beside it — where to put
// something, what to attach, what to filter by. Each is as much a way at another account as a path is:
// B opening a session in A's workspace runs B's prompt on A's machine. So every id a request carries
// that way — as Nest decodes one: PublicIdPipe on a query param or `forFields`, `@IsPublicId` on a DTO
// field, nested and in lists included — is listed below, keyed `<route> <body|query> <field>` with the
// field as `tenant-isolation-census.spec.ts` reads it off the DTO (`a.b` nested, `ids[]` a list).
//
// A case is B's own request — on B's objects, well formed — with A's object in that one field. It is
// held to what a request naming nothing is held to: it is answered exactly as the same request with an
// id that names nothing in that field, and it writes nothing that names anything of A's. The same
// request with B's own object in the field is then answered by the route: the field is read, not
// stripped before the check that would matter.

export interface TenantFieldCase {
  /** B's own request (`mine`), with `of`'s object in the field the case is keyed by and nowhere else. */
  request: (of: Tenant, mine: Tenant) => TenantRequest;
  /** Other fields the same object of `of`'s must appear in for the request to be well formed. */
  alongside?: readonly string[];
}

/** A task as the web files one: run by hand, accepted by an exit code. */
const taskBody = (extra: Record<string, unknown> = {}) => ({
  title: 'filed by the census',
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
  autoRunWhenReady: false,
  ...extra,
});
/** A session as the web opens one: a prompt in one of the caller's workspaces. */
const sessionBody = (mine: Tenant, extra: Record<string, unknown> = {}) => ({
  prompt: 'opened by the census',
  workspaceId: mine.workspaceId,
  ...extra,
});
const watchBody = (mine: Tenant, extra: Record<string, unknown> = {}) => ({
  predicateVersion: 1,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  targets: [{ kind: 'TASK', id: mine.taskId }],
  action: 'NOTIFY_USER',
  ...extra,
});
const checkpointBody = (extra: Record<string, unknown>) => ({
  branch: 'census',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  scopeRevision: 1,
  ...extra,
});
const workspaceFieldCases = (prefix: 'agents' | 'workspaces') => ({
  [`POST /${prefix} body runnerId`]: { request: (of: Tenant) => ({ params: {}, body: { name: 'census workspace', runnerId: of.runnerId } }) },
  [`POST /${prefix} body targetRunnerId`]: {
    request: (of: Tenant) => ({ params: {}, body: { name: 'census workspace', targetRunnerId: of.runnerId } }),
  },
  [`PATCH /${prefix}/:id body runnerId`]: {
    request: (of: Tenant, mine: Tenant) => ({ params: { id: mine.workspaceId }, body: { runnerId: of.runnerId } }),
  },
  [`PATCH /${prefix}/:id body targetRunnerId`]: {
    request: (of: Tenant, mine: Tenant) => ({ params: { id: mine.workspaceId }, body: { targetRunnerId: of.runnerId } }),
  },
  [`POST /${prefix}/reorder body ids[]`]: {
    request: (of: Tenant, mine: Tenant) => ({ params: {}, body: { ids: [mine.workspaceId, of.workspaceId] } }),
  },
}) satisfies Record<string, TenantFieldCase>;
/** The fields CreateTaskDto carries by id: on POST /tasks, and on each item of a batch. */
const taskCreateFieldCases = (route: string, wrap: (task: object) => object, where: string) => ({
  [`${route} body ${where}attachmentIds[]`]: { request: (of: Tenant) => ({ params: {}, body: wrap(taskBody({ attachmentIds: [of.attachmentId] })) }) },
  [`${route} body ${where}assigneeId`]: { request: (of: Tenant) => ({ params: {}, body: wrap(taskBody({ assigneeId: of.workspaceId })) }) },
  [`${route} body ${where}listId`]: { request: (of: Tenant) => ({ params: {}, body: wrap(taskBody({ listId: of.listId })) }) },
  [`${route} body ${where}projectId`]: { request: (of: Tenant) => ({ params: {}, body: wrap(taskBody({ projectId: of.projectId })) }) },
  [`${route} body ${where}fixesOpenItemId`]: {
    request: (of: Tenant, mine: Tenant) => ({ params: {}, body: wrap(taskBody({ projectId: mine.projectId, fixesOpenItemId: of.openItemId })) }),
  },
  [`${route} body ${where}parentTaskId`]: { request: (of: Tenant) => ({ params: {}, body: wrap(taskBody({ parentTaskId: of.taskId })) }) },
  [`${route} body ${where}verifiesTaskId`]: {
    request: (of: Tenant) => ({
      params: {},
      body: wrap(taskBody({ verifiesTaskId: of.taskId, completionCriterion: 'EXECUTABLE' })),
    }),
  },
  [`${route} body ${where}verification.assigneeId`]: {
    request: (of: Tenant) => ({
      params: {},
      body: wrap({
        title: 'checked by the census',
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
        verification: { title: 'the census checks it', assigneeId: of.workspaceId },
      }),
    }),
  },
  [`${route} body ${where}supersedesTaskId`]: { request: (of: Tenant) => ({ params: {}, body: wrap(taskBody({ supersedesTaskId: of.spare.taskId })) }) },
  [`${route} body ${where}dependsOnTaskIds[]`]: {
    request: (of: Tenant) => ({ params: {}, body: wrap(taskBody({ dependsOnTaskIds: [of.dependencyTaskId] })) }),
  },
}) satisfies Record<string, TenantFieldCase>;
/** The filters the task lists take by id. */
const taskFilterCases = (route: string, filters: readonly string[]) =>
  Object.fromEntries(filters.map((filter) => [`${route} query ${filter}`, {
    request: (of: Tenant) => ({
      params: {},
      query: {
        [filter]: { creatorSessionId: of.sessionId, assigneeId: of.workspaceId, projectId: of.projectId, listId: of.listId }[filter]!,
      },
    }),
  }])) as Record<string, TenantFieldCase>;

export const TENANT_ISOLATION_FIELD_CASES: Readonly<Record<string, TenantFieldCase>> = {
  // A local Ollama is bound to one of the caller's own runners (docs/ollama-local-provider-contract.md §3.1):
  // another account's runner is answered as a runner that does not exist, and nothing is written.
  'POST /providers/mine body runnerId': {
    request: (of) => ({ params: {}, body: { label: 'census ollama', presetSlug: 'ollama', baseUrl: 'http://127.0.0.1:11434', runnerId: of.runnerId } }),
  },
  'PATCH /providers/mine/:id body runnerId': {
    request: (of, mine) => ({ params: { id: mine.providerId }, body: { runnerId: of.runnerId } }),
  },
  'POST /access-tokens body workspaceIds[]': {
    request: (of) => ({ params: {}, body: { name: 'census token', scopes: ['tasks:read'], workspaceIds: [of.workspaceId] } }),
  },

  // The default workspace of the owner's Feishu direct messages (docs/feishu-bot-design.md §7.3): the workspace is read
  // before the app, so A's is answered as one that names nothing (404) and nothing is written.
  'PATCH /integrations/feishu body defaultWorkspaceId': { request: (of) => ({ params: {}, body: { defaultWorkspaceId: of.workspaceId } }) },

  ...workspaceFieldCases('agents'),
  ...workspaceFieldCases('workspaces'),

  'POST /attachments query taskId': {
    request: (of) => ({ params: {}, query: { taskId: of.taskId }, file: { name: 'census.txt', type: 'text/plain', content: 'census' } }),
  },
  'POST /attachments query sessionId': {
    request: (of) => ({ params: {}, query: { sessionId: of.sessionId }, file: { name: 'census.txt', type: 'text/plain', content: 'census' } }),
  },

  // ── projects ─────────────────────────────────────────────────────────────────────────────────
  // Connecting a Feishu group: the workspace is read before the ticket, so A's is answered as one that names nothing
  // (404), and B's own reaches the ticket check (409, the census holds no live ticket).
  'POST /integrations/feishu/chats/confirm body workspaceId': {
    request: (of) => ({
      params: {},
      body: { ticket: 'census-ticket', workspaceId: of.workspaceId, permissionMode: 'default', allowedOpenIds: [], maxConcurrentSessions: 2, sessionsPerDay: 20 },
    }),
  },
  'POST /projects body workspaceId': { request: (of) => ({ params: {}, body: { title: 'census project', workspaceId: of.workspaceId } }) },
  'POST /projects body coordinatorAgentId': {
    request: (of) => ({ params: {}, body: { title: 'census project', coordinatorAgentId: of.workspaceId } }),
  },
  'PATCH /projects/:id body coordinatorAgentId': {
    request: (of, mine) => ({ params: { id: mine.projectId }, body: { coordinatorAgentId: of.workspaceId } }),
  },
  'PATCH /projects/:id body acceptanceCriteriaItems[].id': {
    request: (of, mine) => ({
      params: { id: mine.projectId },
      body: {
        acceptanceCriteriaItems: [
          { id: mine.projectCriterionId, text: 'the census holds', verificationMethod: 'the census' },
          { id: of.projectCriterionId, text: 'the census holds elsewhere', verificationMethod: 'the census' },
        ],
      },
    }),
  },
  // The destination is read under the owner's own key: another account's project is one that names
  // nothing (404), before anything is moved.
  'POST /projects/:id/criteria/:criterionKey/move body toProjectId': {
    request: (of, mine) => ({
      params: { id: mine.projectId, criterionKey: mine.projectCriterionId },
      body: { toProjectId: of.projectId },
    }),
  },
  'POST /projects/:id/coordinator body workspaceId': {
    request: (of, mine) => ({ params: { id: mine.projectId }, body: { workspaceId: of.workspaceId } }),
  },
  'POST /projects/:id/coordinator/replace body workspaceId': {
    request: (of, mine) => ({ params: { id: mine.projectId }, body: { workspaceId: of.workspaceId } }),
  },
  'POST /projects/:id/coordinator/rebind body workspaceId': {
    request: (of, mine) => ({ params: { id: mine.projectId }, body: { workspaceId: of.workspaceId } }),
  },
  'POST /projects/:id/done body requestId': {
    request: (of, mine) => ({
      params: { id: mine.projectId },
      body: { criteriaDigest: 'e'.repeat(64), acceptedGaps: [], requestId: of.doneRequestItemId },
    }),
  },
  'POST /projects/:id/start body requestId': {
    request: (of, mine) => ({
      params: { id: mine.projectId },
      body: {
        criteriaDigest: 'e'.repeat(64), line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null,
        requestId: of.openItemId,
      },
    }),
  },
  'POST /projects/:id/tasks/:taskId/checkpoints body attemptId': {
    request: (of, mine) => ({
      params: { id: mine.projectId, taskId: mine.projectTaskId },
      body: checkpointBody({ attemptId: of.attemptId }),
    }),
  },
  'GET /projects/:id/tasks/page query parentId': {
    request: (of, mine) => ({ params: { id: mine.projectId }, query: { parentId: of.projectTaskId } }),
  },

  // ── providers, phones, runners ───────────────────────────────────────────────────────────────
  'POST /providers/pools body providerIds[]': { request: (of) => ({ params: {}, body: { label: 'census pool', providerIds: [of.providerId] } }) },
  'POST /providers/pools/:id/members body providerId': {
    request: (of, mine) => ({ params: { id: mine.poolId }, body: { providerId: of.providerId } }),
  },
  'POST /push/unregister body registrationKey': {
    request: (of, mine) => ({ params: {}, body: { token: mine.deviceToken, platform: 'android', registrationKey: of.deviceRegistrationId } }),
  },
  'POST /runners/:id/codex-rate-limit-reset body workspaceId': {
    request: (of, mine) => ({
      params: { id: mine.runnerId },
      body: {
        clientRequestId: '00000000-0000-4000-8000-00000000c0de',
        accountFingerprint: `cxa1_${'0'.repeat(32)}`,
        workspaceId: of.workspaceId,
      },
    }),
  },
  // Two different runners, so B's own request is a reorder the route answers, not a duplicate
  // `@ArrayUnique` refuses.
  'POST /runners/reorder body ids[]': {
    request: (of, mine) => ({ params: {}, body: { ids: [mine.runnerId, of.spare.runnerId] } }),
  },

  // ── sessions ─────────────────────────────────────────────────────────────────────────────────
  'POST /session-folders body workspaceId': { request: (of) => ({ params: {}, body: { workspaceId: of.workspaceId, name: 'census folder' } }) },
  'POST /sessions body workspaceId': { request: (of) => ({ params: {}, body: { prompt: 'opened by the census', workspaceId: of.workspaceId } }) },
  'POST /sessions body agentId': { request: (of) => ({ params: {}, body: { prompt: 'opened by the census', agentId: of.workspaceId } }) },
  'POST /sessions body assignedRunnerId': {
    request: (of, mine) => ({ params: {}, body: sessionBody(mine, { assignedRunnerId: of.runnerId }) }),
  },
  'POST /sessions body taskId': { request: (of, mine) => ({ params: {}, body: sessionBody(mine, { taskId: of.taskId }) }) },
  'POST /sessions body attachmentIds': {
    request: (of, mine) => ({ params: {}, body: sessionBody(mine, { attachmentIds: [of.attachmentId] }) }),
  },
  'POST /sessions body folderId': { request: (of, mine) => ({ params: {}, body: sessionBody(mine, { folderId: of.folderId }) }) },
  'GET /sessions query projectId': { request: (of) => ({ params: {}, query: { projectId: of.projectId } }) },
  'GET /sessions query tagId': { request: (of) => ({ params: {}, query: { tagId: of.tagId } }) },
  'GET /sessions query agentId': { request: (of) => ({ params: {}, query: { agentId: of.workspaceId } }) },
  'GET /sessions query workspaceId': { request: (of) => ({ params: {}, query: { workspaceId: of.workspaceId } }) },
  'GET /sessions query runnerId': { request: (of) => ({ params: {}, query: { runnerId: of.runnerId } }) },
  // The attempt a landing page names: B reads its own landing with A's job in the query, and is
  // answered as if it named nothing — the job is resolved within that landing and nowhere else.
  'GET /sessions/:id/landing/log query jobId': {
    request: (of, mine) => ({ params: { id: mine.landingSessionId }, query: { jobId: of.integrationJobId } }),
  },
  'GET /sessions/:id/events/page query around': {
    request: (of, mine) => ({ params: { id: mine.sessionId }, query: { around: of.eventId } }),
  },
  'POST /sessions/:id/interrupt body attachmentIds': {
    request: (of, mine) => ({
      params: { id: mine.sessionId },
      body: { ...turn('interrupt'), attachmentIds: [of.attachmentId] },
    }),
  },
  'POST /sessions/:id/move body workspaceId': {
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { workspaceId: of.workspaceId } }),
  },
  'POST /sessions/:id/move body folderId': { request: (of, mine) => ({ params: { id: mine.sessionId }, body: { folderId: of.folderId } }) },
  'POST /sessions/:id/resume body attachmentIds': {
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { ...turn('resume-attached'), attachmentIds: [of.attachmentId] } }),
  },
  'POST /sessions/:id/resume body stopSessionId': {
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { ...turn('resume-stopping'), stopSessionId: of.sessionId } }),
  },
  'PUT /sessions/:id/tags body tagIds[]': { request: (of, mine) => ({ params: { id: mine.sessionId }, body: { tagIds: [of.tagId] } }) },
  'POST /sessions/:id/turns body attachmentIds': {
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { ...turn('turn-attached'), attachmentIds: [of.attachmentId] } }),
  },
  'POST /sessions/:id/turns/current-work-routing body attachmentIds': {
    request: (of, mine) => ({ params: { id: mine.sessionId }, body: { ...turn('routed-attached'), attachmentIds: [of.attachmentId] } }),
  },
  'POST /sessions/import body workspaceId': {
    request: (of) => ({ params: {}, body: { claudeSessionId: '00000000-0000-4000-8000-0000000c1a0d', workspaceId: of.workspaceId } }),
  },
  'POST /sessions/import-batch body workspaceId': {
    request: (of) => ({
      params: {},
      body: { workspaceId: of.workspaceId, transcripts: [{ claudeSessionId: '00000000-0000-4000-8000-0000000c1a0e' }] },
    }),
  },
  'GET /sessions/imported query workspaceId': { request: (of) => ({ params: {}, query: { workspaceId: of.workspaceId } }) },
  'GET /sessions/compact query parentSessionId': { request: (of) => ({ params: {}, query: { parentSessionId: of.sessionId } }) },
  'POST /sessions/remove-imported body workspaceId': { request: (of) => ({ params: {}, body: { workspaceId: of.workspaceId } }) },
  'POST /share-links/turn-off body shareLinkIds[]': { request: (of) => ({ params: {}, body: { shareLinkIds: [of.spare.shareLinkId] } }) },

  // ── task lists and tasks ─────────────────────────────────────────────────────────────────────
  'PATCH /task-lists/:id body foremanWorkspaceId': {
    request: (of, mine) => ({ params: { id: mine.listId }, body: { foremanWorkspaceId: of.workspaceId } }),
  },
  'POST /task-lists/:id/console body workspaceId': {
    request: (of, mine) => ({ params: { id: mine.listId }, body: { workspaceId: of.workspaceId } }),
  },
  ...taskCreateFieldCases('POST /tasks', (task) => task, ''),
  ...taskCreateFieldCases('POST /tasks/batch-create', (task) => ({ tasks: [task] }), 'tasks[].'),
  'PATCH /tasks/:id body assigneeId': { request: (of, mine) => ({ params: { id: mine.taskId }, body: { assigneeId: of.workspaceId } }) },
  'PATCH /tasks/:id body listId': { request: (of, mine) => ({ params: { id: mine.taskId }, body: { listId: of.listId } }) },
  'PATCH /tasks/:id body projectId': { request: (of, mine) => ({ params: { id: mine.taskId }, body: { projectId: of.projectId } }) },
  'PATCH /tasks/:id body fixesOpenItemId': {
    request: (of, mine) => ({ params: { id: mine.projectTaskId }, body: { fixesOpenItemId: of.openItemId } }),
  },
  'PATCH /tasks/:id body parentTaskId': { request: (of, mine) => ({ params: { id: mine.taskId }, body: { parentTaskId: of.taskId } }) },
  'PATCH /tasks/:id body dependsOnTaskIds[]': {
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { dependsOnTaskIds: [mine.dependencyTaskId, of.dependencyTaskId] } }),
  },
  'PATCH /tasks/:id body verifiesTaskId': { request: (of, mine) => ({ params: { id: mine.taskId }, body: { verifiesTaskId: of.taskId } }) },
  'PATCH /tasks/:id body supersededByTaskId': {
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { supersededByTaskId: of.taskId } }),
  },
  'POST /tasks/:id/comments body mentions[]': {
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { body: 'from the census', mentions: [of.workspaceId] } }),
  },
  'POST /tasks/:id/dependencies body dependsOnTaskId': {
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { dependsOnTaskId: of.dependencyTaskId } }),
  },
  'POST /tasks/:id/dependency-graph/expand body anchorTaskId': {
    request: (of, mine) => ({
      params: { id: mine.taskId },
      body: {
        anchorTaskId: of.taskId,
        direction: 'prerequisites',
        knownTaskIds: [mine.taskId, of.taskId],
        loadedNeighborTaskIds: [],
        cursor: graphCursor(mine.userId, mine.taskId, of.taskId),
      },
    }),
    alongside: ['knownTaskIds[]'],
  },
  'POST /tasks/:id/dependency-graph/expand body knownTaskIds[]': {
    request: (of, mine) => ({
      params: { id: mine.taskId },
      body: {
        anchorTaskId: mine.taskId,
        direction: 'prerequisites',
        knownTaskIds: [mine.taskId, of.taskId],
        loadedNeighborTaskIds: [],
        cursor: graphCursor(mine.userId, mine.taskId),
      },
    }),
  },
  'POST /tasks/:id/dependency-graph/expand body loadedNeighborTaskIds[]': {
    request: (of, mine) => ({
      params: { id: mine.taskId },
      body: {
        anchorTaskId: mine.taskId,
        direction: 'prerequisites',
        knownTaskIds: [mine.taskId, of.taskId],
        loadedNeighborTaskIds: [of.taskId],
        cursor: graphCursor(mine.userId, mine.taskId),
      },
    }),
    alongside: ['knownTaskIds[]'],
  },
  'POST /tasks/:id/dependency-graph/nodes body taskIds[]': {
    request: (of, mine) => ({ params: { id: mine.taskId }, body: { taskIds: [mine.taskId, of.taskId] } }),
  },
  'POST /tasks/:taskId/evidence body sourceSessionId': {
    request: (of, mine) => ({
      params: { taskId: mine.evidenceTaskId },
      body: { sourceSessionId: of.evidenceSessionId, evidence: evidence('submitted by the census') },
    }),
  },
  'POST /tasks/:taskId/evidence/decision body decidingSessionId': {
    request: (of, mine) => ({
      params: { taskId: mine.evidenceTaskId },
      body: { decidingSessionId: of.sessionId, decision: 'SEND_BACK', evidenceRevision: '1', note: 'the census' },
    }),
  },
  'POST /tasks/:taskId/evidence/legacy-import body sourceCommentId': {
    request: (of, mine) => ({
      params: { taskId: mine.evidenceTaskId },
      body: {
        sourceCommentId: of.evidenceCommentId,
        sourceSessionId: mine.evidenceSessionId,
        evidence: evidence('imported by the census'),
        idempotencyKey: 'census-legacy-import-comment',
        reviewNote: 'the census',
      },
    }),
  },
  'POST /tasks/:taskId/evidence/legacy-import body sourceSessionId': {
    request: (of, mine) => ({
      params: { taskId: mine.evidenceTaskId },
      body: {
        sourceCommentId: mine.evidenceCommentId,
        sourceSessionId: of.evidenceSessionId,
        evidence: evidence('imported by the census'),
        idempotencyKey: 'census-legacy-import-session',
        reviewNote: 'the census',
      },
    }),
  },
  ...taskFilterCases('GET /tasks', ['creatorSessionId']),
  ...taskFilterCases('GET /tasks/active', ['projectId', 'listId']),
  ...taskFilterCases('GET /tasks/counts', ['creatorSessionId', 'assigneeId', 'projectId', 'listId']),
  ...taskFilterCases('GET /tasks/labels', ['assigneeId', 'projectId', 'listId']),
  ...taskFilterCases('GET /tasks/page', ['creatorSessionId', 'assigneeId', 'projectId', 'listId']),
  'GET /tasks/evidence-decisions/pending query decidingSessionId': {
    request: (of) => ({ params: {}, query: { decidingSessionId: of.sessionId } }),
  },
  'GET /tasks/model-routing/report query agentId': { request: (of) => ({ params: {}, query: { agentId: of.workspaceId } }) },
  'POST /tasks/batch-assign body taskIds[]': {
    request: (of, mine) => ({ params: {}, body: { taskIds: [mine.taskId, of.taskId], assigneeId: mine.workspaceId } }),
  },
  'POST /tasks/batch-assign body assigneeId': { request: (of, mine) => ({ params: {}, body: { taskIds: [mine.taskId], assigneeId: of.workspaceId } }) },
  'POST /tasks/batch-delete body taskIds[]': { request: (of) => ({ params: {}, body: { taskIds: [of.spare.taskId] } }) },
  'POST /tasks/batch-execute body taskIds[]': { request: (of) => ({ params: {}, body: { taskIds: [of.taskId] } }) },
  'POST /tasks/batch-stop body taskIds[]': { request: (of) => ({ params: {}, body: { taskIds: [of.taskId] } }) },

  // ── watches and the wiki ─────────────────────────────────────────────────────────────────────
  'POST /watches body observerSessionId': {
    request: (of, mine) => ({ params: {}, body: watchBody(mine, { action: 'RESUME_SESSION', observerSessionId: of.sessionId }) }),
  },
  'POST /watches body targets[].id': {
    request: (of, mine) => ({ params: {}, body: watchBody(mine, { targets: [{ kind: 'TASK', id: of.taskId }] }) }),
  },
  'GET /wiki/review query space': { request: (of) => ({ params: {}, query: { space: of.wikiSpaceId } }) },
  'GET /wiki/search query space': { request: (of) => ({ params: {}, query: { space: of.wikiSpaceId, q: 'census' } }) },
  'POST /wiki/spaces body maintenance.workspaceId': {
    request: (of) => ({ params: {}, body: { title: 'census wiki', maintenance: { workspaceId: of.workspaceId } } }),
  },
  'PATCH /wiki/spaces/:id body maintenance.workspaceId': {
    request: (of, mine) => ({ params: { id: mine.wikiSpaceId }, body: { maintenance: { workspaceId: of.workspaceId } } }),
  },
  'POST /wiki/spaces/:id/changesets body spaceId': {
    request: (of, mine) => ({
      params: { id: mine.wikiSpaceId },
      body: { ops: [{ op: 'add_note', topic: 'census', body: 'from the census' }], rationale: 'the census', dryRun: true, spaceId: of.wikiSpaceId },
    }),
  },
  'POST /wiki/spaces/:id/workspaces body workspaceId': {
    request: (of, mine) => ({ params: { id: mine.wikiSpaceId }, body: { workspaceId: of.workspaceId } }),
  },
  // The probe of another account's workspace: no such workspace for this one, and no runner is asked.
  'POST /wiki/spaces/:id/maintenance/probe body workspaceId': {
    request: (of, mine) => ({ params: { id: mine.wikiSpaceId }, body: { workspaceId: of.workspaceId } }),
  },
  // A chat named into another account's workspace: no such workspace for this one (WikiChat.chosenWorkspace).
  'POST /wiki/spaces/:id/chats body workspaceId': {
    request: (of, mine) => ({
      params: { id: mine.wikiSpaceId },
      body: { workspaceId: of.workspaceId, content: 'from the census', clientTurnId: CENSUS_CHAT_TURN },
    }),
  },
  // A chat's first message sent with another account's upload (board 43): no such file for this one, as for a new
  // session (SessionsService.assertScopableAttachments).
  'POST /wiki/spaces/:id/chats body attachmentIds': {
    request: (of, mine) => ({
      params: { id: mine.wikiSpaceId },
      body: { workspaceId: mine.workspaceId, content: 'from the census', clientTurnId: CENSUS_CHAT_TURN, attachmentIds: [of.attachmentId] },
    }),
  },
  // Where a space's chats run, set to another account's workspace: not one this space's chats may run in.
  'PATCH /wiki/spaces/:id body chat.workspaceId': {
    request: (of, mine) => ({ params: { id: mine.wikiSpaceId }, body: { chat: { workspaceId: of.workspaceId } } }),
  },
  'POST /wiki/changesets/:id/decide body decisions[].opId': {
    request: (of, mine) => ({
      params: { id: mine.wikiChangesetId },
      body: { decisions: [{ opId: of.wikiChangesetOpId, action: 'reject' }] },
    }),
  },
};

/** Ids a request carries that name nothing of an account's to reach, each with why and where that is so. */
export const TENANT_ISOLATION_FIELDS_BY_HAND: Readonly<Record<string, string>> = {
  'POST /admin/providers body runnerId':
    'a shared (admin) provider is never runner-scoped: createScope refuses runner scope on a row with no owner (PROVIDER_RUNNER_SHARED), or a runnerId on an account-scoped one (PROVIDER_RUNNER_NOT_SCOPED), before any runner is read, so no id is looked up at all (providers/local-provider.ts createScope); local-provider.spec.ts "createScope" sends both',
  'PATCH /admin/providers/:id body runnerId':
    'a shared (admin) provider is account-scoped, and updateScope refuses a runnerId on an account-scoped row (PROVIDER_RUNNER_NOT_SCOPED) before any runner is read (providers/local-provider.ts updateScope); local-provider.spec.ts "updateScope" sends one',
  'POST /workspaces/:id/main-checkout/actions body targetSessionId':
    'read by (id, the caller, not deleted) and required to be a session of this workspace before anything is written, so another account\'s is the 404 of one that does not exist (workspaces/main-checkout.service.ts:553); main-checkout.pg.spec.ts "move: the target must be…" sends one that does not exist',
  'POST /workspaces/:id/main-checkout/actions body initiatedFromSessionId':
    'read by (id, the caller, not deleted) and required to be of this workspace before anything is written: another account\'s answers 404 (workspaces/main-checkout.service.ts:553); main-checkout.pg.spec.ts "actions are the owner\'s" sends another account\'s and counts no row written',
  'POST /agents/:id/main-checkout/actions body targetSessionId':
    'read by (id, the caller, not deleted) and required to be a session of this workspace before anything is written, so another account\'s is the 404 of one that does not exist (workspaces/main-checkout.service.ts:553); main-checkout.pg.spec.ts "move: the target must be…" sends one that does not exist',
  'POST /agents/:id/main-checkout/actions body initiatedFromSessionId':
    'read by (id, the caller, not deleted) and required to be of this workspace before anything is written: another account\'s answers 404 (workspaces/main-checkout.service.ts:553); main-checkout.pg.spec.ts "actions are the owner\'s" sends another account\'s and counts no row written',
  'POST /projects/:id/criteria/:criterionId/confirmations body attachmentIds[]':
    'counted among the caller\'s own uploads (attachment by id and owner) before anything is written; one that is not answers 404 (projects/project-criterion-confirmation.service.ts:281)',
  'POST /projects/:id/criteria/:criterionId/checks body workspaceId':
    'handed to TasksService.create as the check task\'s assignee, which reads the workspace by (id, the caller) and refuses another account\'s 403 before any row is written (tasks/tasks.service.ts:2606)',
  'POST /tasks body fork.sessionId':
    'refused 403 whatever it names: the browser door has no calling session, and a fork is only ever of the session making the call (tasks/task-fork.ts:117); task-session-fork.pg.spec.ts sends one from the owner door',
  'POST /tasks/batch-create body tasks[].fork.sessionId':
    'refused 403 whatever it names: the browser door has no calling session, and a fork is only ever of the session making the call (tasks/task-fork.ts:117); task-session-fork.pg.spec.ts sends one from the owner door',
  'POST /owner-requests/:id/secret body savedSecretId':
    'read by (id, the caller) before anything is written, so another account\'s saved secret is the 404 of one that does not exist (owner-requests/owner-secrets.service.ts:217); owner-secrets.pg.spec.ts (h) sends another account\'s',
  'POST /tasks/:id/execute body triggerId':
    'an idempotency key the caller makes up for one press, not a thing it names: it keys only the caller\'s own '
    + 'run receipt, (owner_id, action_kind, request_token) — tasks.service.ts:12779',
  'POST /tasks/:taskId/evidence/:revision/restart body triggerId':
    'the Run press\'s idempotency key, made up by the caller and handed to TasksService.execute as is: it keys only the '
    + 'caller\'s own run receipt, (owner_id, action_kind, request_token) — tasks.service.ts:14771, as POST /tasks/:id/execute body triggerId does',
  'POST /tasks/batch-execute body triggerId':
    'the same press key, for a bulk Run: the caller\'s own receipt, keyed by owner — tasks.service.ts:12779',
  'POST /push/register body installationId':
    'a phone\'s own installation id, which only that phone holds and no read hands out; a registration moves '
    + 'with the phone on purpose when it signs in as somebody else (push.controller.ts:32), the device token alike',
  'POST /tasks/:taskId/owner-confirmation body requestId':
    'never looked up on its own: compared with the open request of the caller\'s own task, read under that '
    + 'task\'s lock for its owner — task-owner-confirmation.service.ts:255 (send-back :345); another account\'s '
    + 'request is the refusal any id that is not this task\'s request gets',
  'POST /tasks/:taskId/owner-confirmation body reviewRecordId':
    'never looked up on its own: compared with the current review of the caller\'s own task\'s request — '
    + 'owner-confirmation-review.ts:788 and :820; another account\'s record is stale like any other id',
};
