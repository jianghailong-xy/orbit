// Sample account for the sidebar-scroll board 03: the shape of the owner's 11-12 screenshot
// (12 workspaces, 4 wikis, 39 open projects) with made-up names, because the repo is public.
const K = '/var/tmp/sbs2';
const { uuidToBase62 } = await import(`${K}/today/src/shared/dist/index.js`);
const uid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const T = '2026-09-01T10:00:00.000Z';
const NOW = Date.parse('2026-09-28T12:00:00.000Z'); // the fixtures' frozen clock

const runner = (n, name) => ({
  id: uid(9000 + n), name, online: true, maxConcurrent: 2, activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }], commands: [], skills: [],
});
export const RUNNERS = [runner(1, 'build-01'), runner(2, 'cloud-sg'), runner(3, 'mac-mini'), runner(4, 'workstation'), runner(5, 'laptop')];
const R = Object.fromEntries(RUNNERS.map((r) => [r.name, r.id]));
const WS = [
  ['api-develop', 'build-01'], ['api-prod', 'cloud-sg'], ['ios-app', 'mac-mini'], ['data-pipeline', 'workstation'],
  ['web-develop', 'cloud-sg'], ['web-prod', 'cloud-sg'], ['build-01', 'build-01'], ['ml-train', 'workstation'],
  ['docs-site', 'workstation'], ['security-audit', 'build-01'], ['notify-service', 'cloud-sg'], ['orbit', 'laptop'],
];
export const WORKSPACES = WS.map(([name, machine], i) => ({
  id: uid(8000 + i), name, runnerId: R[machine], position: i, createdAt: T,
  lastProvider: 'claude', provider: 'claude', model: null, effort: null,
}));
const live = { 0: { running: 1 } };
export const COUNTS = WORKSPACES.map((w, i) => ({
  workspaceId: w.id, active: live[i] ? 1 : 0, running: live[i]?.running ?? 0, jobs: 0, needsYou: 0,
}));

export const WIKIS = ['build-tools', 'orbit', 'storefront', 'orbit · preview'].map((slug, i) => ({
  id: uid(6000 + i), slug: slug.replace(/[^a-z]+/g, '-'), title: slug, repoUrlNorm: `github.com/example/${slug.replace(/[^a-z]+/g, '-')}`,
  rootCommitSha: 'b'.repeat(40), createdAt: T, updatedAt: T, pendingOps: 0,
  settings: { push: true, autoAcceptReinforce: true, maintenance: { enabled: false } },
  usage: { days: 7, sessionsPushed: 0, searches: 0, gets: 0, entries: [] },
}));

const TITLES = [
  'Checkout page redesign', 'SSO for enterprise plans', 'Billing export to CSV', 'Search results ranking',
  'Settings redesign', 'Session guests', 'Runners on other hosts', 'Sub-agent routing',
  'Onboarding emails', 'Dark mode for settings', 'API rate limits', 'Audit log retention',
  'Android offline drafts', 'Release notes generator', 'Team invitations by link', 'Image upload resizing',
  'Push notification digest', 'Database index cleanup', 'Error page copy pass', 'Calendar sync',
  'CSV import validation', 'Usage dashboard charts', 'Webhook retries', 'Accessibility audit fixes',
  'Mobile tab bar polish', 'Session timeout settings', 'Localization pipeline', 'Status page migration',
  'Crawl data pipeline', 'Search index rebuild', 'Invoice PDF layout', 'Feature flag cleanup',
  'Admin audit view', 'Password reset flow', 'Upload retry queue', 'Team billing page',
  'Docs site search', 'Signup funnel metrics', 'Workspace templates',
];
// 2 waiting on you, 6 with work in flight, 2 more touched today; the other 29 quiet for days.
const waiting = { 0: 1, 1: 2 };
const working = new Set([2, 3, 4, 5, 6, 7]);
export const PROJECTS = TITLES.map((title, i) => ({
  id: uid(7000 + i), title, status: 'OPEN', createdAt: T, startedAt: T,
  lastActivityAt: new Date(i < 10 ? NOW - (i + 1) * 90 * 60_000 : NOW - (30 + i * 9) * 3_600_000).toISOString(),
  buckets: { running: working.has(i) ? 1 : 0 },
  attention: {
    ownerItems: waiting[i] ? [{ kind: 'COORDINATOR_QUESTION', count: waiting[i], oldestAt: T }] : [],
    startRequest: null, doneRequest: null,
  },
  coordinatorActivity: null, integration: null, mainBranch: 'main',
}));
