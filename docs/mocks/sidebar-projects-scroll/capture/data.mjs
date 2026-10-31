// Sample account for the sidebar-scroll board: the shape of the owner's screenshot (13 workspaces,
// 24 open projects) with made-up names, because the repo is public.
const K = '/var/tmp/sidebar-scroll-mock';
const { uuidToBase62 } = await import(`${K}/today/src/shared/dist/index.js`);
const uid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const T = '2026-09-27T10:00:00.000Z';

const runner = (n, name) => ({
  id: uid(9000 + n), name, online: true, maxConcurrent: 2, activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }], commands: [], skills: [],
});
export const RUNNERS = [
  runner(1, 'build-01'), runner(2, 'cloud-sg'), runner(3, 'mac-mini.local'),
  runner(4, 'workstation'), runner(5, 'load-test-2'), runner(6, 'laptop'),
];
const R = Object.fromEntries(RUNNERS.map((r) => [r.name, r.id]));

const WS = [
  ['api-develop', 'build-01'], ['api-prod', 'cloud-sg'], ['ios-app', 'mac-mini.local'],
  ['data-pipeline', 'workstation'], ['web-develop', 'cloud-sg'], ['web-prod', 'cloud-sg'],
  ['build-01', 'build-01'], ['ml-train', 'workstation'], ['docs-site', 'workstation'],
  ['security-audit', 'build-01'], ['notify-service', 'cloud-sg'], ['load-test', 'load-test-2'],
  ['orbit', 'laptop'],
];
export const WORKSPACES = WS.map(([name, machine], i) => ({
  id: uid(8000 + i), name, runnerId: R[machine], position: i, createdAt: T,
  lastProvider: 'claude', provider: 'claude', model: null, effort: null,
}));
// A few live marks, as on the owner's rows: work in flight on three, nothing waiting.
const live = { 0: { running: 1 }, 1: { jobs: 1 }, 12: { running: 1 } };
export const COUNTS = WORKSPACES.map((w, i) => ({
  workspaceId: w.id, active: live[i] ? 1 : 0, running: live[i]?.running ?? 0, jobs: live[i]?.jobs ?? 0, needsYou: 0,
}));

const TITLES = [
  'Checkout page redesign', 'Billing export to CSV', 'Search results ranking', 'Onboarding emails',
  'Dark mode for settings', 'API rate limits', 'Audit log retention', 'Android offline drafts',
  'Release notes generator', 'Team invitations by link', 'Image upload resizing', 'Push notification digest',
  'Database index cleanup', 'Error page copy pass', 'SSO for enterprise plans', 'Calendar sync',
  'CSV import validation', 'Usage dashboard charts', 'Webhook retries', 'Accessibility audit fixes',
  'Mobile tab bar polish', 'Session timeout settings', 'Localization pipeline', 'Status page migration',
];
const working = new Set([1, 2, 6, 23]);
export const PROJECTS = TITLES.map((title, i) => ({
  id: uid(7000 + i), title, status: 'OPEN', createdAt: T, startedAt: T,
  // Newest activity first, so the sidebar keeps this order after the one waiting on you.
  lastActivityAt: new Date(Date.parse('2026-09-28T11:59:00.000Z') - i * 3_600_000).toISOString(),
  buckets: { running: working.has(i) ? 1 : 0 },
  attention: {
    ownerItems: i === 0 ? [{ kind: 'COORDINATOR_QUESTION', count: 1, oldestAt: T }] : [],
    startRequest: null, doneRequest: null,
  },
  coordinatorActivity: null, integration: null, mainBranch: 'main',
}));
