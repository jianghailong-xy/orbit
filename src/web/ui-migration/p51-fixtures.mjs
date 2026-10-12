import { CODEX_RATE_LIMIT_RESET_CAPABILITY_V1, uuidToBase62 } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';
import { RUNNER, SESSION, SESSION_TIME, WORKSPACE } from './session-fixtures.mjs';

// P5.1 data, on top of installFixtures (later routes win, so every path not modeled here falls through to the P0
// handler and its unhandled-request check): an admin account, with or without a photo; three workspaces in the
// sidebar (the P0 one, one on an offline runner, one with a background job and a session waiting); the P0 session and
// a Codex session with a worktree — changed files, merge targets (a long list or a short one), a merge that conflicted
// or failed, a branch the workspace moved to — and its diffs; the Move panel's targets and folders; the ⌘K answers;
// the runner's Codex plan usage with an earned reset credit; and a second engine for the New Session picker. `state`
// is read on every request, so a test changes an answer before the step that asks. Synthetic, public test data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();
// A reset credit's own timestamps: ISO-8601 UTC in whole seconds (the snapshot's fetchedAt keeps its milliseconds).
const second = (offset) => at(offset).replace('.000Z', 'Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const P51_IDS = {
  offlineRunner: id('5101'), offlineWorkspace: id('5102'), busyWorkspace: id('5103'),
  codexSession: id('5111'), notesSession: id('5112'),
  folderRelease: id('5121'), folderBugs: id('5122'), folderMade: id('5123'), folderTarget: id('5124'),
  wikiEntry: id('5131'),
  resetOperation: 'Op5141',
};
export const P51_PATHS = {
  session: `/sessions/${SESSION.id}`, codex: `/sessions/${P51_IDS.codexSession}`,
  newSession: `/workspaces/${WORKSPACE.id}/new`, projects: '/projects',
};
export const P51_BRANCH = 'orbit/review-import-3fa21c';
export const RESET_FINGERPRINT = 'cxa1_92381c922ad04574cc61964161fd5687';
const LEASE = '6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12';

// ── the runners and workspaces the sidebar lists ───────────────────────────────────────────────────
const planUsage = {
  codex: {
    provider: 'codex',
    primary: { utilization: 92, windowDurationMins: 300, resetsAt: at(100 * MIN) },
    secondary: { utilization: 68, windowDurationMins: 7 * 24 * 60, resetsAt: at(4 * DAY) },
    rateLimitReset: {
      protocolVersion: 1, support: 'SUPPORTED', accountFingerprint: RESET_FINGERPRINT,
      rateLimitResetCredits: { availableCount: 2, credits: [
        { id: 'rlrc_fixture_1', resetType: 'codexRateLimits', status: 'available', grantedAt: second(-12 * DAY), expiresAt: second(6 * DAY), title: 'Earned reset', description: null },
        { id: 'rlrc_fixture_2', resetType: 'codexRateLimits', status: 'available', grantedAt: second(-3 * DAY), expiresAt: second(20 * DAY), title: 'Earned reset', description: null },
      ] },
      fetchedAt: at(-2 * MIN), generation: LEASE, sequence: 3,
    },
  },
};
const runner = () => ({
  ...RUNNER,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'yes' },
  ],
  capabilities: [CODEX_RATE_LIMIT_RESET_CAPABILITY_V1],
  heartbeatLeaseOwner: LEASE,
  heartbeatDraining: false,
  planUsage,
});
const OFFLINE_RUNNER = { id: P51_IDS.offlineRunner, name: 'studio-mac', displayName: 'Studio Mac', online: false, maxConcurrent: 2, activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }] };
const WORKSPACES = [
  WORKSPACE,
  { id: P51_IDS.busyWorkspace, name: 'wikova-develop', runnerId: RUNNER.id, createdAt: at(-2 * DAY), lastProvider: 'codex', provider: 'codex', model: null, effort: null,
    runner: { id: RUNNER.id, name: RUNNER.name } },
  { id: P51_IDS.offlineWorkspace, name: 'docs-site', runnerId: P51_IDS.offlineRunner, createdAt: at(-3 * DAY), lastProvider: 'claude', provider: 'claude', model: null, effort: null,
    runner: { id: P51_IDS.offlineRunner, name: 'studio-mac', displayName: 'Studio Mac' } },
];
const COUNTS = [
  { workspaceId: WORKSPACE.id, active: 1, running: 1, jobs: 0, needsYou: 0 },
  { workspaceId: P51_IDS.busyWorkspace, active: 1, running: 0, jobs: 2, needsYou: 1 },
  { workspaceId: P51_IDS.offlineWorkspace, active: 0, running: 0, jobs: 0, needsYou: 0 },
];

// ── the sessions ───────────────────────────────────────────────────────────────────────────────────
const FILES = [
  { path: 'src/web/src/components/SessionOutputs.tsx', additions: 48, deletions: 12, status: 'M' },
  { path: 'src/web/src/components/ui/Menu.tsx', additions: 27, deletions: 6, status: 'M' },
  { path: 'src/web/src/index.css', additions: 18, deletions: 21, status: 'M' },
  { path: 'docs/evidence/p5.1/README.md', additions: 64, deletions: 0, status: 'A' },
  { path: 'docs/evidence/p5.1/shots/menu.png', additions: -1, deletions: -1, status: 'A' },
];
const LONG_TARGETS = ['main', 'develop', 'release/1.0', 'release/1.1', 'release/2.0', 'staging', 'hotfix/login', 'feature/search',
  'feature/menus', 'feature/drawer', 'docs', 'experiments'];
const SHORT_TARGETS = ['main', 'develop', 'release/1.0'];
const PATCHES = {
  'src/web/src/components/SessionOutputs.tsx': [
    'diff --git a/src/web/src/components/SessionOutputs.tsx b/src/web/src/components/SessionOutputs.tsx',
    '@@ -1,6 +1,8 @@',
    " import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';",
    "-import { Drawer, Dropdown, Input, Segmented, theme, Tooltip } from 'antd';",
    "-import type { MenuProps } from 'antd';",
    " import { ExclamationCircleFilled, FullscreenExitOutlined, FullscreenOutlined } from '@ant-design/icons';",
    "+import { Drawer } from './ui/Drawer';",
    "+import { Menu, type MenuItem } from './ui/Menu';",
    "+import { Segmented } from './ui/Segmented';",
    "+import { Tooltip } from './ui/Tooltip';",
    " import { useQuery, useQueryClient } from '@tanstack/react-query';",
    '@@ -640,7 +642,7 @@ function MergeButton({',
    '   const showSearch = targets.length > 8;',
    '-  const { token } = theme.useToken();',
    '+  // The panel is the menu\'s own surface.',
    '   const q = targetQuery.trim().toLowerCase();',
  ].join('\n'),
  'src/web/src/components/ui/Menu.tsx': [
    '@@ -20,4 +20,6 @@ interface MenuAction {',
    '   children?: MenuItem[];',
    '+  /** A class on the item itself. */',
    '+  className?: string;',
    "   type?: 'item';",
    ' }',
  ].join('\n'),
  'src/web/src/index.css': [
    '@@ -4086,9 +4086,6 @@',
    '-.wt-merge-menu-panel {',
    '-  overflow: hidden;',
    '+.wt-merge-menu.orbit-menu {',
    '   min-width: 208px;',
    ' }',
  ].join('\n'),
  'docs/evidence/p5.1/README.md': ['@@ -0,0 +1,3 @@', '+# P5.1', '+', '+Session navigation, search and outputs.'].join('\n'),
};

function codexDetail(state) {
  const diverged = state.merge === 'diverged';
  return {
    ...SESSION,
    id: P51_IDS.codexSession, title: 'Move the merge menu onto Orbit components', provider: 'codex',
    workspaceId: WORKSPACE.id, workspace: { ...WORKSPACE, defaultMergeTarget: null },
    isolationStatus: 'worktree', branch: P51_BRANCH, baseSha: 'a'.repeat(40), changedFiles: FILES,
    worktreeDirty: false, mergeTarget: state.merge === 'conflict' || state.merge === 'error' ? 'main' : null,
    mergeTargets: state.targets === 'short' ? SHORT_TARGETS : LONG_TARGETS,
    mergeStatus: state.merge === 'conflict' ? 'conflict' : state.merge === 'error' ? 'error' : null,
    mergeError: state.merge === 'error' ? 'main has uncommitted changes in the checkout at /srv/orbit; commit or stash them, then retry.' : null,
    branchMerged: false, worktreeBranch: diverged ? 'fix/menu-footer' : P51_BRANCH,
  };
}
const codexRow = () => ({
  ...SESSION, id: P51_IDS.codexSession, title: 'Move the merge menu onto Orbit components', provider: 'codex',
  workspaceId: WORKSPACE.id, workspace: WORKSPACE, updatedAt: at(-5 * MIN), lastTurnAt: at(-5 * MIN),
});
const notesRow = () => ({
  ...SESSION, id: P51_IDS.notesSession, title: 'Write the release notes', provider: 'claude', folderId: P51_IDS.folderRelease,
  status: 'COMPLETED', runState: 'COMPLETED', updatedAt: at(-2 * HOUR), lastTurnAt: at(-2 * HOUR),
});
const FOLDERS = [
  { id: P51_IDS.folderRelease, workspaceId: WORKSPACE.id, name: 'Release', position: 0, createdAt: at(-5 * DAY) },
  { id: P51_IDS.folderBugs, workspaceId: WORKSPACE.id, name: 'Bugs', position: 1, createdAt: at(-4 * DAY) },
];
const moveTargets = (state) => ({
  workspaceId: WORKSPACE.id, folderId: null,
  folders: [
    { id: P51_IDS.folderRelease, name: 'Release', sessionCount: 2 },
    { id: P51_IDS.folderBugs, name: 'Bugs', sessionCount: 5 },
    ...state.madeFolders.map((folder) => ({ id: folder.id, name: folder.name, sessionCount: 0 })),
  ],
  reason: null, needsEnd: true, branch: P51_BRANCH, changedFiles: 3, unmergedFiles: 3, mergeTarget: 'main',
  targets: [
    { workspaceId: P51_IDS.busyWorkspace, name: 'wikova-develop', provider: 'codex', runnerId: RUNNER.id, runnerName: RUNNER.name,
      runnerOnline: true, workDir: '/srv/wikova-develop', reason: null, conversation: 'continues',
      folders: [{ id: P51_IDS.folderTarget, name: 'Reviews', sessionCount: 12 }] },
    { workspaceId: P51_IDS.offlineWorkspace, name: 'docs-site', provider: 'claude', runnerId: P51_IDS.offlineRunner, runnerName: 'Studio Mac',
      runnerOnline: false, workDir: '/Users/me/docs-site', reason: null, conversation: 'rebuilt', folders: [] },
    { workspaceId: id('5104'), name: 'HPC', provider: 'claude', runnerId: id('5105'), runnerName: 'HPC',
      runnerOnline: true, workDir: null, reason: 'Update HPC to move sessions here', conversation: 'rebuilt', folders: [] },
  ],
});

// ── ⌘K ─────────────────────────────────────────────────────────────────────────────────────────────
const SESSION_HITS = [
  { ...SESSION, matchField: 'title', snippet: null, agent: { id: WORKSPACE.id, name: WORKSPACE.name } },
  { ...codexRow(), matchField: 'message', snippet: '…the merge menu keeps its search at the bottom…', agent: { id: WORKSPACE.id, name: WORKSPACE.name } },
  { ...notesRow(), lifecycleState: 'COMPLETED', matchField: 'branch', snippet: 'orbit/release-notes-77a01b', agent: { id: WORKSPACE.id, name: WORKSPACE.name } },
];
const WIKI_HITS = [
  { id: P51_IDS.wikiEntry, kind: 'decision', title: 'Menus open with focus inside', summary: 'The Orbit Menu convention.', trust: 'confirmed',
    anchorState: 'verified', anchorCheckedRef: 'b'.repeat(40), match: ['keyword'], score: 0.04, spaceSlug: 'orbit', topics: ['ui-migration'] },
];

/** The reset operation settled as the user API renders a success (codexResetCredit.fixtures.ts resetOperation), before
 *  the usage snapshot was read (fetchedAt is two minutes back): that read already counts it, so the entry comes back. */
export function resetSucceeded(state) {
  Object.assign(state.resetOperation, { status: 'SUCCEEDED', consumeState: 'CONFIRMED', consumeOutcome: 'reset', refreshState: 'SUCCEEDED',
    consumeConfirmedAt: at(-3 * MIN), completedAt: at(-3 * MIN), updatedAt: at(-3 * MIN) });
}

/** Hold a response until `release()`, so a loading state can be captured without a race. */
export function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

export async function installP51Fixtures(page, { theme = 'light', ...initial } = {}) {
  const state = {
    avatar: false, targets: 'long', merge: null, searchHold: null, endHold: null, madeFolders: [], ended: false,
    resetOperation: null, resetUnanswered: false, ...initial,
  };
  // An admin, so the account menu has every row; the theme preference is the project's colour scheme, as P0's.
  const account = { id: FIXTURE_IDS.user, name: 'Baseline Reviewer', email: 'reviewer@example.test', createdAt: '2026-09-27T10:00:00.000Z',
    role: 'ADMIN', preferences: { theme, defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true } };
  const requests = [];
  const avatar = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64');
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    const body = () => { try { return request.postDataJSON(); } catch { return request.postData(); } };
    const note = () => requests.push({ method, path, query: searchParams.toString() || undefined, body: method === 'GET' ? undefined : body() });

    // main 94025579b (managed runners): a server from before the read answers 404, which the app takes as no capability.
    if (method === 'GET' && path === '/api/auth/capabilities') return json({ message: 'Cannot GET /api/auth/capabilities' }, 404);

    // ── the account
    if (method === 'GET' && path === '/api/users/me') return json({ ...account, avatarUpdatedAt: state.avatar ? FIXED_NOW : null });
    if (method === 'PATCH' && path === '/api/users/me/preferences') {
      note();
      Object.assign(account.preferences, body());
      return json({ ...account, avatarUpdatedAt: state.avatar ? FIXED_NOW : null });
    }
    if (method === 'GET' && path === '/api/users/me/avatar') return route.fulfill({ status: 200, contentType: 'image/png', body: avatar });

    // ── the sidebar's runners, workspaces and counts
    if (method === 'GET' && path === '/api/runners') return json([runner(), OFFLINE_RUNNER]);
    if (method === 'GET' && path === `/api/runners/${RUNNER.id}`) return json(runner());
    if (method === 'GET' && path === '/api/workspaces') return json(WORKSPACES);
    if (method === 'GET' && path === '/api/sessions/counts') return json(COUNTS);

    // ── sessions
    if (method === 'GET' && path === '/api/sessions') return json([SESSION, codexRow(), notesRow()]);
    if (method === 'GET' && path === '/api/session-folders') return json(FOLDERS);
    if (method === 'GET' && path === `/api/sessions/${P51_IDS.codexSession}`) return json(codexDetail(state));
    if (method === 'GET' && path === `/api/sessions/${P51_IDS.codexSession}/events/page`) return json({ events: [], hasMore: false });
    if (method === 'GET' && ['/turns', '/approvals', '/background'].some((suffix) => path === `/api/sessions/${P51_IDS.codexSession}${suffix}`)) return json([]);
    if (method === 'GET' && path === `/api/sessions/${P51_IDS.codexSession}/created-tasks`) return json({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
    if (method === 'GET' && path === `/api/sessions/${P51_IDS.codexSession}/diff`) {
      return json({ files: FILES, patches: FILES.filter((file) => PATCHES[file.path]).map((file) => ({ path: file.path, patch: PATCHES[file.path] })) });
    }
    if (method === 'POST' && path === `/api/sessions/${P51_IDS.codexSession}/diff/refresh`) { note(); return json({ ok: true }); }
    if (method === 'POST' && path === `/api/sessions/${P51_IDS.codexSession}/merge`) { note(); return json({ ok: true }); }
    if (method === 'POST' && path === `/api/sessions/${P51_IDS.codexSession}/adopt-branch`) { note(); return json({ ok: true }); }

    // ── Move
    if (method === 'GET' && path.endsWith('/move-targets')) return json(moveTargets(state));
    if (method === 'POST' && path === '/api/session-folders') {
      note();
      const folder = { id: P51_IDS.folderMade, workspaceId: body().workspaceId, name: body().name, position: 2, createdAt: SESSION_TIME };
      state.madeFolders.push(folder);
      return json(folder);
    }
    // End and Move ends the session first and waits until the server says it has ended.
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/end`) {
      note();
      if (state.endHold) await state.endHold.promise;
      state.ended = true;
      return json({ ok: true });
    }
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}` && state.ended) {
      return json({ ...SESSION, status: 'COMPLETED', runState: 'COMPLETED', sessionState: 'COMPLETED', runStatus: 'COMPLETED' });
    }
    if (method === 'POST' && path.endsWith('/move')) { note(); return json({ ok: true }); }

    // ── ⌘K
    if (method === 'GET' && path === '/api/sessions/search') {
      note();
      if (state.searchHold) await state.searchHold.promise;
      const q = searchParams.get('q') ?? '';
      const hits = !q ? SESSION_HITS : q === 'nothing' ? [] : SESSION_HITS.filter((hit) => /merge|review|release/i.test(q));
      return json({ q, contentSearched: q.length >= 3, total: hits.length, hits });
    }
    if (method === 'GET' && path === '/api/wiki/search') {
      note();
      const q = searchParams.get('q') ?? '';
      return json({ q, semantic: false, hits: /menu|merge/i.test(q) ? WIKI_HITS : [] });
    }

    // ── the reset credit
    const RESET = `/api/runners/${RUNNER.id}/codex-rate-limit-reset`;
    if (method === 'GET' && path === RESET) {
      const op = state.resetOperation;
      return json({ active: op && ['PENDING', 'CONSUMING', 'REFRESHING'].includes(op.status) ? op : null, latest: op });
    }
    if (method === 'POST' && path === RESET) {
      note();
      // A create nobody answers: the page sends it again under the same clientRequestId, then hands Retry to the user.
      if (state.resetUnanswered) return route.abort('failed');
      const asked = body();
      // A PENDING operation as the user API renders it (codexResetCredit.fixtures.ts resetOperation), with its public-id twins.
      state.resetOperation = {
        id: P51_IDS.resetOperation, publicId: P51_IDS.resetOperation, runnerId: RUNNER.id, runnerPublicId: RUNNER.id,
        clientRequestId: asked.clientRequestId, accountFingerprint: asked.accountFingerprint, status: 'PENDING',
        failureCode: null, lastErrorCode: null, createdAt: FIXED_NOW, updatedAt: FIXED_NOW, consumeConfirmedAt: null, completedAt: null,
        consumeState: 'PENDING', consumeOutcome: null, refreshState: 'NONE',
      };
      return json({ operation: state.resetOperation, replayed: false });
    }
    if (method === 'GET' && path === `${RESET}/${P51_IDS.resetOperation}`) return json(state.resetOperation);

    return route.fallback();
  });
  return { state, requests };
}
