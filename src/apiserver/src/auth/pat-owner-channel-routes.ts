/**
 * The owner channel's doors (docs/personal-access-token-design.md §5): every route behind JwtAuthGuard
 * that refuses a personal access token as the account owner's own decision,
 * @PatForbidden('OWNER_INTERACTIVE'). The decorators are what the guard reads; this list is what they
 * are held to — exactly, both ways, by `pat-route-coverage.spec.ts` — and what
 * `pat-owner-channel.pg.spec.ts` sends a token and a login to, one door at a time.
 */
export const OWNER_INTERACTIVE_ROUTES: readonly string[] = [
  // The design's list.
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
  'POST /projects/:id/done',
  'POST /projects/:id/pause',
  'POST /projects/:id/resume',
  'POST /projects/:id/done-requests/:itemId/decline',
  // These answer what was put to the owner, on a door no agent has: the commitToken that decides a
  // held criteria change, the fuse that stopped a coordinator, the items escalated to the owner.
  'GET /projects/:id/acceptance/criteria-decisions/pending',
  'POST /projects/:id/fuse/:episodeId/resume',
  'POST /projects/:id/open-items/:itemId/answer',
  'POST /projects/:id/open-items/:itemId/return-to-coordinator',
  'POST /projects/:id/open-items/:itemId/resolve',
  // The integration line: every field of this route is the one `PATCH /projects/:id` refuses a token
  // as `integration` (and an agent session as INTEGRATION_SETTINGS_OWNER_ONLY).
  'PATCH /projects/:id/integration',
  // The wiki's owner channel: each refuses an agent session WIKI_OWNER_CHANNEL_ONLY.
  'POST /wiki/entries/:id/reject',
  'POST /wiki/entries/:id/confirm',
  'POST /wiki/changesets/:id/decide',
  'POST /wiki/changesets/:id/revert',
  'POST /wiki/spaces/:id/verifications/reopen',
  'GET /wiki/changesets/:id',
  'GET /wiki/spaces/:id/plan',
  'GET /wiki/spaces/:id/plan/versions',
  'GET /wiki/spaces/:id/plan/versions/:version',
  'POST /wiki/spaces/:id/plan/edits',
  'POST /wiki/spaces/:id/plan/versions/:version/confirm',
  'POST /wiki/spaces/:id/plan/redraft',
  'POST /wiki/plan-proposals/:id/decide',
];
