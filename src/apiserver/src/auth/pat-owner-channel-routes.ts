import { underEveryDrivePrefix } from '../drive/drive-routes';

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
  // The owner's Create wiki on a WIKI_CREATE card (docs/wiki-explicit-creation-design.md §3.6): making a wiki is the
  // owner's own act, as POST /wiki/spaces is; it also refuses an acting session, WIKI_OWNER_CHANNEL_ONLY.
  'POST /owner-requests/:id/create-wiki',
  // The owner's Save changes on a SETTINGS_CHANGE card (docs/settings-from-conversation-design.md §5.2): it writes the
  // account's preferences; it also refuses an acting session, SETTINGS_OWNER_CHANNEL_ONLY.
  'POST /owner-requests/:id/apply-settings',
  // The owner's Reopen on a PROJECT_REOPEN card (docs/project-reopen-request-design.md §4.2): the project page's Reopen
  // press made from a card; it also refuses an acting session, REOPEN_OWNER_CHANNEL_ONLY.
  'POST /owner-requests/:id/reopen-project',
  'GET /account-secrets',
  'POST /account-secrets',
  'GET /account-secrets/grants',
  'POST /account-secrets/grants/:id/revoke',
  'PUT /account-secrets/:id',
  'DELETE /account-secrets/:id',
  'POST /tasks/:taskId/owner-confirmation',
  'POST /tasks/:taskId/evidence/decision',
  'POST /tasks/:taskId/evidence/:revision/restart',
  'POST /sessions/:id/approvals/:approvalId/decision',
  // Run now (docs/mocks/queued-run-now decision E): starting a queued message over the runner's limit is a person's
  // act, so agents cannot skip the queue for themselves. It also refuses an acting session, RUN_NOW_OWNER_CHANNEL_ONLY.
  'POST /sessions/:id/run-now',
  // Session guests (docs/session-guests-design.md §3): who may drive the agent on the owner's machine, with the
  // owner's accounts, is the owner's to decide and to see.
  'GET /sessions/:id/guests',
  'GET /sessions/:id/guests/suggestions',
  'POST /sessions/:id/guests',
  'DELETE /sessions/:id/guests/:userId',
  'POST /projects/:id/acceptance/confirmation',
  'POST /projects/:id/acceptance/criteria-decisions/:intentId',
  'POST /projects/:projectId/promotions/:promotionId/confirm',
  'POST /projects/:projectId/promotions/:promotionId/decline',
  'POST /projects/:projectId/promotions/:promotionId/cancel',
  'POST /projects/:id/handoffs/:handoffId/decision',
  'POST /sessions/:id/task-moves/decision',
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
  // §12.15 P-R1: the owner putting a coordinator's recorded landing-check change back. Refuses an acting session.
  'POST /projects/:id/setting-changes/:changeId/revert',
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
  // Making a Drive chat (drive/drive-chat.ts), under /drive and its /documents alias: the owner's interactive
  // credential's, as making a wiki chat is; it also refuses an acting session, DRIVE_CHAT_OWNER_CHANNEL_ONLY.
  ...underEveryDrivePrefix('POST /drive/chats'),
  // A Drive chat's Undo, Apply and an answer to its overwrite question (drive/drive-chat-changes.ts): presses of the
  // owner's, as a wiki chat card's are; they also refuse an acting session, DRIVE_CHAT_OWNER_CHANNEL_ONLY.
  ...underEveryDrivePrefix('POST /drive/chats/:sessionId/groups/:groupId/undo'),
  ...underEveryDrivePrefix('POST /drive/chats/:sessionId/groups/:groupId/apply'),
  ...underEveryDrivePrefix('POST /drive/chats/:sessionId/questions/:questionId'),
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
  // Who can use the Feishu bot (docs/feishu-bot-design.md §14.1): opening it lets everyone the app is available to in
  // Feishu start agents on the owner's machines, in the workspace and mode chosen here.
  'PUT /integrations/feishu/access',
  // A terminal asking to be approved (docs/terminal-session-design.md, "The terminal credential"): approving mints a
  // credential that answers this machine's approval cards for 30 days, so the card, its Approve and its Deny are the
  // owner's own, signed in to the app — never a token's, a runner's or another terminal's.
  'GET /terminals/requests',
  'POST /terminals/requests/:id/approve',
  'POST /terminals/requests/:id/deny',
  // A scheduled task's two cards (docs/scheduled-tasks-design.md §4, §9.1): Create on a create card writes the schedule
  // and its envelope, Allow on an envelope card grows what it may do; Not now and Decline answer them. Each also refuses
  // a request carrying an acting session, SCHEDULE_DECISION_OWNER_CHANNEL_ONLY.
  'POST /schedule-requests/:id/allow',
  'POST /schedule-requests/:id/decline',
];
