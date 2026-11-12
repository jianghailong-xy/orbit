/**
 * The owner channel's doors (docs/personal-access-token-design.md §5): every route behind JwtAuthGuard
 * that refuses a personal access token as the account owner's own decision,
 * @PatForbidden('OWNER_INTERACTIVE'). The decorators are what the guard reads; this list is what they
 * are held to — exactly, both ways, by `pat-route-coverage.spec.ts` — and what
 * `pat-owner-channel.pg.spec.ts` sends a token and a login to, one door at a time.
 */
export const OWNER_INTERACTIVE_ROUTES: readonly string[] = [
  // The design's list.
  // Owner request secrets (docs/design/owner-request-secrets.md §8.1): entering, cancelling or revoking a key, and the
  // saved secrets. Each also refuses a request carrying an acting session, SECRET_OWNER_CHANNEL_ONLY.
  'POST /owner-requests/:id/secret',
  'POST /owner-requests/:id/secret/cancel',
  'POST /owner-requests/:id/secret/revoke',
  'GET /account-secrets',
  'PUT /account-secrets/:id',
  'DELETE /account-secrets/:id',
  'POST /tasks/:taskId/owner-confirmation',
  'POST /tasks/:taskId/evidence/decision',
  'POST /sessions/:id/approvals/:approvalId/decision',
  'POST /projects/:id/acceptance/confirmation',
  'POST /projects/:id/acceptance/criteria-decisions/:intentId',
  'POST /projects/:projectId/promotions/:promotionId/confirm',
  'POST /projects/:projectId/promotions/:promotionId/decline',
  'POST /projects/:projectId/promotions/:promotionId/cancel',
  'POST /projects/:id/handoffs/:handoffId/decision',
  // The same rule where the design names no door: the owner's own decisions the code already keeps
  // from agents. These refuse a request that carries an agent session — starting a project seals its
  // criteria, the standard-set confirmation by another door.
  'POST /projects/:id/start',
  'GET /projects/:id/done-check',
  'POST /projects/:id/done',
  'POST /projects/:id/pause',
  'POST /projects/:id/resume',
  // Move to a follow-up… on the done card: it refuses an acting session, as pause and resume do.
  'POST /projects/:id/criteria/:criterionKey/move',
  // Complete on a finished project's row (session-list-projects-design §3.6): it refuses an acting
  // session, as pause and resume do.
  'POST /projects/:id/sessions/complete',
  'POST /projects/:id/done-requests/:itemId/decline',
  // These answer what was put to the owner, on a door no agent has: the commitToken that decides a
  // held criteria change, the fuse that stopped a coordinator, the items escalated to the owner.
  'GET /projects/:id/acceptance/criteria-decisions/pending',
  'POST /projects/:id/fuse/:episodeId/resume',
  'POST /projects/:id/open-items/:itemId/answer',
  'POST /projects/:id/open-items/:itemId/return-to-coordinator',
  'POST /projects/:id/open-items/:itemId/resolve',
  // §10.8's Accept: work that reached the branch without the owner's confirmation, accepted by them.
  'POST /projects/:id/open-items/:itemId/accept',
  // The integration line: every field of this route is the one `PATCH /projects/:id` refuses a token
  // as `integration`, and an agent session as INTEGRATION_SETTINGS_OWNER_ONLY. That last one is
  // this route's rule and no longer the update route's: a session may propose a project's MERGE
  // CHECK on `PATCH /projects/:id` when the owner has answered a card for exactly that change
  // (`project-integration-approval.ts`), while a token is refused the whole object there. A token
  // is not a session, so there is nothing for a card to be bound to — and one change would then be
  // two rules, which is the door this list exists to close rather than a gap in it.
  'PATCH /projects/:id/integration',
  // The two doors that take work off the integration line without retrying it (§2.2 J-T8, J-T10;
  // §4.7). Each refuses an acting session: a coordinator abandons through `integration_abandon`,
  // and a coordinator that wants work stopped reopens the task instead.
  'POST /projects/:id/integration/jobs/:jobId/abandon',
  'POST /projects/:id/tasks/:taskId/integration/stop',
  // §10.8's "look again", the owner's door annotated and registered as the abandon door is: it refuses
  // an acting session, and a coordinator asks through `integration_observe`.
  'POST /projects/:id/integration/observe',
  // The wiki's owner channel: each refuses an agent session WIKI_OWNER_CHANNEL_ONLY.
  'POST /wiki/entries/:id/reject',
  'POST /wiki/entries/:id/confirm',
  'POST /wiki/changesets/:id/decide',
  'POST /wiki/changesets/:id/revert',
  'POST /wiki/spaces/:id/verifications/reopen',
  'POST /wiki/spaces/:id/workspaces',
  'DELETE /wiki/spaces/:id/workspaces/:workspaceId',
  // The maintenance settings' probe and Check again and run now (docs/wiki-repo-tiers-design.md §7.3).
  'POST /wiki/spaces/:id/maintenance/probe',
  'POST /wiki/spaces/:id/maintenance/run',
  'DELETE /wiki/spaces/:id',
  'POST /wiki/spaces/:id/restore',
  'DELETE /wiki/spaces/:id/purge',
  'GET /wiki/trash',
  'GET /wiki/changesets/:id',
  'GET /wiki/spaces/:id/plan',
  'GET /wiki/spaces/:id/plan/versions',
  'GET /wiki/spaces/:id/plan/versions/:version',
  'POST /wiki/spaces/:id/plan/edits',
  'POST /wiki/spaces/:id/plan/versions/:version/confirm',
  'POST /wiki/spaces/:id/plan/redraft',
  'POST /wiki/spaces/:id/plan/versions/:version/build',
  'POST /wiki/plan-proposals/:id/decide',
  // The owner's restore of a version a section kept (contract `docs.versions.restore`): the user door's one write to a
  // document, which refuses an acting session WIKI_OWNER_CHANNEL_ONLY as the plan's routes do.
  'POST /wiki/doc-versions/:id/restore',
  // Making a wiki chat (contract `chat.door`): the owner's interactive credential's, as the binding writes are.
  'POST /wiki/spaces/:id/chats',
  // The six presses of a chat's card (contract `chat.presses`): the owner's alone, as decide is.
  'POST /wiki/chat-drafts/:id/apply',
  'POST /wiki/chat-drafts/:id/edit',
  'POST /wiki/chat-drafts/:id/discard',
  'POST /wiki/chat-drafts/:id/undo',
  'POST /wiki/chat-drafts/:id/retry',
  'POST /wiki/chat-drafts/:id/seen',
  // Connecting a Feishu group, and changing or removing one (docs/feishu-bot-design.md §8.1, §8.3): each lets people in
  // the group start agents on the owner's machines, in the mode the owner chose.
  'POST /integrations/feishu/chats/confirm',
  'PATCH /integrations/feishu/chats/:id',
  'DELETE /integrations/feishu/chats/:id',
];
