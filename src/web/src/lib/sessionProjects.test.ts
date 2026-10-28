import { describe, expect, it } from 'vitest';
import type { CoordinatorLeadKind, ProjectPromotionView, SessionProjectMembership } from '@orbit/shared';
import type { SessionFolder } from '../api';
import { COORDINATOR_LEAD_COPY, type SidebarProject } from './projectAttention';
import { sessionTimeSections } from './sessionGrouping';
import {
  landingTaskName,
  landingsCountLine,
  landingsRowSummary,
  landingsWindow,
  listShowsProjects,
  SESSION_PROJECT_COPY,
  SESSION_PROJECT_COORDINATOR_COPY,
  sessionProjectListing,
  sourceLandingLabel,
  type SessionProjectLine,
  type SessionProjectSession,
} from './sessionProjects';

const NOW = Date.parse('2026-10-04T10:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
interface Row extends SessionProjectSession {
  line: SessionProjectLine;
  motion?: 'spinner' | 'pulse' | null;
  countedNeedsYou?: boolean;
}
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  title: id,
  createdAt: ago(60),
  lastTurnAt: ago(20),
  line: { text: 'Last reply', tone: 'preview' },
  ...over,
});
const membership = (role: SessionProjectMembership['role'], projectId = 'p1'): SessionProjectMembership => ({
  projectId,
  projectTitle: 'Project one',
  projectStatus: 'OPEN',
  role,
});
const coordinator = (over: Partial<Row> = {}) => row('coordinator', { projectMembership: membership('COORDINATOR'), ...over });
const member = (id: string, over: Partial<Row> = {}) => row(id, { projectMembership: membership('TASK'), ...over });
const folder = (id: string, name: string): SessionFolder => ({ id, name, workspaceId: 'w1' });
const project = (over: Partial<SidebarProject> = {}): SidebarProject => ({
  id: 'p1',
  title: 'Project one',
  status: 'OPEN',
  createdAt: ago(120),
  lastActivityAt: ago(1),
  buckets: { running: 2 },
  taskCounts: { done: 3, failed: 1, total: 8 },
  ...over,
});
const readings = {
  line: (session: Row) => session.line,
  needsYou: (session: Row) => session.countedNeedsYou ?? session.line.tone === 'approval',
  motion: (session: Row) => session.motion ?? null,
};
const listing = (
  sessions: Row[],
  over: Partial<Parameters<typeof sessionProjectListing<Row>>[3]> = {},
  projects: SidebarProject[] = [project()],
  folders: SessionFolder[] = [],
) => sessionProjectListing(sessions, folders, projects, { view: 'open', byTag: false, now: NOW, ...readings, ...over });

describe('sessionProjectListing', () => {
  it('merges every membership role in Open and Completed and keeps unrelated conversations', () => {
    const members = (['TASK', 'CONTEXT', 'JUDGMENT', 'CHILD'] as const).map((role) => member(role, { projectMembership: membership(role) }));
    for (const view of ['open', 'completed'] as const) {
      const out = listing([coordinator(), ...members, row('ordinary')], { view });
      expect(out.projects).toHaveLength(1);
      expect(out.projects[0].members.map((session) => session.id)).toEqual(['coordinator', 'TASK', 'CONTEXT', 'JUDGMENT', 'CHILD']);
      expect(out.sessions.map((session) => session.id)).toEqual(['ordinary']);
      expect(out.entries.map((entry) => entry.kind)).toEqual(['session', 'project']);
    }
  });

  it('keeps Trash, tag filtering, tag grouping, and search flat, including filed sessions', () => {
    const sessions = [coordinator({ folderId: 'f1' }), member('worker'), row('ordinary')];
    for (const opts of [
      { view: 'trash' as const },
      { byTag: true },
      { view: 'completed' as const, byTag: true },
      { searching: true },
    ]) {
      const out = listing(sessions, opts, [project()], [folder('f1', 'Filed')]);
      expect(out.folders).toEqual([]);
      expect(out.projects).toEqual([]);
      expect(out.sessions).toEqual(sessions);
      expect(out.entries.every((entry) => entry.kind === 'session')).toBe(true);
    }
    expect(listShowsProjects('open', false)).toBe(true);
    expect(listShowsProjects('completed', false)).toBe(true);
    expect(listShowsProjects('trash', false)).toBe(false);
  });

  it('leaves summaries from an older server flat even if the coordinator has legacy projectId', () => {
    const old = { ...row('legacy'), projectId: 'p1', projectTitle: 'Project one' };
    const out = listing([old, row('ordinary', { projectMembership: null })]);
    expect(out.projects).toEqual([]);
    expect(out.sessions.map((session) => session.id)).toEqual(['legacy', 'ordinary']);
  });

  it('still merges DONE projects absent from sidebar and exposes status without invented progress', () => {
    const out = listing([member('done', { projectMembership: { ...membership('TASK'), projectStatus: 'DONE' } })], { view: 'completed' }, []);
    expect(out.projects[0]).toMatchObject({ status: 'DONE', title: 'Project one', taskCounts: undefined });
    expect(out.projects[0].line).toEqual({ text: 'No coordinator', tone: 'preview' });
  });

  it('uses coordinator pinning and the latest member activity for recency and row ordering', () => {
    const pinnedMember = member('pinnedMember', { pinnedAt: ago(30), lastTurnAt: ago(1) });
    const out = listing([coordinator({ lastTurnAt: ago(10_000) }), pinnedMember, row('ordinary', { lastTurnAt: ago(5) })]);
    expect(out.projects[0]).toMatchObject({ pinnedAt: null, lastTurnAt: ago(1) });
    expect(out.entries.map((entry) => entry.id)).toEqual(['p1', 'ordinary']);
    expect(sessionTimeSections(out.entries, { now: new Date(NOW) }).map((section) => section.title)).toEqual(['Today']);
    const pinned = listing([coordinator({ pinnedAt: ago(40), lastTurnAt: ago(10_000) }), member('worker', { lastTurnAt: ago(10_000) })]);
    expect(sessionTimeSections(pinned.entries, { now: new Date(NOW) })[0].title).toBe('Pinned');
    expect(sessionTimeSections(pinned.entries, { pinnedFirst: false, now: new Date(NOW) })[0].title).toBe('2–7 days ago');
  });

  it('uses createdAt when a member has no turn yet, ignoring global project activity', () => {
    const out = listing([coordinator(), member('new', { createdAt: ago(2), lastTurnAt: null })]);
    expect(out.projects[0].lastTurnAt).toBe(ago(2));
  });

  it('puts all members in the coordinator folder for folder counts and activity', () => {
    const folders = [folder('f1', 'Release'), folder('f2', 'Tasks'), folder('empty', 'Empty')];
    const sessions = [coordinator({ folderId: 'f1' }), member('worker', { folderId: 'f2', motion: 'spinner' }), member('waiting', { line: { text: 'Waiting', tone: 'approval' } }), row('ordinary')];
    const out = listing(sessions, {}, [project()], folders);
    expect(out.projects).toEqual([]);
    expect(out.sessions.map((session) => session.id)).toEqual(['ordinary']);
    expect(out.folders.map((entry) => [entry.folder.id, entry.sessionCount, entry.needsYou, entry.running])).toEqual([
      ['empty', 0, 0, false], ['f1', 3, 1, true], ['f2', 0, 0, false],
    ]);
    const inside = listing(sessions, { folderId: 'f1' }, [project()], folders);
    expect(inside.folders).toEqual([]);
    expect(inside.projects[0].members).toHaveLength(3);
    expect(inside.sessions).toEqual([]);
    expect(listing(sessions, { folderId: 'f2' }, [project()], folders).entries).toEqual([]);
  });

  it('shows only occupied folders in Completed, and keeps a project visible when its folder was deleted', () => {
    const sessions = [coordinator({ folderId: 'gone' }), member('worker', { folderId: 'f1' })];
    const out = listing(sessions, { view: 'completed' }, [project()], [folder('f1', 'Old task folder')]);
    expect(out.folders).toEqual([]);
    expect(out.projects).toHaveLength(1);
  });

  it('uses a supplemental coordinator without adding its activity to the current view', () => {
    const coord = coordinator({ pinnedAt: ago(5), lastTurnAt: ago(1), motion: 'spinner', line: { text: 'Running…', tone: 'running' } });
    const out = listing([member('completed', { lastTurnAt: ago(60) })], { view: 'completed', coordinators: [coord] });
    expect(out.projects[0]).toMatchObject({ coordinator: coord, lastTurnAt: ago(60), running: false, needsYou: false, indicator: null });
    expect(out.projects[0].members).toHaveLength(1);
    expect(out.projects[0].line).toEqual(coord.line);
    expect(out.projects[0].target).toEqual({ kind: 'session', id: coord.id });
  });

  it('keeps the input arrays and sessions intact', () => {
    const sessions = [coordinator({ folderId: 'f1' }), member('worker', { folderId: 'f2' })];
    const snapshot = structuredClone(sessions);
    listing(sessions, {}, [project()], [folder('f1', 'Filed')]);
    expect(sessions).toEqual(snapshot);
  });
});

describe('project second line and target', () => {
  const waiting = (text: string): SessionProjectLine => ({ text, tone: 'approval' });

  it.each(['Approve merge to main', 'Question from coordinator', 'Escalated to you', 'Paused', 'Ready to start'])(
    'keeps the coordinator wording %s ahead of older waiting members',
    (text) => {
      const out = listing([coordinator({ line: waiting(text), countedNeedsYou: text !== 'Ready to start' }), member('older', { line: waiting('Waiting for your confirmation'), ownerItems: [{ since: ago(90) }] })]);
      expect(out.projects[0].line).toEqual(waiting(text));
      expect(out.projects[0].target).toEqual({ kind: 'session', id: 'coordinator' });
      expect(out.projects[0].indicator).toBe('needs-you');
    },
  );

  it('names and opens the longest-waiting member, using the obligation timestamp rather than recent activity', () => {
    const old = member('old', { title: 'Quota retry', lastTurnAt: ago(1), line: waiting('Waiting for your confirmation'), ownerItems: [{ since: ago(90) }] });
    const recent = member('recent', { lastTurnAt: ago(80), line: waiting('Question from coordinator'), ownerItems: [{ since: ago(5) }] });
    const out = listing([coordinator(), recent, old]);
    expect(out.projects[0].line).toEqual(waiting('Waiting for your confirmation · Quota retry'));
    expect(out.projects[0].target).toEqual({ kind: 'session', id: 'old' });
  });

  it('names the oldest wait across workspaces while keeping its indicator and time local', () => {
    const coord = coordinator();
    const local = member('local', { motion: 'spinner', lastTurnAt: ago(20) });
    const remote = member('remote', { title: 'Remote retry', lastTurnAt: ago(1), line: waiting('Waiting for your confirmation'), ownerItems: [{ since: ago(90) }] });
    const unrelated = member('unrelated', { projectMembership: membership('TASK', 'p2'), line: waiting('Question from coordinator'), ownerItems: [{ since: ago(120) }] });
    const contentSessions = [coord, local, remote, unrelated];
    const out = listing([coord, local], { contentSessions });
    expect(out.projects[0].line).toEqual(waiting('Waiting for your confirmation · Remote retry'));
    expect(out.projects[0].target).toEqual({ kind: 'session', id: 'remote' });
    expect(out.projects[0]).toMatchObject({ members: [coord, local], sessionCount: 3, indicator: 'running', needsYou: false, lastTurnAt: ago(20) });
    const idle = { ...local, motion: null };
    expect(listing([coord, idle], { contentSessions }).projects[0].indicator).toBeNull();
    const localWait = { ...local, line: waiting('Question from coordinator'), ownerItems: [{ since: ago(5) }] };
    const both = listing([coord, localWait], { contentSessions });
    expect(both.projects[0].target.id).toBe('remote');
    expect(both.projects[0].indicator).toBe('needs-you');
    expect(listing([coord, local]).projects[0].sessionCount).toBe(2);
  });

  it('falls back to last activity for old waiting summaries and sorts unknown timestamps last', () => {
    const out = listing([coordinator(), member('unknown', { createdAt: null, lastTurnAt: 'invalid', line: waiting('Waiting') }), member('known', { lastTurnAt: ago(30), line: waiting('Waiting') })]);
    expect(out.projects[0].target.id).toBe('known');
  });

  it('includes a supplemental coordinator in the progress hint count once', () => {
    const coord = coordinator();
    const task = member('completed');
    const out = listing([task], { view: 'completed', coordinators: [coord], contentSessions: [task] });
    expect(out.projects[0].sessionCount).toBe(2);
    expect(listing([coord, task], { coordinators: [coord], contentSessions: [coord, task] }).projects[0].sessionCount).toBe(2);
  });

  it.each([
    ['INTEGRATION_CONFLICT', 'Resolving a merge conflict'],
    ['INTEGRATION_CHECK_FAILED', 'Checks failed'],
    ['INTEGRATION_ERROR', 'Handling an integration error'],
    ['TASK_FAILED', 'Handling a failed task'],
    ['DELIVERY_REVIEW', 'Reviewing a delivery'],
  ] as [CoordinatorLeadKind, string][])(
    'uses the project handling words for %s, capitalized and without the Coordinator prefix',
    (leadKind, text) => {
      const summary = project({ attention: { coordinatorItems: { count: 1, leadKind, oldestWaitingSince: ago(18), nextEscalationAt: ago(-60) } } });
      const out = listing([coordinator()], {}, [summary]);
      expect(out.projects[0].line).toEqual({ text: `${text} · 18m`, tone: 'running' });
      expect(out.projects[0].target).toEqual({ kind: 'session', id: 'coordinator' });
    },
  );

  it('keeps ordinary coordinator lines verbatim', () => {
    for (const line of [{ text: 'Running Bash…', tone: 'running' }, { text: 'You: Continue', tone: 'preview' }, { text: 'Finished the requested change.', tone: 'preview' }] as SessionProjectLine[]) {
      expect(listing([coordinator({ line })]).projects[0].line).toEqual(line);
    }
  });

  it('routes to the project with No coordinator when none exists', () => {
    const out = listing([member('worker')]);
    expect(out.projects[0].line).toEqual({ text: 'No coordinator', tone: 'preview' });
    expect(out.projects[0].target).toEqual({ kind: 'project', id: 'p1' });
  });
});

describe('project status indicator', () => {
  it('prioritizes a waiting member, then running work, then background jobs', () => {
    const background = member('background', { motion: 'pulse' });
    const running = member('running', { motion: 'spinner' });
    const waiting = member('waiting', { line: { text: 'Waiting for your confirmation', tone: 'approval' } });
    expect(listing([coordinator(), background, running, waiting]).projects[0].indicator).toBe('needs-you');
    expect(listing([coordinator(), background, running]).projects[0].indicator).toBe('running');
    expect(listing([coordinator(), background]).projects[0].indicator).toBe('jobs');
    expect(listing([coordinator()]).projects[0].indicator).toBeNull();
  });

  it('does not infer local motion from sidebar running counts, and suppresses motion offline', () => {
    expect(listing([coordinator()]).projects[0]).toMatchObject({ runningCount: 2, indicator: null });
    expect(listing([coordinator(), member('running', { motion: 'spinner' }), member('background', { motion: 'pulse' })], { runnerOffline: true }).projects[0]).toMatchObject({ running: false, jobs: false, indicator: null });
  });

  it('shows Ready to start without adding a folder needs-you count', () => {
    const coord = coordinator({ folderId: 'f1', countedNeedsYou: false, line: { text: 'Ready to start', tone: 'approval' } });
    const folders = [folder('f1', 'Filed')];
    expect(listing([coord], {}, [project()], folders).folders[0].needsYou).toBe(0);
    expect(listing([coord], { folderId: 'f1' }, [project()], folders).projects[0].indicator).toBe('needs-you');
  });
});

describe('session project copy', () => {
  it('keeps handling text equal to the project-page copy with its first letter capitalized', () => {
    for (const kind of Object.keys(COORDINATOR_LEAD_COPY) as CoordinatorLeadKind[]) {
      const text = COORDINATOR_LEAD_COPY[kind];
      expect(SESSION_PROJECT_COORDINATOR_COPY[kind]).toBe(text[0].toUpperCase() + text.slice(1));
    }
  });

  it('says what a start request suggests directly into the main branch it names, main as before', () => {
    const direct = { line: 'MAIN' as const, automatic: false, maxConcurrentTasks: 1 };
    expect(SESSION_PROJECT_COPY.startSuggestion(direct)).toBe('Directly into main · Automatic off · 1 at a time');
    expect(SESSION_PROJECT_COPY.startSuggestion({ ...direct, upstreamRef: 'refs/heads/master' }))
      .toBe('Directly into master · Automatic off · 1 at a time');
    // The branch the start card opens with, when the page holds the read that says it.
    expect(SESSION_PROJECT_COPY.startSuggestion(direct, 'develop')).toBe('Directly into develop · Automatic off · 1 at a time');
    expect(SESSION_PROJECT_COPY.startSuggestion({ ...direct, line: 'PROJECT_BRANCH', upstreamRef: 'refs/heads/master' }))
      .toBe('Project branch · Automatic off · 1 at a time');
  });

  it('keeps the progress and navigation words in the cross-client contract', () => {
    expect(SESSION_PROJECT_COPY.progress(3, 8)).toBe('3/8');
    expect(SESSION_PROJECT_COPY.progressHint(9, 2)).toBe('9 sessions · 2 running');
    expect(SESSION_PROJECT_COPY.pageSubtitle(9)).toBe('Project · 9 sessions');
    expect(SESSION_PROJECT_COPY.pageProgress(3, 8, 2)).toBe('3/8 done · 2 running');
    expect([SESSION_PROJECT_COPY.openSession, SESSION_PROJECT_COPY.openCoordinator, SESSION_PROJECT_COPY.sessions, SESSION_PROJECT_COPY.openProject, SESSION_PROJECT_COPY.pin, SESSION_PROJECT_COPY.unpin, SESSION_PROJECT_COPY.move]).toEqual(['Open Session', 'Open Coordinator', 'Sessions', 'Open Project', 'Pin', 'Unpin', 'Move…']);
  });
});

/**
 * The project's Landings window and its one row on the sessions page (owner 2026-10-27,
 * docs/mocks/landings-one-window; contract §2.9 LS6, revision 28). Every instant is built in local
 * time, so the day sections and today's counts read the same under any TZ.
 */
describe('the Landings window and its row', () => {
  // Tuesday 2026-10-27, 10:20 local — the board's moment.
  const NOON = new Date(2026, 9, 27, 10, 20);
  const local = (day: number, hour: number, minute = 0): string => new Date(2026, 9, day, hour, minute).toISOString();
  const landing = (
    id: string,
    summary: {
      subject?: 'TASK' | 'PROMOTION';
      state: 'IN_FLIGHT' | 'AWAITING_DECISION' | 'SETTLED';
      settledAs?: string | null;
      settledAt?: string | null;
    },
    over: Record<string, unknown> = {},
  ) => ({
    id,
    title: `Land · ${id}`,
    createdAt: local(27, 8),
    landing: {
      subject: summary.subject ?? 'TASK', state: summary.state,
      settledAs: summary.settledAs ?? null, settledAt: summary.settledAt ?? null,
    },
    ...over,
  });
  const merged = (id: string, at: string, landingSessionId: string | null, automatic = true): ProjectPromotionView => ({
    promotionId: id, state: 'MERGED', sourceKind: 'PROJECT_BRANCH', sourceRef: 'refs/heads/project/p1',
    sourceSha: 'a'.repeat(40), upstreamRef: 'refs/heads/main', commitsAhead: 2, filesChanged: 3,
    tasks: [{ taskId: 't1', title: 'Ledger order' }, { taskId: 't2', title: 'Payout budget' }],
    taskIds: ['t1', 't2'], checks: [], conflicts: [], blockedReason: null, upstreamShaChecked: null,
    landsTreeSha: null, landsAs: 'MERGE_COMMIT', askedAt: null, upstream: { syncedAt: null, conflicts: false },
    recheckedAt: null, recheck: null, landingSessionId,
    merged: { sha: '3f1c2a9000000000000000000000000000000000', at, automatic, byUserId: null },
  } as ProjectPromotionView);

  it('groups the settled ones by the session list’s days, oldest first, and keeps every one of them', () => {
    const window = landingsWindow([
      landing('Fix the deep link', { state: 'SETTLED', settledAs: 'NOTHING_TO_LAND', settledAt: local(27, 8, 30) }),
      landing('Ledger migration order', { state: 'SETTLED', settledAs: 'LANDED', settledAt: local(26, 17, 42) }),
      landing('Runner model order', { state: 'SETTLED', settledAs: 'LANDED', settledAt: local(27, 10, 2) }),
      landing('Month-old fix', { state: 'SETTLED', settledAs: 'CANCELLED', settledAt: local(1, 9) }),
      landing('Wiki review link', { state: 'SETTLED', settledAs: 'ALREADY_LANDED', settledAt: local(27, 9, 5) }),
    ], [], { now: NOON });
    expect(window.days.map((day) => day.title)).toEqual(['8–30 days ago', 'Yesterday', 'Today']);
    expect(window.days[2].rows.map((row) => row.title))
      .toEqual(['Fix the deep link', 'Wiki review link', 'Runner model order']);
    expect(window.days[2].rows.map((row) => `${row.time} ${row.detail} ${row.tone}`))
      .toEqual(['08:30 Nothing to land quiet', '09:05 Already landed ok', '10:02 Landed ok']);
    expect(window.days[0].rows[0]).toMatchObject({ title: 'Month-old fix', detail: 'Cancelled', tone: 'quiet' });
    // Nothing is in hand.
    expect(window.now).toEqual([]);
  });

  it('puts what is in hand under Now, in the order it started', () => {
    const window = landingsWindow([
      landing('Checks failed', { state: 'AWAITING_DECISION' }, { createdAt: local(27, 10, 1) }),
      landing('Still landing', { state: 'IN_FLIGHT' }, { createdAt: local(27, 9, 40) }),
      landing('Merge project/p1 → main · #12', { subject: 'PROMOTION', state: 'IN_FLIGHT' },
        { title: 'Merge project/p1 → main · #12', createdAt: local(27, 10, 5) }),
    ], [], { now: NOON });
    expect(window.days).toEqual([]);
    expect(window.now.map((card) => [card.title, card.state, card.subject])).toEqual([
      ['Still landing', 'IN_FLIGHT', 'TASK'],
      ['Checks failed', 'AWAITING_DECISION', 'TASK'],
      ['Merge project/p1 → main · #12', 'IN_FLIGHT', 'PROMOTION'],
    ]);
  });

  it('joins a merge into main with its round’s landing session by landingSessionId, one row', () => {
    const window = landingsWindow([
      landing('S-12', { subject: 'PROMOTION', state: 'SETTLED', settledAs: 'MERGED', settledAt: local(27, 9, 52) },
        { title: 'Merge project/p1 → main · #12' }),
    ], [merged('P-12', local(27, 9, 51), 'S-12')], { now: NOON });
    expect(window.days).toHaveLength(1);
    expect(window.days[0].rows).toHaveLength(1);
    expect(window.days[0].rows[0]).toMatchObject({
      key: 'S-12', sessionId: 'S-12', subject: 'PROMOTION', title: 'Merged into main',
      detail: '3f1c2a9 · 2 tasks · automatically', tone: 'merge', time: '09:51',
    });
    expect(window.days[0].rows[0].promotion?.promotionId).toBe('P-12');
  });

  it('keeps a merge older than landing sessions as a row of its own, and a round past the 20 records as its session', () => {
    const window = landingsWindow([
      landing('S-3', { subject: 'PROMOTION', state: 'SETTLED', settledAs: 'MERGED', settledAt: local(25, 15) },
        { title: 'Merge project/p1 → main · #3' }),
    ], [merged('P-1', local(26, 11, 30), null, false)], { now: NOON });
    expect(window.days.map((day) => day.title)).toEqual(['2–7 days ago', 'Yesterday']);
    // Its record is beyond the read: the session's own row, named by its round.
    expect(window.days[0].rows[0]).toMatchObject({
      key: 'S-3', sessionId: 'S-3', title: 'Merged into main', detail: 'Merge project/p1 → main · #3',
      tone: 'merge', promotion: null,
    });
    // No session: the receipt is all it opens to.
    expect(window.days[1].rows[0]).toMatchObject({
      key: 'merge:P-1', sessionId: null, title: 'Merged into main', detail: '3f1c2a9 · 2 tasks · by you',
      tone: 'merge', time: '11:30',
    });
  });

  it('names a task segment by its task, and a round that did not merge by its own title', () => {
    expect(landingTaskName('Land · Ledger migration order')).toBe('Ledger migration order');
    expect(landingTaskName('Land · Ledger migration order (#2)')).toBe('Ledger migration order (#2)');
    expect(landingTaskName('Something else')).toBe('Something else');
    const window = landingsWindow([
      landing('declined', { subject: 'PROMOTION', state: 'SETTLED', settledAs: 'DECLINED', settledAt: local(27, 9) },
        { title: 'Merge project/p1 → main · #4' }),
    ], [], { now: NOON });
    expect(window.days[0].rows[0]).toMatchObject({ title: 'Merge project/p1 → main · #4', detail: 'Declined', tone: 'quiet' });
  });

  it('counts the row: a 0 is left out, today’s two share one today, and all 0 is Nothing landed today', () => {
    expect(landingsCountLine({ waiting: 1, inFlight: 1, landed: 3, merged: 1 }))
      .toBe('1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today');
    expect(landingsCountLine({ waiting: 0, inFlight: 2, landed: 0, merged: 0 })).toBe('2 in flight');
    expect(landingsCountLine({ waiting: 0, inFlight: 0, landed: 2, merged: 0 })).toBe('2 landed today');
    expect(landingsCountLine({ waiting: 0, inFlight: 0, landed: 0, merged: 1 }, 'master')).toBe('1 merged into master today');
    expect(landingsCountLine({ waiting: 2, inFlight: 0, landed: 0, merged: 0 })).toBe('2 waiting for a decision');
    expect(landingsCountLine({ waiting: 0, inFlight: 0, landed: 0, merged: 0 })).toBe('Nothing landed today');
  });

  it('marks the row by the most urgent landing, and times the longest wait', () => {
    const now = NOON.getTime();
    const rows = [
      landing('Checks failed', { state: 'AWAITING_DECISION' }, { createdAt: new Date(now - 18 * 60_000).toISOString() }),
      landing('Still landing', { state: 'IN_FLIGHT' }),
      landing('a', { state: 'SETTLED', settledAs: 'LANDED', settledAt: local(27, 9) }),
      landing('b', { state: 'SETTLED', settledAs: 'LANDED', settledAt: local(27, 9, 30) }),
      landing('c', { state: 'SETTLED', settledAs: 'ALREADY_LANDED', settledAt: local(27, 10) }),
      landing('yesterday', { state: 'SETTLED', settledAs: 'LANDED', settledAt: local(26, 22) }),
      landing('nothing', { state: 'SETTLED', settledAs: 'NOTHING_TO_LAND', settledAt: local(27, 8) }),
    ];
    expect(landingsRowSummary(rows, [merged('P-1', local(27, 9, 51), null)], { now })).toEqual({
      mark: 'fail',
      time: '18m',
      line: '1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today',
    });
    // Nothing waits: the ring, and how long ago the last one settled.
    expect(landingsRowSummary(rows.slice(1), [], { now })).toEqual({
      mark: 'running', time: '20m', line: '1 in flight · 3 landed today',
    });
    // All settled: ✓.
    expect(landingsRowSummary(rows.slice(2), [], { now })?.mark).toBe('ok');
  });

  it('says Nothing landed today over a quiet day, and is no row for a project that never had a landing', () => {
    const now = NOON.getTime();
    expect(landingsRowSummary([
      landing('yesterday', { state: 'SETTLED', settledAs: 'LANDED', settledAt: local(26, 22) }),
    ], [], { now })).toEqual({ mark: 'ok', time: '12h', line: 'Nothing landed today' });
    // A merge older than landing sessions is a landing the project had.
    expect(landingsRowSummary([], [merged('P-1', local(20, 9), null)], { now })?.line).toBe('Nothing landed today');
    expect(landingsRowSummary([], [], { now })).toBeNull();
    // A conversation is no landing.
    expect(landingsRowSummary([{ id: 'chat', createdAt: local(27, 9) }], [], { now })).toBeNull();
  });
});

/** The derived label on a source work session (board v4 06 e): three facts, three inks. */
describe('the source session’s landing label', () => {
  const source = (over: Record<string, unknown> = {}) => ({
    landingSessionId: 'S1', subject: 'TASK' as const, state: 'RUNNING', phase: 'CHECK',
    settledAs: null, targetRef: 'refs/heads/project/p1', ...over,
  });

  it('says checking while it moves, the branch once it landed, and what stopped it', () => {
    expect(sourceLandingLabel(source())).toEqual({ text: 'Landing · checking', tone: 'run' });
    expect(sourceLandingLabel(source({ phase: 'REBASE' }))).toEqual({ text: 'Landing · rebasing', tone: 'run' });
    expect(sourceLandingLabel(source({ state: 'QUEUED', phase: null })))
      .toEqual({ text: 'Landing · queued', tone: 'run' });
    expect(sourceLandingLabel(source({ settledAs: 'LANDED' })))
      .toEqual({ text: 'On project/p1 ✓', tone: 'landed' });
    expect(sourceLandingLabel(source({ state: 'CHECK_FAILED', settledAs: null })))
      .toEqual({ text: 'Landing · checks failed', tone: 'failed' });
    expect(sourceLandingLabel(source({ state: 'CHECK_FAILED' })))
      .toEqual({ text: 'Landing · checks failed', tone: 'failed' });
    expect(sourceLandingLabel(source({ state: 'CONFLICT' }))?.tone).toBe('failed');
    expect(sourceLandingLabel(source({ state: 'ERROR' }))?.text).toBe('Landing · error');
  });

  it('says where a merge round put the work, by the project’s main branch', () => {
    expect(sourceLandingLabel(source({ subject: 'PROMOTION', settledAs: 'MERGED' })))
      .toEqual({ text: 'On main ✓', tone: 'landed' });
    expect(sourceLandingLabel(source({ subject: 'PROMOTION', settledAs: 'MERGED' }), 'master'))
      .toEqual({ text: 'On master ✓', tone: 'landed' });
    expect(sourceLandingLabel(source({ settledAs: 'NOTHING_TO_LAND' })))
      .toEqual({ text: 'Nothing to land', tone: 'quiet' });
  });

  it('is nothing at all for a conversation that fed no landing', () => {
    expect(sourceLandingLabel(null)).toBeNull();
    expect(sourceLandingLabel(undefined)).toBeNull();
  });
});
