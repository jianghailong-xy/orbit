import { readFileSync } from 'node:fs';
import { uuidToBase62, WIKI_DEFAULT_SPACE_SETTINGS } from '@orbit/shared';
import { FIXED_NOW, FIXTURE_IDS } from './fixtures.mjs';
import { RUNNER, SESSION as P0_SESSION, WORKSPACE } from './session-fixtures.mjs';

// P4.4 data: one wiki space ("orbit") with its home, a written document with marks and footnotes, a topic
// article, the entry drawer, Review (add, amend, challenge and retire proposals), the plan (a confirmed
// version, a newer draft and its proposals — or none at all), settings (maintenance off or on) and
// Activity with a run; the space's public link and its pages; Settings → Shared links in every state;
// Following with watches in every tab; and the watches of the P0 task and the P0 conversation. The
// documents, the plan and the runs are the shared fixtures OrbitKit is held to (src/shared/src/
// wiki-docs.fixture.json, wiki-articles.fixture.json, wiki-review-mode.fixture.json). Registered on top of
// installFixtures (later routes win), so every path not modeled here falls through to the P0 handler and
// its unhandled-request check. `state` is read on every request, so a test changes an answer before the
// step that asks. Synthetic, public test data only.
const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const shared = (name) => JSON.parse(readFileSync(new URL(`../../shared/src/${name}`, import.meta.url), 'utf8'));
const now = Date.parse(FIXED_NOW);
const at = (offset) => new Date(now + offset).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const earlier = '2026-09-27T10:00:00.000Z';

const DOCS = shared('wiki-docs.fixture.json');
const ARTICLES = shared('wiki-articles.fixture.json');
const REVIEW_MODE = shared('wiki-review-mode.fixture.json');

const SPACE_ID = FIXTURE_IDS.space;
export const WIKI_TOKEN = 'uiMigrationP44Wiki20260928';
export const P44_IDS = {
  space: SPACE_ID,
  unreviewed: id('4401'), auto: id('4402'), confirmed: id('4403'), principle: id('4404'), challenged: id('4405'),
  retiring: id('4406'), mockups: id('4407'), chromium: id('4408'), extract: id('4409'),
  agentChangeset: id('4421'), addOp: id('4422'), amendOp: id('4423'), secondAdd: id('4424'),
  maintenanceChangeset: id('4425'), challengeOp: id('4426'), retireChangeset: id('4427'), retireOp: id('4428'),
  searchHit: id('4441'),
  linkStaleA: id('4451'), linkStaleB: id('4452'), linkStaleC: id('4453'), linkRecent: id('4454'), linkOpen: id('4455'),
  linkTask: id('4456'), linkWiki: id('4457'), linkProject: id('4458'), linkPaused: id('4459'), linkOff: id('4460'), linkExpired: id('4461'),
  watchTask: id('4471'), watchSession: id('4472'), watchPaused: id('4473'), watchExpired: id('4474'), watchMatched: id('4475'),
  watchOnTask: id('4476'), watchOnTaskEnded: id('4477'), watchFromSession: id('4478'), watchOnSession: id('4479'), created: id('4480'),
  otherSession: id('4490'), otherTask: id('4491'),
};
const DOC = DOCS.docs.doc.read;
const NOT_WRITTEN = DOCS.docs.notWritten.read;
const RUNS = REVIEW_MODE.runs.map((run) => ({ ...run.view, spaceId: SPACE_ID }));
export const P44_PATHS = {
  home: '/wiki/orbit', doc: `/wiki/orbit/d/${DOC.slug}`, article: '/wiki/orbit/t/ui-design/1',
  entry: `/wiki/orbit/e/${P44_IDS.unreviewed}`, review: '/wiki/review', plan: '/wiki/orbit/plan',
  settings: '/wiki/orbit/settings', activity: '/wiki/orbit/activity', run: `/wiki/orbit/run/${RUNS[0].id}`,
  sharedLinks: '/settings/shared-links', following: '/following',
  sharedWiki: `/s/${WIKI_TOKEN}`, sharedWikiDoc: `/s/${WIKI_TOKEN}/d/session-runtime`,
  task: `/tasks/${FIXTURE_IDS.task}`, session: `/sessions/${P0_SESSION.id}`, landing: '/',
};
export const P44_DOC = DOC;
export const P44_RUNS = RUNS;
export const DECIDE_REFUSAL = 'The proposal changed while you were editing it; read Review again.';
export const PLAN_REFUSAL = { path: 'docs[2].sections[0].kind', message: 'a section kind the plan does not know' };

// ── the space ───────────────────────────────────────────────────────────────────────────────────────
const MAINTENANCE_ON = { enabled: true, workspaceId: WORKSPACE.id, provider: 'local-vllm', dailyRunLimit: 8, lookbackDays: 14, listId: null };
function space(state) {
  return {
    id: SPACE_ID, slug: 'orbit', title: 'Orbit knowledge', repoUrlNorm: 'github.com/example/orbit', rootCommitSha: 'b'.repeat(40),
    createdAt: earlier, updatedAt: earlier, pendingOps: pendingOps(state),
    settings: {
      ...WIKI_DEFAULT_SPACE_SETTINGS, reviewMode: state.reviewMode, automaticSpotChecks: state.spotChecks,
      maintenance: state.maintenance === 'on' ? MAINTENANCE_ON : { enabled: false },
    },
    usage: { days: 7, sessionsPushed: 12, searches: 4, gets: 3, entries: [] },
  };
}

const entryBase = {
  spaceId: SPACE_ID, status: 'active', currentRevision: 1, fields: {}, aliases: [], anchors: [], anchorState: 'verified',
  anchorCheckedRef: '1588c3b'.padEnd(40, '0'), anchorCheckedAt: earlier, tainted: false, challenged: false, unsupported: false,
  pinned: false, supersedesId: null, supersededById: null, validFrom: '2026-09-20T00:00:00.000Z', validTo: null,
  recordedAt: '2026-09-20T00:00:00.000Z', retiredAt: null,
};
const ENTRIES = [
  { id: P44_IDS.principle, kind: 'principle', trust: 'owner', title: 'Preserve visible behavior', summary: 'A component migration keeps the user experience stable.',
    fields: { statement: 'Preserve visible behavior.', rationale: 'Users depend on familiar controls.' }, topics: ['ui-migration'] },
  { id: P44_IDS.unreviewed, kind: 'pitfall', trust: 'unreviewed', title: 'captureBeyondViewport shifts the screenshot',
    summary: 'Set it false and clip by the element rect.', fields: { symptom: 'side-by-side shots are offset', cause: 'a reflow', fix: 'set it false' },
    topics: ['ui-design'], anchorState: 'unchecked', anchorCheckedRef: null, anchorCheckedAt: null, validFrom: '2026-09-28T05:00:00.000Z', recordedAt: '2026-09-28T05:00:00.000Z' },
  { id: P44_IDS.auto, kind: 'recipe', trust: 'auto', title: 'Render a mock page to PNG with headless Chromium',
    summary: 'Write the mock as HTML, then take the screenshot at twice the pixel ratio.', topics: ['ui-design'] },
  { id: P44_IDS.confirmed, kind: 'convention', trust: 'confirmed', title: 'Draw a mock before changing the interface',
    summary: 'The owner picks between the options drawn side by side.', topics: ['ui-design'], currentRevision: 3 },
  { id: P44_IDS.challenged, kind: 'pitfall', trust: 'confirmed', title: 'wikiAnchorMark reads the anchor state',
    summary: 'A verified anchor shows the ref it was checked at.', topics: ['web-client'], challenged: true, anchorState: 'missing', currentRevision: 2,
    fields: { symptom: 'the badge says Checked', cause: 'no ref', fix: 'pass the ref' } },
  { id: P44_IDS.retiring, kind: 'convention', trust: 'confirmed', title: 'Mocks live in a folder of their own',
    summary: 'Every mock goes under docs/mocks, one folder per feature.', topics: ['ui-design'] },
].map((entry) => ({ ...entryBase, ...entry }));
const entryById = (raw) => {
  const key = decodeURIComponent(raw);
  return ENTRIES.find((entry) => entry.id === key) ?? ARTICLE_ENTRIES.find((entry) => entry.id === key) ?? null;
};
const MAIN_REF = `1588c3b${'0'.repeat(33)}`;
function detail(entry) {
  const anchors = entry.id === P44_IDS.challenged
    ? [
      { type: 'symbol', path: 'src/web/src/lib/wiki.ts', symbol: 'wikiAnchorMark', check: { state: 'changed', ref: MAIN_REF, at: '2026-09-28T01:00:00.000Z' } },
      { type: 'commit', sha: `abcdef0${'2'.repeat(33)}`, check: { state: 'missing', ref: MAIN_REF, at: '2026-09-28T01:00:00.000Z' } },
      { type: 'path', path: 'src/web/src/lib/wiki.ts', check: { state: 'verified', ref: MAIN_REF, at: '2026-09-28T01:00:00.000Z' } },
    ]
    : entry.id === P44_IDS.unreviewed
      ? [
        { type: 'path', path: 'src/web/ui-migration/harness.mjs', check: { state: 'verified', ref: MAIN_REF, at: '2026-09-28T01:00:00.000Z' } },
        { type: 'symbol', path: 'src/web/ui-migration/harness.mjs', symbol: 'capture', check: { state: 'changed', ref: MAIN_REF, at: '2026-09-28T01:00:00.000Z' } },
      ]
      : [];
  const revision = (n, authorKind, hoursAgo) => ({
    id: `${entry.id}-rev-${n}`, entryId: entry.id, revision: n, title: entry.title, summary: entry.summary, fields: entry.fields, topics: entry.topics,
    aliases: [], anchors: [], contentSha256: 'f'.repeat(64), authorKind, authorUserId: null, authorSessionId: null, authorToolCallId: null,
    changesetOpId: null, createdAt: at(-hoursAgo * HOUR),
  });
  return {
    ...entry,
    anchors,
    sources: entry.id === P44_IDS.unreviewed || entry.id === P44_IDS.chromium
      ? [
        { id: `${entry.id}-s1`, kind: 'turn', ref: P0_SESSION.id, locator: { turnId: 't1' }, quote: 'clip by the element rect', quoteVerified: true, state: 'live', tainted: false, createdAt: earlier },
        { id: `${entry.id}-s2`, kind: 'commit', ref: 'c'.repeat(40), locator: {}, quote: null, quoteVerified: false, state: 'live', tainted: false, createdAt: earlier },
      ]
      : [],
    history: entry.id === P44_IDS.unreviewed ? [revision(1, 'maintenance', 2)] : [revision(2, 'owner', 5), revision(1, 'agent', 30)],
    exposure: entry.id === P44_IDS.unreviewed ? [] : [
      { channel: 'push', sessionId: P0_SESSION.id, at: at(-3 * HOUR) },
      { channel: 'get', sessionId: P0_SESSION.id, at: at(-26 * HOUR) },
    ],
    verification: null,
  };
}

// ── Review ──────────────────────────────────────────────────────────────────────────────────────────
const op = (over) => ({
  seq: 0, entryId: null, baseRevision: null, payload: {}, similar: [], tainted: false, decision: 'pending', decisionReason: null, decisionNote: null,
  resultEntryId: null, resultRevision: null, decidedAt: null, appliedByMode: null, spotCheck: false, ...over,
});
function queue() {
  return [
    {
      id: P44_IDS.agentChangeset, spaceId: SPACE_ID, origin: 'agent', sessionId: P0_SESSION.id, toolCallId: null, rationale: 'a session hit it twice',
      status: 'pending', createdAt: at(-40 * MIN), decidedAt: null, expiresAt: null,
      ops: [
        op({ id: P44_IDS.addOp, changesetId: P44_IDS.agentChangeset, op: 'add',
          payload: { entry: { kind: 'pitfall', title: 'Secret redaction lets ENV_VAR=value secrets through', summary: 'A watch delivery stores the value unredacted.', fields: {}, anchors: [] } } }),
        op({ id: P44_IDS.amendOp, changesetId: P44_IDS.agentChangeset, seq: 1, op: 'amend', entryId: P44_IDS.confirmed, baseRevision: 3,
          payload: { changes: { summary: 'The owner picks between the options drawn side by side, at both widths.' } } }),
        op({ id: P44_IDS.secondAdd, changesetId: P44_IDS.agentChangeset, seq: 2, op: 'add', tainted: true,
          payload: { entry: { kind: 'recipe', title: 'Pin the browser build before taking baselines', summary: 'A browser update moves glyphs by a pixel.', fields: {}, anchors: [] } } }),
      ],
    },
    {
      id: P44_IDS.maintenanceChangeset, spaceId: SPACE_ID, origin: 'maintenance', sessionId: null, toolCallId: null, rationale: 'Anchor re-verification on origin/main',
      status: 'pending', createdAt: at(-2 * HOUR), decidedAt: null, expiresAt: null,
      ops: [op({ id: P44_IDS.challengeOp, changesetId: P44_IDS.maintenanceChangeset, op: 'challenge', entryId: P44_IDS.challenged,
        payload: { reason: `Anchor re-verification on origin/main at ${MAIN_REF}: symbol wikiAnchorMark in src/web/src/lib/wiki.ts has changed.` } })],
    },
    {
      id: P44_IDS.retireChangeset, spaceId: SPACE_ID, origin: 'agent', sessionId: P0_SESSION.id, toolCallId: null, rationale: 'the folder moved',
      status: 'pending', createdAt: at(-5 * HOUR), decidedAt: null, expiresAt: null,
      ops: [op({ id: P44_IDS.retireOp, changesetId: P44_IDS.retireChangeset, op: 'retire', entryId: P44_IDS.retiring,
        payload: { reason: 'Mocks now sit beside the page they draw.' } })],
    },
  ];
}
const pendingOps = (state) => state.queue.flatMap((changeset) => changeset.ops).filter((one) => one.decision === 'pending').length;

// ── the documents and the plan ──────────────────────────────────────────────────────────────────────
const linkable = (job) => job && ({ ...job, sessionId: job.sessionId ? P0_SESSION.id : null, waitingFor: job.waitingFor ? { ...job.waitingFor, sessionId: P0_SESSION.id } : null });
const PROPOSALS = DOCS.plan.proposals.map((proposal) => ({
  ...proposal,
  facts: proposal.facts.map((fact) => (fact.kind === 'entry' ? { ...fact, id: P44_IDS.confirmed } : fact.kind === 'session' ? { ...fact, id: P0_SESSION.id } : fact)),
}));
function planState(state) {
  if (state.plan === 'none') return { spaceId: SPACE_ID, confirmed: null, draft: null, proposals: [], job: null };
  return { spaceId: SPACE_ID, confirmed: DOCS.plan.versions.v1, draft: DOCS.plan.versions.v2, proposals: PROPOSALS, job: linkable(DOCS.plan.jobs.built) };
}

// ── the topic article (the unit test's, in English) ─────────────────────────────────────────────────
const articleEntry = (over) => ({ ...entryBase, fields: {}, topics: ['ui-design'], ...over });
const ARTICLE_ENTRIES = [
  articleEntry({ id: P44_IDS.mockups, kind: 'convention', trust: 'confirmed', title: 'Show a mock with options before changing the interface', summary: 'The owner picks one.', validFrom: '2026-09-18T00:00:00.000Z' }),
  articleEntry({ id: P44_IDS.chromium, kind: 'recipe', trust: 'auto', title: 'Render the mock HTML to PNG with headless Chromium', summary: 'On Linux, write the mock as an HTML file, then screenshot it.' }),
  articleEntry({ id: P44_IDS.extract, kind: 'pitfall', trust: 'unreviewed', title: 'Wrapping extractStyle output in another <style> eats its first rule', summary: 'Insert the output as it is.' }),
];
const GONE_ID = id('4410');
const ARTICLE = {
  spaceId: SPACE_ID,
  topic: { slug: 'ui-design', title: 'UI design', category: 'clients', categoryTitle: 'Clients & UI' },
  part: 1, kind: 'subtopic', title: 'Making and checking interface mocks in the Orbit repository',
  blocks: [
    { heading: null, sentences: [
      { text: 'The Orbit repository asks for a mock before any interface change.', notes: [1] },
      { text: 'A mock is rendered to PNG with `chromium --headless=new`.', notes: [2, 3] },
    ] },
    { heading: 'Common pitfalls', sentences: [{ text: 'Do not wrap the **extractStyle** output again.', notes: [3, 4] }] },
  ],
  footnotes: [
    { n: 1, entryId: P44_IDS.mockups, revision: 1, entry: { id: P44_IDS.mockups, kind: 'convention', title: ARTICLE_ENTRIES[0].title, summary: ARTICLE_ENTRIES[0].summary, status: 'active', trust: 'confirmed', currentRevision: 1 } },
    { n: 2, entryId: P44_IDS.chromium, revision: 1, entry: { id: P44_IDS.chromium, kind: 'recipe', title: ARTICLE_ENTRIES[1].title, summary: ARTICLE_ENTRIES[1].summary, status: 'active', trust: 'auto', currentRevision: 1 } },
    { n: 3, entryId: P44_IDS.extract, revision: 1, entry: { id: P44_IDS.extract, kind: 'pitfall', title: ARTICLE_ENTRIES[2].title, summary: ARTICLE_ENTRIES[2].summary, status: 'active', trust: 'unreviewed', currentRevision: 1 } },
    { n: 4, entryId: GONE_ID, revision: 2, entry: null },
  ],
  entryCount: ARTICLE_ENTRIES.length, entryIds: ARTICLE_ENTRIES.map((row) => row.id), entries: ARTICLE_ENTRIES,
  chars: 612, generatedAt: '2026-09-27T03:10:00.000Z', ref: '1588c3bd26383b0b56244e975f8403b15b88a42d', model: 'qwen3.8-27b-fp8',
  overview: { part: 0, kind: 'overview', title: 'UI design', entryCount: 147 },
  parts: [{ part: 1, kind: 'subtopic', title: 'Making and checking interface mocks in the Orbit repository', entryCount: 59 }],
};

// ── Activity ────────────────────────────────────────────────────────────────────────────────────────
function timelineItem(opId, operation, origin, entryId, title, trust, changesetId, hoursAgo) {
  return {
    opId, op: operation, decision: 'auto_applied', origin, at: at(-hoursAgo * HOUR - MIN), entryId, title, kind: 'pitfall',
    status: operation === 'retire' ? 'retired' : 'active', trust, supersededById: null, supersededByTitle: null, reason: null,
    appliedByMode: origin === 'owner' ? null : 'automatic', spotCheck: false, changesetId, changesetAppliedByMode: origin === 'owner' ? null : 'automatic',
  };
}
const TIMELINE = [
  timelineItem('run1-op1', 'add', 'maintenance', 'e1', 'Pin the browser build before taking baselines', 'auto', RUNS[0].id, 0),
  timelineItem('run1-op2', 'add', 'maintenance', 'e2', 'Retry a screenshot that caught an animation', 'unreviewed', RUNS[0].id, 0),
  timelineItem('owner-op', 'retire', 'owner', 'e8', 'An entry you retired', 'confirmed', 'owner-changeset', 3),
];
function health(state) {
  const on = state.maintenance === 'on';
  return {
    spaceId: SPACE_ID, entries: ENTRIES.length,
    maintenance: { look: on ? 'ok' : 'off', enabled: on, lastOkAt: on ? at(-2 * HOUR) : null, lastRunAt: on ? at(-2 * HOUR) : null, consecutiveFailures: 0,
      backlog: 0, oldestPendingAt: null, lagSeconds: 0, dailyLimitReached: false, held: null, running: null, lastRun: null, lastFailure: null },
  };
}

// ── the public wiki ─────────────────────────────────────────────────────────────────────────────────
const SHARED_WIKI = {
  name: 'orbit', documents: 3,
  categories: [
    { key: 'runtime', number: 1, title: 'Runtime', docs: [
      { slug: 'session-runtime', number: '1.1', title: 'Session runtime', lead: 'A session claims a turn. It retries a failed one.' },
      { slug: 'deploy', number: '1.3', title: 'Deploy', lead: null },
    ] },
    { key: 'ops', number: 3, title: 'Operations', docs: [{ slug: 'backups', number: '3.1', title: 'Backups', lead: 'Back up nightly.' }] },
  ],
};
const SHARED_FOOTNOTES = [
  { n: 1, kind: 'code', verdict: 'verified', quote: 'claimTurn(', path: 'src/runner/loop.ts', lineStart: 10, lineEnd: 12, section: null, symbol: 'RunLoop.claim',
    excerpt: 'function claim() {\n  claimTurn(next);\n}', seq: null, at: null, label: null, notePath: null },
  { n: 2, kind: 'turn', verdict: 'verified', quote: 'claim the next turn', path: null, lineStart: null, lineEnd: null, section: null, symbol: null,
    excerpt: null, seq: 4, at: '2026-09-27T08:00:00.000Z', label: 'user', notePath: null },
  { n: 3, kind: 'task_comment', verdict: 'not_found', quote: 'it retries', path: null, lineStart: null, lineEnd: null, section: null, symbol: null,
    excerpt: null, seq: null, at: '2026-09-27T09:00:00.000Z', label: 'USER', notePath: null },
];
const SHARED_DOC = {
  slug: 'session-runtime', number: '1.1', title: 'Session runtime', question: 'How does a session run?', audience: ['Someone new to the runner'],
  scopeIn: ['The run loop'],
  scopeOut: [
    { text: 'Where it is stored', docs: [{ slug: null, number: '1.2', title: 'Storage' }] },
    { text: 'Deploying it', docs: [{ slug: 'deploy', number: '1.3', title: 'Deploy' }] },
  ],
  category: { key: 'runtime', number: 1, title: 'Runtime' }, updatedAt: '2026-09-27T09:00:00.000Z',
  sections: [
    { key: 'loop', number: 1, title: 'The loop', blocks: [
      { kind: 'heading', text: 'How it starts', sentences: [] },
      { kind: 'paragraph', text: null, sentences: [
        { text: 'A session claims a turn.', notes: [1, 2] },
        { text: 'It retries a `failed` one.', notes: [3] },
      ] },
      { kind: 'code', text: 'orbit run --once', sentences: [] },
    ] },
    { key: 'end', number: 3, title: 'The end', blocks: [{ kind: 'item', text: null, sentences: [{ text: 'It finishes.', notes: [] }] }] },
  ],
  footnotes: SHARED_FOOTNOTES,
};

// ── Settings → Shared links ─────────────────────────────────────────────────────────────────────────
const link = (linkId, title, over = {}, root = {}) => ({
  id: linkId, kind: 'SESSION', token: `p44-${linkId.slice(0, 8)}`, include: { toolOutput: true }, expiresAt: null, revokedAt: null, viewCount: 0,
  lastViewedAt: null, createdAt: at(-60 * DAY), updatedAt: at(-60 * DAY), state: 'ACTIVE', stateReason: null,
  root: { id: `${linkId}-root`, title, status: 'SUCCEEDED', lifecycleState: 'OPEN', completedAt: null, ...root }, ...over,
});
const completed = (daysAgo) => ({ lifecycleState: 'COMPLETED', completedAt: at(-daysAgo * DAY) });
function shareLinks() {
  return [
    link(P44_IDS.linkStaleA, 'Can the web tags match iOS', {}, completed(73)),
    link(P44_IDS.linkStaleB, 'iOS send failures do not retry', { viewCount: 3, lastViewedAt: at(-2 * HOUR) }, completed(52)),
    link(P44_IDS.linkStaleC, 'Shared agent memory across platforms', { include: { toolOutput: false } }, completed(31)),
    link(P44_IDS.linkRecent, 'Sub-agent models are set on the server', { createdAt: at(-4 * DAY) }, completed(3)),
    link(P44_IDS.linkOpen, 'Summarize the latest commits', { expiresAt: at(7 * DAY), viewCount: 12, lastViewedAt: at(-30 * MIN) }),
    link(P44_IDS.linkTask, 'Security boundary: cross-owner regression checks',
      { kind: 'TASK', include: { commentsAndFiles: true, conversations: true, toolOutput: true } }, { id: FIXTURE_IDS.task, status: 'DONE' }),
    link(P44_IDS.linkWiki, 'Orbit knowledge', { kind: 'WIKI', include: { footnotes: true }, token: WIKI_TOKEN }, { id: SPACE_ID, slug: 'orbit', status: null }),
    link(P44_IDS.linkProject, 'Orbit UI migration', { kind: 'PROJECT', include: { taskPages: true, conversations: false } }, { id: FIXTURE_IDS.project, status: 'OPEN' }),
    link(P44_IDS.linkPaused, 'Coordinator design', { state: 'PAUSED', stateReason: 'IN_TRASH' }, { lifecycleState: 'TRASH' }),
    link(P44_IDS.linkOff, 'Old dispatch notes', { state: 'ENDED', stateReason: 'TURNED_OFF', revokedAt: at(-5 * DAY) }),
    link(P44_IDS.linkExpired, 'Release checklist', { state: 'ENDED', stateReason: 'EXPIRED', expiresAt: at(-2 * DAY) }),
  ];
}

// ── watches ─────────────────────────────────────────────────────────────────────────────────────────
const target = (kind, resourceId, over = {}) => ({ targetKind: kind, targetResourceId: resourceId, state: 'OBSERVED', targetEpoch: 0, lastEvaluatedAt: at(-2 * HOUR), ...over });
const watch = (watchId, over = {}) => ({
  id: watchId, observerType: 'USER', observerSessionId: null, predicateVersion: 1, predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  mode: 'ONE_SHOT', action: 'NOTIFY_USER', state: 'ACTIVE', generation: 0, expiresAt: at(21 * HOUR + 30 * MIN), nextEvaluateAt: at(MIN),
  lastEvaluatedAt: at(-12_000), idempotencyKey: null, createdAt: at(-2 * HOUR), updatedAt: at(-2 * HOUR), targets: [target('TASK', FIXTURE_IDS.task)],
  matches: [], expiryDeliveries: [], ...over,
});
const delivery = (over = {}) => ({ id: `${over.id ?? 'd'}-delivery`, action: 'NOTIFY_USER', state: 'DELIVERED', attempts: 0, nextAttemptAt: null, lastError: null,
  deliveredAt: at(-HOUR), deadLetteredAt: null, createdAt: at(-HOUR), updatedAt: at(-HOUR), ...over });
function watches() {
  return [
    watch(P44_IDS.watchTask),
    watch(P44_IDS.watchSession, { action: 'RESUME_SESSION', observerType: 'SESSION', observerSessionId: P0_SESSION.id,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' }, targets: [target('SESSION', P44_IDS.otherSession)], createdAt: at(-3 * HOUR) }),
    watch(P44_IDS.watchPaused, { state: 'PAUSED', targets: [target('TASK', P44_IDS.otherTask)], createdAt: at(-5 * HOUR) }),
    watch(P44_IDS.watchExpired, { state: 'EXPIRED', expiresAt: at(-HOUR), predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_DONE' },
      targets: [target('TASK', P44_IDS.otherTask)], createdAt: at(-30 * HOUR), updatedAt: at(-HOUR),
      expiryDeliveries: [delivery({ id: 'x1', state: 'DEAD_LETTERED', attempts: 5, lastError: 'the session ended', deliveredAt: null, deadLetteredAt: at(-HOUR) })] }),
    watch(P44_IDS.watchMatched, { state: 'MATCHED', targets: [target('TASK', FIXTURE_IDS.task)], createdAt: at(-50 * HOUR), updatedAt: at(-20 * HOUR),
      matches: [{ id: 'm1', generation: 1, matchedAt: at(-20 * HOUR), reason: 'ALL TASK_TERMINAL 1/1', predicateVersion: 1,
        perTargetSnapshot: { evaluatedAt: at(-20 * HOUR), targets: [] }, deliveries: [delivery({ id: 'm1' })] }] }),
    // The P0 conversation waits on the pilot's task, and a watch follows the P0 conversation.
    watch(P44_IDS.watchFromSession, { action: 'RESUME_SESSION', observerType: 'SESSION', observerSessionId: P0_SESSION.id,
      targets: [target('TASK', P44_IDS.otherTask), target('SESSION', P44_IDS.otherSession)], predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } }),
    watch(P44_IDS.watchOnSession, { predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_NEEDS_ATTENTION' }, targets: [target('SESSION', P0_SESSION.id)] }),
  ];
}
const SEARCH_HITS = [
  { id: P0_SESSION.id, title: P0_SESSION.title, agent: null },
  { id: P44_IDS.otherSession, title: 'Coordinator', agent: { id: WORKSPACE.id, name: 'orbit' } },
];
const OTHER_SESSION = { ...P0_SESSION, id: P44_IDS.otherSession, title: 'Coordinator', status: 'RUNNING', runState: 'RUNNING' };

/** Answer every route above; `state` holds the switches a test turns before the step that reads them. */
export async function installP44Fixtures(page) {
  const state = {
    share: 'none', reviewMode: 'tiered', spotChecks: false, maintenance: 'off', plan: 'draft', queue: queue(),
    decideRefusal: null, planRefusal: false, links: shareLinks(), holdLinks: null, linksError: null,
    watches: watches(), holdWatches: null, watchesError: null, holdWorkspaces: null,
  };
  const requests = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    const body = () => { try { return request.postDataJSON(); } catch { return request.postData(); } };
    const note = () => requests.push({ method, path, query: searchParams.toString() || undefined, body: method === 'GET' ? undefined : body() });
    const S = `/api/wiki/spaces/${SPACE_ID}`;

    // The default landing reads the workspaces first; a held read keeps its spinner up.
    if (method === 'GET' && path === '/api/workspaces' && state.holdWorkspaces) {
      await state.holdWorkspaces.promise;
      return route.fallback();
    }

    // main 94025579b (managed runners) reads the server's capabilities on the default landing and in a session's
    // console. A server from before the read answers 404, which the app takes as no capability: the landing and the
    // console are what they were (lib/managedRunner.ts).
    if (method === 'GET' && path === '/api/auth/capabilities') return json({ message: 'Cannot GET /api/auth/capabilities' }, 404);

    // ── the wiki space and its reads
    if (method === 'GET' && path === '/api/wiki/spaces') return json([space(state)]);
    if (method === 'GET' && path === S) return json(space(state));
    if (method === 'PATCH' && path === S) {
      note();
      const asked = body();
      if ('reviewMode' in asked) state.reviewMode = asked.reviewMode;
      if ('automaticSpotChecks' in asked) state.spotChecks = asked.automaticSpotChecks;
      if ('maintenance' in asked) state.maintenance = asked.maintenance.enabled ? 'on' : 'off';
      return json(space(state));
    }
    if (method === 'GET' && path === `${S}/health`) return json(health(state));
    if (method === 'GET' && path === `${S}/jobs`) return json({ message: 'Cannot GET /api/wiki/spaces/jobs' }, 404);
    if (method === 'GET' && path === '/api/wiki/system-model') return json({ message: 'Cannot GET /api/wiki/system-model' }, 404);
    if (method === 'GET' && path === `${S}/entries`) {
      const kind = searchParams.get('kind');
      return json(kind ? ENTRIES.filter((entry) => entry.kind === kind) : ENTRIES);
    }
    if (method === 'GET' && path === `${S}/timeline`) return json({ items: TIMELINE });
    if (method === 'GET' && path === `${S}/share`) {
      return json(state.share === 'live'
        ? { link: { ...shareLinks().find((row) => row.kind === 'WIKI'), expiresAt: null }, counts: { documents: 3, footnotes: 12 } }
        : { link: null, counts: { documents: 3, footnotes: 12 } });
    }
    if (method === 'PUT' && path === `${S}/share`) {
      note();
      state.share = 'live';
      return json(shareLinks().find((row) => row.kind === 'WIKI'));
    }
    if (method === 'GET' && path === `${S}/articles`) return json({ ...ARTICLES.directory.read, spaceId: SPACE_ID });
    if (method === 'GET' && path === `${S}/article-index`) return json({ spaceId: SPACE_ID, items: ARTICLES.index.items });
    if (method === 'GET' && path === `${S}/articles/ui-design/1`) return json(ARTICLE);
    if (method === 'GET' && path.startsWith(`${S}/articles/`)) return json({ message: 'this topic has no article yet' }, 404);
    if (method === 'GET' && path.startsWith(`${S}/topics/`)) {
      const slug = decodeURIComponent(path.slice(`${S}/topics/`.length));
      return json({ slug, title: slug === 'ui-design' ? 'UI design' : slug, description: null, declared: true,
        entryCount: ARTICLE_ENTRIES.length, entries: ARTICLE_ENTRIES });
    }
    if (method === 'GET' && path === `${S}/docs`) {
      return json(state.plan === 'none' ? { ...DOCS.docs.directory.read, spaceId: SPACE_ID, plan: null, categories: [] } : { ...DOCS.docs.directory.read, spaceId: SPACE_ID });
    }
    if (method === 'GET' && path === `${S}/docs/${DOC.slug}`) return json({ ...DOC, spaceId: SPACE_ID });
    if (method === 'GET' && path === `${S}/docs/${NOT_WRITTEN.slug}`) return json({ ...NOT_WRITTEN, spaceId: SPACE_ID });
    if (method === 'GET' && path.startsWith(`${S}/docs/`)) return json({ message: 'the confirmed plan has no such document' }, 404);
    if (method === 'GET' && path === `${S}/doc-index`) return json({ spaceId: SPACE_ID, plan: DOCS.docs.directory.read.plan, items: DOCS.docs.index.items });
    if (method === 'GET' && path === `${S}/plan`) return json(planState(state));
    if (method === 'GET' && path === `${S}/plan/versions`) {
      return json({ spaceId: SPACE_ID, versions: state.plan === 'none' ? [] : DOCS.plan.versionRows.versions });
    }
    const version = /^\/api\/wiki\/spaces\/[^/]+\/plan\/versions\/(\d+)$/.exec(path);
    if (method === 'GET' && version) {
      const found = [DOCS.plan.versions.v1, DOCS.plan.versions.v2].find((row) => row.version === Number(version[1]));
      return found ? json(found) : json({ message: 'no such version' }, 404);
    }
    if (method === 'POST' && path === `${S}/plan/redraft`) { note(); return json({ created: true, job: DOCS.plan.jobs.queued }); }
    if (method === 'POST' && /\/plan\/versions\/\d+\/confirm$/.test(path)) { note(); return json({ ...DOCS.plan.versions.v2, status: 'confirmed' }); }
    if (method === 'POST' && path === `${S}/plan/edits`) {
      note();
      if (state.planRefusal) return json({ code: 'WIKI_PLAN_GATE', message: 'The plan did not pass the gate', errors: [PLAN_REFUSAL] }, 422);
      return json({ ...DOCS.plan.versions.v2, version: 3 });
    }
    if (method === 'POST' && /^\/api\/wiki\/plan-proposals\/[^/]+\/decide$/.test(path)) {
      note();
      return json({ proposal: DOCS.plan.proposals[0], draft: { ...DOCS.plan.versions.v2, version: 2 } });
    }

    // ── Review and the entries
    if (method === 'GET' && path === '/api/wiki/review') return json(state.queue.map((row) => ({ ...row, ops: row.ops.filter((one) => one.decision === 'pending') })).filter((row) => row.ops.length));
    if (method === 'POST' && /^\/api\/wiki\/changesets\/[^/]+\/decide$/.test(path)) {
      note();
      if (state.decideRefusal) return json({ code: 'WIKI_CONFLICT', message: state.decideRefusal }, 409);
      const changesetId = decodeURIComponent(path.split('/')[4]);
      const decisions = body().decisions ?? [];
      const decided = new Map(decisions.map((decision) => [decision.opId, decision.action]));
      state.queue = state.queue.map((row) => (row.id !== changesetId ? row : {
        ...row, ops: row.ops.map((one) => (decided.has(one.id)
          ? { ...one, decision: { accept: 'accepted', edit: 'edited', reject: 'rejected', reconfirm: 'accepted', amend: 'edited', retire: 'accepted' }[decided.get(one.id)] ?? 'accepted', decidedAt: FIXED_NOW }
          : one)),
      }));
      return json(state.queue.find((row) => row.id === changesetId));
    }
    if (method === 'GET' && path.startsWith('/api/wiki/entries/')) {
      const entry = entryById(path.slice('/api/wiki/entries/'.length));
      return entry ? json(detail(entry)) : json({ message: 'no such entry' }, 404);
    }
    if (method === 'POST' && /^\/api\/wiki\/entries\/[^/]+\/(confirm|reject)$/.test(path)) { note(); return json({}); }
    if (method === 'POST' && path === `${S}/changesets`) {
      note();
      return json({ id: id('4431'), spaceId: SPACE_ID, origin: 'owner', status: 'applied', ops: [] });
    }
    if (method === 'POST' && path === '/api/link-previews') return json({ previews: [] });

    // ── runs
    const run = /^\/api\/wiki\/changesets\/([^/]+)$/.exec(path);
    if (method === 'GET' && run) {
      // A run's address carries its id in the short form (wikiRunPath encodes it), as the server takes either.
      const asked = decodeURIComponent(run[1]);
      const view = RUNS.find((one) => one.id === asked || uuidToBase62(one.id) === asked);
      return view ? json(view) : json({ message: 'no such changeset' }, 404);
    }
    if (method === 'POST' && /^\/api\/wiki\/changesets\/[^/]+\/revert$/.test(path)) {
      note();
      return json({ revertedChangesetId: RUNS[0].id, changesetId: id('4432'), skipped: [] });
    }

    // ── the public wiki
    if (method === 'GET' && path === `/api/shared/${WIKI_TOKEN}`) return json({ kind: 'WIKI', include: { footnotes: true }, sharedAt: earlier, root: SHARED_WIKI });
    if (method === 'GET' && path === `/api/shared/${WIKI_TOKEN}/docs/session-runtime`) return json({ include: { footnotes: true }, wiki: { name: 'orbit' }, doc: SHARED_DOC });
    if (method === 'GET' && path.startsWith(`/api/shared/${WIKI_TOKEN}/`)) return json({ statusCode: 404, message: 'shared link not found', error: 'Not Found' }, 404);

    // ── Settings → Shared links
    if (method === 'GET' && path === '/api/share-links') {
      if (state.holdLinks) await state.holdLinks.promise;
      if (state.linksError) return json({ message: state.linksError }, 503);
      return json({ links: state.links });
    }
    if (method === 'POST' && path === '/api/share-links/turn-off') {
      note();
      const ids = body().shareLinkIds ?? [];
      let count = 0;
      state.links = state.links.map((row) => {
        if (!ids.includes(row.id) || row.state === 'ENDED') return row;
        count += 1;
        return { ...row, state: 'ENDED', stateReason: 'TURNED_OFF', revokedAt: FIXED_NOW };
      });
      return json({ count });
    }
    const rootShare = /^\/api\/(sessions|tasks|projects)\/([^/]+)\/share$/.exec(path);
    if (rootShare && method === 'PUT') {
      note();
      const old = state.links.find((row) => row.root.id === decodeURIComponent(rootShare[2]));
      const fresh = { ...(old ?? shareLinks()[0]), id: id('4462'), token: 'p44-fresh', state: 'ACTIVE', stateReason: null, revokedAt: null, expiresAt: null, createdAt: FIXED_NOW, viewCount: 0, lastViewedAt: null };
      state.links = [fresh, ...state.links];
      return json(fresh);
    }
    if (rootShare && method === 'GET' && rootShare[1] !== 'tasks' && rootShare[1] !== 'projects') {
      const open = state.links.find((row) => row.root.id === decodeURIComponent(rootShare[2]) && row.state !== 'ENDED');
      return json({ link: open ?? null, counts: { messages: 12, toolCalls: 4 } });
    }

    // ── watches
    if (method === 'GET' && path === '/api/watches') {
      if (state.holdWatches) await state.holdWatches.promise;
      if (state.watchesError) return json({ message: state.watchesError }, 503);
      const rows = state.watches;
      const only = searchParams.get('state');
      if (only) return json(rows.filter((row) => row.state === only));
      if (searchParams.get('needsAttention') === 'true') return json(rows.filter((row) => row.state === 'EXPIRED'));
      return json(rows);
    }
    const watchWrite = /^\/api\/watches\/([^/]+)\/(pause|resume|cancel)$/.exec(path);
    if (method === 'POST' && watchWrite) {
      note();
      const next = { PAUSE: 'PAUSED', RESUME: 'ACTIVE', CANCEL: 'CANCELLED' }[watchWrite[2].toUpperCase()];
      state.watches = state.watches.map((row) => (row.id === decodeURIComponent(watchWrite[1]) ? { ...row, state: next, updatedAt: FIXED_NOW } : row));
      return json(state.watches.find((row) => row.id === decodeURIComponent(watchWrite[1])));
    }
    const oneWatch = /^\/api\/watches\/([^/]+)$/.exec(path);
    if (method === 'GET' && oneWatch) {
      const found = state.watches.find((row) => row.id === decodeURIComponent(oneWatch[1]));
      return found ? json(found) : json({ message: 'no such watch' }, 404);
    }
    if (method === 'PATCH' && oneWatch) {
      note();
      const asked = body();
      state.watches = state.watches.map((row) => (row.id === decodeURIComponent(oneWatch[1]) ? { ...row, ...(asked.predicate ? { predicate: asked.predicate } : {}) } : row));
      return json(state.watches.find((row) => row.id === decodeURIComponent(oneWatch[1])));
    }
    if (method === 'POST' && path === '/api/watches') {
      note();
      const asked = body();
      const created = watch(P44_IDS.created, { predicate: asked.predicate, action: asked.action, observerSessionId: asked.observerSessionId ?? null,
        targets: (asked.targets ?? []).map((one) => target(one.kind, one.id)), createdAt: FIXED_NOW, updatedAt: FIXED_NOW });
      state.watches = [created, ...state.watches];
      return json(created);
    }
    if (method === 'GET' && path === '/api/sessions/search') return json({ q: searchParams.get('q') ?? '', contentSearched: false, total: SEARCH_HITS.length, hits: SEARCH_HITS });
    if (method === 'GET' && path === `/api/sessions/${P44_IDS.otherSession}`) return json(OTHER_SESSION);
    // The session a written document's footnote quotes (`se4`): the phone sheet's button opens it, and the test goes back
    // once its route has drawn. Its page is the session workspace's, not this batch's.
    if (method === 'GET' && path === '/api/sessions/se4') return json({ message: 'Session not found' }, 404);
    const row = /^\/api\/tasks\/([^/]+)\/row$/.exec(path);
    if (method === 'GET' && row) {
      const taskId = decodeURIComponent(row[1]);
      const titles = { [FIXTURE_IDS.task]: 'Review the visual baseline', [P44_IDS.otherTask]: 'Capture browser baselines' };
      return json({ id: taskId, title: titles[taskId] ?? taskId, status: taskId === P44_IDS.otherTask ? 'IN_PROGRESS' : 'OPEN', terminalReason: null });
    }
    if (method === 'GET' && path === '/api/runners' && state.runnersOverride) return json(state.runnersOverride);
    return route.fallback();
  });
  return { state, requests, release: (hold) => hold?.release() };
}

/** A read the test holds until it says: `{ promise, release }`. */
export function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

export { RUNNER, WORKSPACE, P0_SESSION };
