import { describe, expect, it } from 'vitest';
import type { ProjectListIntegration, SessionProjectMembership } from '@orbit/shared';
import type { SidebarProject } from './projectAttention';
import {
  sessionProjectLandingLine,
  sessionProjectListing,
  type SessionProjectLine,
  type SessionProjectSession,
} from './sessionProjects';

// The project row's second line while the platform lands work (docs/mocks/project-sessions-landing/02).
const NOW = Date.parse('2026-10-05T11:24:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
interface Row extends SessionProjectSession {
  line: SessionProjectLine;
  motion?: 'spinner' | 'pulse' | null;
}
const membership = (role: SessionProjectMembership['role']): SessionProjectMembership => ({
  projectId: 'p1', projectTitle: 'Project one', projectStatus: 'OPEN', role,
});
const coordinator = (over: Partial<Row> = {}): Row => ({
  id: 'coordinator', title: 'coordinator', createdAt: ago(600), lastTurnAt: ago(1),
  projectMembership: membership('COORDINATOR'),
  line: { text: 'Watching P5：接通 Web、macOS 和 iOS', tone: 'watching' },
  ...over,
});
const integration = (over: Partial<ProjectListIntegration> = {}): ProjectListIntegration => ({
  line: 'MAIN', ref: 'main', activeJobCount: 1,
  inFlight: { taskTitle: null, kind: 'LAND_PROMOTION', phase: null, state: 'QUEUED', startedAt: ago(13), heartbeatAt: null },
  ...over,
});
const project = (over: Partial<SidebarProject> = {}): SidebarProject => ({
  id: 'p1', title: 'Project one', status: 'OPEN', createdAt: ago(900), lastActivityAt: ago(1),
  buckets: { running: 0 }, taskCounts: { done: 12, failed: 0, total: 15 }, ...over,
});
const lineOf = (sessions: Row[], summary: SidebarProject) => sessionProjectListing(sessions, [], [summary], {
  view: 'open', byTag: false, now: NOW,
  line: (session: Row) => session.line,
  needsYou: (session: Row) => session.line.tone === 'approval',
  motion: (session: Row) => session.motion ?? null,
}).projects[0];

describe('sessionProjectLandingLine', () => {
  it('says the job, its state and its wait in minutes', () => {
    expect(sessionProjectLandingLine(integration(), NOW)).toEqual({ text: 'Merge to main · queued · 13m', tone: 'queued' });
    expect(sessionProjectLandingLine(integration({
      inFlight: { taskTitle: 'P5：接通 Web、macOS 和 iOS', kind: 'LAND_TASK', phase: 'CHECK', state: 'RUNNING', startedAt: ago(4), heartbeatAt: ago(0) },
    }), NOW)).toEqual({ text: 'Landing · checking · 4m · P5：接通 Web、macOS 和 iOS', tone: 'running' });
  });

  it('names the count instead of one task when several jobs are in flight', () => {
    expect(sessionProjectLandingLine(integration({
      activeJobCount: 2,
      inFlight: { taskTitle: 'P5', kind: 'LAND_TASK', phase: 'REBASE', state: 'RUNNING', startedAt: ago(4), heartbeatAt: ago(1) },
    }), NOW)).toEqual({ text: 'Landing 2 jobs · rebasing · 4m', tone: 'running' });
  });

  it('goes quiet when the runner stopped reporting, and says why rather than calling it a timeout', () => {
    const silent = sessionProjectLandingLine(integration({
      inFlight: { taskTitle: null, kind: 'CHECK_PROMOTION', phase: 'CHECK', state: 'RUNNING', startedAt: ago(30), heartbeatAt: ago(11) },
    }), NOW);
    expect(silent).toEqual({ text: 'Merge check · no report for 11m · 30m', tone: 'queued' });
    // How long it has been silent, never a verdict — a timeout is the job's own, and the server
    // words it in the landing's `blockingReason` (`LandTaskStatus`), not here.
    expect(silent!.text).not.toMatch(/timed? ?out/i);
    // A claim whose runner has not reported once says so; one with a live report keeps its phase.
    expect(sessionProjectLandingLine(integration({
      inFlight: { taskTitle: 'P5', kind: 'LAND_TASK', phase: 'FETCH', state: 'RUNNING', startedAt: ago(4), heartbeatAt: null },
    }), NOW)?.text).toBe('Landing · no report yet · 4m · P5');
    expect(sessionProjectLandingLine(integration({
      inFlight: { taskTitle: 'P5', kind: 'LAND_TASK', phase: 'FETCH', state: 'RUNNING', startedAt: ago(4), heartbeatAt: ago(0) },
    }), NOW)?.text).toBe('Landing · fetching · 4m · P5');
  });

  it('falls back to the count on older servers', () => {
    expect(sessionProjectLandingLine({ line: 'MAIN', ref: 'main', activeJobCount: 1 }, NOW))
      .toEqual({ text: 'Landing · 1 job', tone: 'queued' });
    expect(sessionProjectLandingLine({ line: 'MAIN', ref: 'main', activeJobCount: 0 }, NOW)).toBeNull();
    expect(sessionProjectLandingLine(null, NOW)).toBeNull();
  });
});

describe('the project row states a landing between the coordinator working and its other lines', () => {
  it('replaces a watching coordinator’s line and keeps the coordinator as the target', () => {
    const row = lineOf([coordinator()], project({ integration: integration() }));
    expect(row.line).toEqual({ text: 'Merge to main · queued · 13m', tone: 'queued' });
    expect(row.target).toEqual({ kind: 'session', id: 'coordinator' });
  });

  it('yields to a coordinator mid-turn, a held exception and anything waiting on you', () => {
    const running = coordinator({ motion: 'spinner', line: { text: 'Running Edit…', tone: 'running' } });
    expect(lineOf([running], project({ integration: integration() })).line.text).toBe('Running Edit…');
    const held = project({
      integration: integration(),
      attention: { coordinatorItems: { count: 1, leadKind: 'INTEGRATION_CHECK_FAILED', oldestWaitingSince: ago(12), nextEscalationAt: null } },
    });
    expect(lineOf([coordinator()], held).line.text).toBe('Checks failed · 12m');
    const asking = coordinator({ line: { text: 'Waiting for approval', tone: 'approval' } });
    expect(lineOf([asking], project({ integration: integration() })).line.tone).toBe('approval');
  });

  it('is said with no coordinator, opening the project', () => {
    const worker: Row = { ...coordinator(), id: 'worker', projectMembership: membership('TASK') };
    const row = lineOf([worker], project({ integration: integration() }));
    expect(row.line.text).toBe('Merge to main · queued · 13m');
    expect(row.target).toEqual({ kind: 'project', id: 'p1' });
  });

  it('leaves the coordinator’s line alone when nothing is landing', () => {
    expect(lineOf([coordinator()], project({ integration: integration({ activeJobCount: 0, inFlight: undefined }) })).line.text)
      .toBe('Watching P5：接通 Web、macOS 和 iOS');
  });
});
