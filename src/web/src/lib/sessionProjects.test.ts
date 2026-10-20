import { describe, expect, it } from 'vitest';
import type { CoordinatorLeadKind, SessionProjectMembership } from '@orbit/shared';
import type { SessionFolder } from '../api';
import { COORDINATOR_LEAD_COPY, type SidebarProject } from './projectAttention';
import { sessionTimeSections } from './sessionGrouping';
import {
  landingEarlierLine,
  landingGroup,
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
 * The Landings group of a project's sessions page (owner 2026-10-19, board v4 04 c1; contract §2.9
 * LS6): what waits on a decision, what settled in the last day, one folded line for everything
 * older — and never a landing still in flight, nor a round of merging that already merged.
 */
describe('the Landings group', () => {
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
    title: id,
    createdAt: ago(15),
    landing: {
      subject: summary.subject ?? 'TASK', state: summary.state,
      settledAs: summary.settledAs ?? null, settledAt: summary.settledAt ?? null,
    },
    ...over,
  });

  it('lists what waits and what settled within the day, waiting first, and never what moves', () => {
    const group = landingGroup([
      landing('in-flight', { state: 'IN_FLIGHT' }),
      landing('waiting', { state: 'AWAITING_DECISION' }),
      landing('landed-now', { state: 'SETTLED', settledAs: 'LANDED', settledAt: ago(60) }),
      landing('nothing-now', { state: 'SETTLED', settledAs: 'NOTHING_TO_LAND', settledAt: ago(120) }),
    ], { now: NOW })!;
    expect(group.waiting.map((row) => row.id)).toEqual(['waiting']);
    expect(group.settled.map((row) => row.id)).toEqual(['landed-now', 'nothing-now']);
    expect(group.earlier).toBeNull();
    // The waiting row says the outcome and who holds it; the settled ones say how they ended.
    expect(group.waiting[0]!.detail).toBe('Waiting for a decision');
    expect(group.waiting[0]!.time).toBe('15m');
    expect(group.waiting[0]!.tone).toBe('quiet');
    expect(group.settled.map((row) => row.detail)).toEqual(['Landed', 'Nothing to land']);
    expect(group.settled[0]!.tone).toBe('ok');
    expect(group.settled[1]!.tone).toBe('quiet');
  });

  it('says which side holds a waiting landing, in the open items’ own words', () => {
    const holders = new Map([
      ['waiting', { reason: 'Checks failed', assignee: 'COORDINATOR' as const }],
      ['mine', { reason: 'Merge conflict', assignee: 'OWNER' as const }],
    ]);
    const group = landingGroup([
      landing('waiting', { state: 'AWAITING_DECISION' }),
      landing('mine', { state: 'AWAITING_DECISION' }, { createdAt: ago(40) }),
      landing('bare', { state: 'AWAITING_DECISION' }, { createdAt: ago(5) }),
    ], { now: NOW, holders })!;
    // Longest wait first: this group answers "what is stuck".
    expect(group.waiting.map((row) => [row.id, row.detail, row.tone])).toEqual([
      ['mine', 'Merge conflict · with you', 'fail'],
      ['waiting', 'Checks failed · with the coordinator', 'fail'],
      ['bare', 'Waiting for a decision', 'quiet'],
    ]);
  });

  it('folds everything older than the day into one line, and keeps it to open', () => {
    const group = landingGroup([
      landing('recent', { state: 'SETTLED', settledAs: 'LANDED', settledAt: ago(60) }),
      landing('old-landed', { state: 'SETTLED', settledAs: 'ALREADY_LANDED', settledAt: ago(26 * 60) }),
      landing('old-nothing', { state: 'SETTLED', settledAs: 'NOTHING_TO_LAND', settledAt: ago(30 * 60) }),
      landing('older-still', { state: 'SETTLED', settledAs: 'LANDED', settledAt: ago(50 * 60) }),
    ], { now: NOW })!;
    expect(group.settled.map((row) => row.id)).toEqual(['recent']);
    expect(group.earlier).toEqual({ landed: 2, nothing: 1 });
    expect(landingEarlierLine(group.earlier!)).toBe('Earlier · 2 landed · 1 nothing to land');
    expect(group.older.map((row) => row.id)).toEqual(['old-landed', 'old-nothing', 'older-still']);
  });

  it('leaves a segment whose count is 0 out of the fold’s line', () => {
    expect(landingEarlierLine({ landed: 2, nothing: 0 })).toBe('Earlier · 2 landed');
    expect(landingEarlierLine({ landed: 0, nothing: 1 })).toBe('Earlier · 1 nothing to land');
    // Only landed: the fold says so, and still opens to every older row, the cancelled one too.
    const landedOnly = landingGroup([
      landing('old-landed', { state: 'SETTLED', settledAs: 'LANDED', settledAt: ago(26 * 60) }),
      landing('old-again', { state: 'SETTLED', settledAs: 'ALREADY_LANDED', settledAt: ago(28 * 60) }),
      landing('old-cancelled', { state: 'SETTLED', settledAs: 'CANCELLED', settledAt: ago(30 * 60) }),
    ], { now: NOW })!;
    expect(landedOnly.earlier).toEqual({ landed: 2, nothing: 0 });
    expect(landingEarlierLine(landedOnly.earlier!)).toBe('Earlier · 2 landed');
    expect(landedOnly.older.map((row) => row.id)).toEqual(['old-landed', 'old-again', 'old-cancelled']);
    const nothingOnly = landingGroup([
      landing('old-nothing', { state: 'SETTLED', settledAs: 'NOTHING_TO_LAND', settledAt: ago(26 * 60) }),
    ], { now: NOW })!;
    expect(landingEarlierLine(nothingOnly.earlier!)).toBe('Earlier · 1 nothing to land');
  });

  it('draws no fold when nothing older landed or had nothing to land', () => {
    const old = [
      landing('old-cancelled', { state: 'SETTLED', settledAs: 'CANCELLED', settledAt: ago(26 * 60) }),
      landing('old-handled', { state: 'SETTLED', settledAs: 'HANDLED', settledAt: ago(30 * 60) }),
      landing('old-declined', { state: 'SETTLED', settledAs: 'DECLINED', settledAt: ago(32 * 60) }),
      landing('old-deleted', { state: 'SETTLED', settledAs: 'DELETED', settledAt: ago(34 * 60) }),
      landing('no-instant', { state: 'SETTLED', settledAs: 'CANCELLED', settledAt: null }),
    ];
    const group = landingGroup([landing('waiting', { state: 'AWAITING_DECISION' }), ...old], { now: NOW })!;
    expect(group.waiting.map((row) => row.id)).toEqual(['waiting']);
    expect(group.earlier).toBeNull();
    expect(group.older).toEqual([]);
    // …and with nothing else to list, there is no group: no bare "Landings" heading.
    expect(landingGroup(old, { now: NOW })).toBeNull();
  });

  it('never lists a round of merging that merged — the timeline has that row', () => {
    const group = landingGroup([
      landing('round', { subject: 'PROMOTION', state: 'SETTLED', settledAs: 'MERGED', settledAt: ago(30) }),
      landing('waiting', { state: 'AWAITING_DECISION' }),
    ], { now: NOW })!;
    expect(group.settled).toEqual([]);
    expect(group.earlier).toBeNull();
    // …and a project with nothing but that round has no group at all.
    expect(landingGroup([
      landing('round-only', { subject: 'PROMOTION', state: 'SETTLED', settledAs: 'MERGED', settledAt: ago(30) }),
      landing('moving', { state: 'IN_FLIGHT' }),
    ], { now: NOW })).toBeNull();
  });

  it('is no group at all when there is nothing to list', () => {
    expect(landingGroup([], { now: NOW })).toBeNull();
    expect(landingGroup([landing('moving', { state: 'IN_FLIGHT' })], { now: NOW })).toBeNull();
    // A conversation row carries no landing summary and is skipped, not drawn as a blank landing.
    expect(landingGroup([{ id: 'chat', createdAt: ago(5) }], { now: NOW })).toBeNull();
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
