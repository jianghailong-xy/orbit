import {
  TENANT_ISOLATION_CASES,
  TENANT_ISOLATION_FIELD_CASES,
  paramsOf,
} from '../auth/tenant-isolation-cases';
import {
  RUNNER_ISOLATION_CASES,
  RUNNER_ISOLATION_FIELD_CASES,
} from '../auth/tenant-isolation-runner-cases';

/**
 * The engine-path route census (docs/project-integration-line-contract.md §2.9 LS6; errata E4).
 *
 * Every door that changes a session must refuse a LANDING row with 409 SESSION_IS_PLATFORM_DRIVEN.
 * The door set is not typed out again here: it is DERIVED from the two tenant-isolation registries,
 * which already hold every non-GET route with a path parameter (the user door in
 * `auth/tenant-isolation-cases.ts`, the runner door in `auth/tenant-isolation-runner-cases.ts`).
 * A route that arrives there without a line below makes `engine-session-census.spec.ts` red — the
 * same places a reviewer already has to touch when adding a route.
 *
 * What each derived route is held to is a GUARD SITE: the method whose body contains the assertion
 * (or the loader it funnels through — End and the queued-turn doors share `getSendable`, Complete
 * and Trash share `transitionEnd`). Each site names a snippet that must appear in the source, so
 * deleting one assertion — "deliberately omitting an entry" — is a red spec, not a silent hole.
 */

/** A non-GET route that names a session's own id in its path, under `prefix`. */
export function routesNamingSession(
  cases: Readonly<Record<string, unknown>>,
  prefix: string,
): string[] {
  const pattern = new RegExp(`^(\\S+) ${prefix}/:id(?:/|$)`);
  return Object.keys(cases)
    .filter((key) => {
      const match = pattern.exec(key);
      return match !== null && match[1] !== 'GET';
    })
    .sort();
}

/** The user door: 33 routes today (POST recap and the steer door included — the two the baseline
 *  did not have). */
export const ENGINE_SESSION_USER_ROUTES = routesNamingSession(TENANT_ISOLATION_CASES, '/sessions');

/** The runner door: 30 routes today (naming, a turn suggestion, the Cursor key check and a job's alert included). */
export const ENGINE_SESSION_RUNNER_ROUTES = routesNamingSession(RUNNER_ISOLATION_CASES, '/runner/sessions');

/**
 * The doors whose session id rides in the body or the query rather than the path (6). Each is held
 * to the field case of the same name in the isolation registries, so the two lists cannot drift.
 */
export const ENGINE_SESSION_FIELD_CASES: Readonly<Record<string, { guard: string; note: string }>> = {
  'POST /attachments query sessionId': {
    guard: 'AttachmentsService.create',
    note: 'an upload scoped to a session is an input to an engine turn',
  },
  'POST /watches body observerSessionId': {
    guard: 'WatchesService.readTargets',
    note: 'a watch wakes a conversation; the platform drives a landing',
  },
  'POST /sessions/:id/resume body stopSessionId': {
    guard: 'SessionsService.resumeStopTarget',
    note: 'the run a provider switch may stop, named in the body',
  },
  'POST /runner/heartbeat body supervisedSessionIds[]': {
    guard: 'RunnerApiController.assertNoLandingSessionNamed',
    note: 'a supervised id is a session this runner hosts',
  },
  'POST /runner/heartbeat body sessions[].sessionId': {
    guard: 'RunnerApiController.assertNoLandingSessionNamed',
    note: 'a worktree snapshot belongs to a session this runner hosts',
  },
  'POST /runner/heartbeat body expiredCommitErrors[].sessionId': {
    guard: 'RunnerApiController.assertNoLandingSessionNamed',
    note: 'an expired commit attempt belongs to a session this runner hosts',
  },
};

/** One assertion site. `snippet` is source text that must still be there. */
export interface EngineSessionGuardSite {
  /** Path from `src/apiserver/src`, e.g. `sessions/sessions.service.ts`. */
  file: string;
  /** The exact source text the assertion is written with. Removing the assertion removes it. */
  snippet: string;
  /** What the site answers, beyond the route keys it is reached from. */
  note: string;
}

export const ENGINE_SESSION_GUARD_SITES: Readonly<Record<string, EngineSessionGuardSite>> = {
  'SessionsService.createTurn': {
    file: 'sessions/sessions.service.ts',
    snippet: "// No engine turn can be queued onto the platform's landing container (§2.9 LS6).",
    note: 'queueing a turn under the Session lock; covers POST /turns, current-work-routing and the runner send',
  },
  'SessionsService.resume': {
    file: 'sessions/sessions.service.ts',
    snippet: "// Reviving is an engine door: the platform's landing container has nothing to revive (§2.9 LS6).",
    note: 'the revive path every resumeIfEnded and the sweeps take',
  },
  'SessionsService.resumeStopTarget': {
    file: 'sessions/sessions.service.ts',
    snippet: 'if (stop) assertEngineSessionRow(stop);',
    note: 'the session named by the resume body\'s stopSessionId',
  },
  'SessionsService.interrupt': {
    file: 'sessions/sessions.service.ts',
    snippet: '// Stopping a turn — or stopping one and replacing it — is an engine door (§2.9 LS6).',
    note: 'POST /interrupt and the runner interruption door',
  },
  'SessionsService.getSendable': {
    file: 'sessions/sessions.service.ts',
    snippet: '// A LANDING row is never sendable: the composer, End and the queued-turn doors all reach this',
    note: 'End and DELETE /turns/:turnId both load through it; the composer does too',
  },
  'SessionsService.transitionEnd': {
    file: 'sessions/sessions.service.ts',
    snippet: "// End and Trash both land here; the platform's landing container is not a person's to close or",
    note: 'Complete, the archive alias, Trash and the runner lifecycle ends share it',
  },
  'SessionsService.restore': {
    file: 'sessions/sessions.service.ts',
    snippet: 'SELECT id, "kind" AS "sessionKind" FROM "session"',
    note: 'the row lock read restore judges before writing',
  },
  'SessionsService.purge': {
    file: 'sessions/sessions.service.ts',
    snippet: 'SELECT id, "deleted_at" AS "deletedAt", "kind" AS "sessionKind" FROM "session"',
    note: 'the row lock read purge judges before deleting',
  },
  'SessionsService.rename': {
    file: 'sessions/sessions.service.ts',
    snippet: "// A landing's title is written by the server (titleManagedByProject); renaming it is an engine",
    note: 'PATCH /sessions/:id',
  },
  'SessionsService.updateConfig': {
    file: 'sessions/sessions.service.ts',
    snippet: '// Model, permission mode, effort, provider and account are all engine-path settings (§2.9 LS6).',
    note: 'PATCH /config',
  },
  'SessionsService.switchAccount': {
    file: 'sessions/sessions.service.ts',
    snippet: '// Switching the runner account a session runs on is an engine door (§2.9 LS6).',
    note: 'PATCH /account',
  },
  'SessionsService.mergeToMain': {
    file: 'sessions/sessions.service.ts',
    snippet:
      'requestedBy?: MergeRequester;\n    } = {},\n  ) {\n    await this.assertEngineSession(ownerId, id);',
    note: 'POST /merge and the runner merge door',
  },
  'SessionsService.startMergeRepair': {
    file: 'sessions/sessions.service.ts',
    snippet: 'assertEngineSessionRow(parent);',
    note: 'POST /merge-repair: a repair child of an engine session',
  },
  'SessionsService.commitWorktree': {
    file: 'sessions/sessions.service.ts',
    snippet: "assertEngineSessionRow(session);\n    if (session.isolationStatus !== 'worktree' || !session.branch) {",
    note: 'POST /commit',
  },
  'SessionsService.adoptWorktreeBranch': {
    file: 'sessions/sessions.service.ts',
    snippet: "assertEngineSessionRow(session);\n      if (session.isolationStatus !== 'worktree') {",
    note: 'POST /adopt-branch',
  },
  'SessionsService.decideApproval': {
    file: 'sessions/sessions.service.ts',
    snippet: '// Answering a tool-permission card is an engine door (§2.9 LS6).',
    note: 'POST /approvals/:approvalId/decision',
  },
  'SessionsService.refreshRecap': {
    file: 'sessions/sessions.service.ts',
    snippet: '// A landing writes no run_event, so every one of recap.ts\'s four gates would refuse it anyway;',
    note: 'POST /recap — the refusal is the structural one, not "too little to recap"',
  },
  'SessionsService.requestDiffRefresh': {
    file: 'sessions/sessions.service.ts',
    snippet: '// It queues a diff turn for the runner: an engine door like any other (§2.9 LS6).',
    note: 'POST /diff/refresh',
  },
  'SessionsService.steerQueuedTurn': {
    file: 'sessions/sessions.service.ts',
    snippet: 'assertEngineSessionRow(session);\n      if (session.deletedAt) {',
    note: 'POST /turns/:turnId/steer',
  },
  'SessionsService.armAutoRetry': {
    file: 'sessions/sessions.service.ts',
    snippet:
      'async armAutoRetry(ownerId: string, id: string, retryAt: string): Promise<{ retryAt: Date }> {\n    await this.assertEngineSession(ownerId, id);',
    note: 'POST /auto-retry',
  },
  'SessionsService.cancelAutoRetry': {
    file: 'sessions/sessions.service.ts',
    snippet: '// The claim too (migration 0354): the retry is over, so the session is not on its way to the',
    note: 'DELETE /auto-retry',
  },
  'SessionsService.pin': {
    file: 'sessions/sessions.service.ts',
    snippet:
      'async pin(ownerId: string, id: string) {\n    assertEngineSessionRow(await this.get(ownerId, id)); // ownership check (404s otherwise)',
    note: 'POST /pin',
  },
  'SessionsService.unpin': {
    file: 'sessions/sessions.service.ts',
    snippet:
      'async unpin(ownerId: string, id: string) {\n    assertEngineSessionRow(await this.get(ownerId, id)); // ownership check (404s otherwise)',
    note: 'DELETE /pin',
  },
  'SessionsService.move': {
    file: 'sessions/sessions.service.ts',
    snippet: 'assertEngineSessionRow(session);\n      if (workspaceId && workspaceId !== session.workspaceId) {',
    note: 'POST /move',
  },
  'SessionTagsService.setForSession': {
    file: 'session-tags/session-tags.service.ts',
    snippet: '// Tagging is a conversation affordance; the platform\'s landing container takes none (§2.9 LS6).',
    note: 'PUT /tags',
  },
  'MergeReceiptService.record': {
    file: 'sessions/merge-receipt.service.ts',
    snippet: '// A landing session has no branch of its own to record a merge against (§2.9 LS6).',
    note: 'POST /merge-receipts on both doors',
  },
  'AutoRetryService.resendRetryMessage': {
    file: 'sessions/auto-retry.service.ts',
    snippet: '// Re-sending is an engine door; a LANDING has no failed turn of its own to retry (§2.9 LS6).',
    note: 'POST /retry-message',
  },
  'ShareLinksService.put': {
    file: 'share-links/share-links.service.ts',
    snippet: '// A landing session is not a conversation anyone can share (§2.9 LS6).',
    note: 'POST and PUT /sessions/:id/share',
  },
  'ShareLinksService.turnOff': {
    file: 'share-links/share-links.service.ts',
    snippet: 'if (kind === \'SESSION\') assertEngineSession(root);\n    await this.end({ ownerId, ...rootColumn(kind, rootId) }, new Date());',
    note: 'DELETE /sessions/:id/share',
  },
  'AttachmentsService.create': {
    file: 'attachments/attachments.service.ts',
    snippet: '// An upload scoped to a session is an input to an engine turn; a LANDING takes none',
    note: 'POST /attachments?sessionId=',
  },
  'WatchesService.readTargets': {
    file: 'watches/watches.service.ts',
    snippet: '// A watch wakes a conversation; the platform drives a landing, so there is nothing to wake',
    note: 'POST /watches body observerSessionId',
  },
  'ProvidersService.recordCursorKeyCheck': {
    file: 'providers/providers.service.ts',
    snippet: '// Before the ownership answer, but only for a row of this runner\'s own account: another',
    note: 'POST /runner/sessions/:id/cursor-key-check (RunnerApiController, which leaves the check to the service)',
  },
  'RunnerApiController.assertSessionOwnership': {
    file: 'runner-api/runner-api.controller.ts',
    snippet: 'if (session && (ownerId === undefined || session.ownerId === ownerId)) assertEngineSessionRow(session);',
    note: 'the runner doors that load the row themselves: attachments, artifacts, approvals, wakes, a job\'s alert, naming, suggestion, diff',
  },
  'RunnerApiController.assertEngineSessionById': {
    file: 'runner-api/runner-api.controller.ts',
    snippet: 'return assertEngineSessionRowById(this.prisma, sessionId, ownerId);',
    note: 'the runner doors that name the session only by id: leases, pin, credential, reporting routes',
  },
  'RunnerApiController.assertNoLandingSessionNamed': {
    file: 'runner-api/runner-api.controller.ts',
    snippet: 'if (landing) assertEngineSessionRow(landing);',
    note: 'the three heartbeat body fields that name sessions',
  },
};

/** Every derived door and the guard site that refuses a LANDING for it. */
export const ENGINE_SESSION_DOORS: Readonly<Record<string, string>> = {
  // ── the user door (33) ────────────────────────────────────────────────────────────────────────
  'PATCH /sessions/:id': 'SessionsService.rename',
  'DELETE /sessions/:id': 'SessionsService.transitionEnd',
  'DELETE /sessions/:id/purge': 'SessionsService.purge',
  'POST /sessions/:id/diff/refresh': 'SessionsService.requestDiffRefresh',
  'POST /sessions/:id/recap': 'SessionsService.refreshRecap',
  'POST /sessions/:id/turns': 'SessionsService.createTurn',
  'POST /sessions/:id/turns/current-work-routing': 'SessionsService.createTurn',
  'DELETE /sessions/:id/turns/:turnId': 'SessionsService.getSendable',
  'POST /sessions/:id/turns/:turnId/steer': 'SessionsService.steerQueuedTurn',
  'POST /sessions/:id/resume': 'SessionsService.resume',
  'PATCH /sessions/:id/config': 'SessionsService.updateConfig',
  'PATCH /sessions/:id/account': 'SessionsService.switchAccount',
  'POST /sessions/:id/interrupt': 'SessionsService.interrupt',
  'POST /sessions/:id/end': 'SessionsService.getSendable',
  'POST /sessions/:id/merge': 'SessionsService.mergeToMain',
  'POST /sessions/:id/merge-repair': 'SessionsService.startMergeRepair',
  'POST /sessions/:id/merge-receipts': 'MergeReceiptService.record',
  'POST /sessions/:id/commit': 'SessionsService.commitWorktree',
  'POST /sessions/:id/adopt-branch': 'SessionsService.adoptWorktreeBranch',
  'POST /sessions/:id/retry-message': 'AutoRetryService.resendRetryMessage',
  'POST /sessions/:id/auto-retry': 'SessionsService.armAutoRetry',
  'DELETE /sessions/:id/auto-retry': 'SessionsService.cancelAutoRetry',
  'POST /sessions/:id/complete': 'SessionsService.transitionEnd',
  'POST /sessions/:id/archive': 'SessionsService.transitionEnd',
  'POST /sessions/:id/restore': 'SessionsService.restore',
  'POST /sessions/:id/pin': 'SessionsService.pin',
  'DELETE /sessions/:id/pin': 'SessionsService.unpin',
  'POST /sessions/:id/move': 'SessionsService.move',
  'PUT /sessions/:id/tags': 'SessionTagsService.setForSession',
  'POST /sessions/:id/approvals/:approvalId/decision': 'SessionsService.decideApproval',
  'POST /sessions/:id/share': 'ShareLinksService.put',
  'PUT /sessions/:id/share': 'ShareLinksService.put',
  'DELETE /sessions/:id/share': 'ShareLinksService.turnOff',

  // ── the runner door (30) ──────────────────────────────────────────────────────────────────────
  'POST /runner/sessions/:id/source/pin': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/takeover-leases': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/activate-leases': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/release-leases': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/orchestration-credential': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/attachments': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/artifacts/result': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/approvals': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/background-wake': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/notify': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/scheduled-wakeup': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/naming': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/cursor-key-check': 'ProvidersService.recordCursorKeyCheck',
  'POST /runner/sessions/:id/turns/:turnId/suggestion': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/turn-complete': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/events': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/finalize': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/complete': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/import-result': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/merge-result': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/commit-result': 'RunnerApiController.assertEngineSessionById',
  'POST /runner/sessions/:id/diff': 'RunnerApiController.assertSessionOwnership',
  'POST /runner/sessions/:id/turns': 'SessionsService.createTurn',
  'POST /runner/sessions/:id/interrupt': 'SessionsService.interrupt',
  'POST /runner/sessions/:id/merge': 'SessionsService.mergeToMain',
  'POST /runner/sessions/:id/merge-receipts': 'MergeReceiptService.record',
  'POST /runner/sessions/:id/end': 'SessionsService.getSendable',
  'POST /runner/sessions/:id/complete-session': 'SessionsService.transitionEnd',
  'DELETE /runner/sessions/:id': 'SessionsService.transitionEnd',
  'POST /runner/sessions/:id/archive': 'SessionsService.transitionEnd',
};

/**
 * The door a derived route is, split into method and path, for a reader that needs to match a
 * route to its guard. `paramsOf` is re-exported so the census and the isolation specs agree on
 * what "a path parameter" means.
 */
export function splitRoute(key: string): { method: string; path: string; params: string[] } {
  const [method, path] = key.split(' ');
  return { method, path, params: paramsOf(`${method} ${path}`) };
}

/** Whether the field-case extraction below found each declared case in its registry. Used by the
 *  census spec rather than at import time, so an import never throws. */
export function fieldCaseRegistryStatus(): Array<{ key: string; registered: boolean }> {
  return Object.keys(ENGINE_SESSION_FIELD_CASES).map((key) => ({
    key,
    registered: key in TENANT_ISOLATION_FIELD_CASES || key in RUNNER_ISOLATION_FIELD_CASES,
  }));
}
