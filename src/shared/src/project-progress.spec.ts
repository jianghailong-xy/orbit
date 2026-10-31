import { describe, expect, it } from 'vitest';
import { OWNER_ITEM_PUSH_KINDS } from './project-progress';
import type { OwnerItemKind, ProjectIntegrationInFlight, ProjectIntegrationJob } from './project-progress';

/**
 * The landing-session fields on the integration read model are optional in both directions
 * (`docs/project-integration-line-contract.md` §1.6, §7.2 V6): a server that predates them answers
 * without them, and a reader that knows them reads the same object either way. The two shapes
 * below are the whole test — a field made required would stop the first literal compiling, which
 * is exactly the compatibility this read model promises.
 */
describe('the integration read model', () => {
  it('reads a job from a server that predates the landing-session fields', () => {
    const job: ProjectIntegrationJob = {
      jobId: 'j-old', kind: 'LAND_TASK', state: 'QUEUED', phase: null, taskId: 't', taskTitle: 'A',
      generation: 1, startedAt: '2026-10-01T00:00:00.000Z', queuedAt: '2026-10-01T00:00:00.000Z',
      heartbeatAt: null, runnerName: null, retriedBy: null, timedOut: false, limitSeconds: null,
      retryable: false,
    };
    expect(job.liveness).toBeUndefined();
    expect(job.blockingReason).toBeUndefined();
    expect(job.typicalMs).toBeUndefined();
    expect(job.check).toBeUndefined();
    expect(job.claim).toBeUndefined();
    expect(job.landingSessionId).toBeUndefined();
  });

  it('carries every field when the server sends them', () => {
    const job: ProjectIntegrationJob = {
      jobId: 'j-new', kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK', taskId: null,
      taskTitle: null, promotionId: 'p-1', generation: 2, startedAt: '2026-10-01T00:00:00.000Z',
      queuedAt: '2026-10-01T00:00:00.000Z', heartbeatAt: '2026-10-01T00:05:00.000Z',
      runnerName: 'workstation-gpu', retriedBy: 'OWNER', timedOut: false, limitSeconds: 600,
      progressProtocol: 'v2', claim: 2, round: 1,
      check: {
        name: 'MERGE_CHECK', index: 1, count: 2, budgetSeconds: 3_600,
        startedAt: '2026-10-01T00:04:00.000Z',
      },
      stepStartedAt: '2026-10-01T00:04:00.000Z', outputMovedAt: '2026-10-01T00:04:30.000Z',
      typicalMs: 2_280_000, liveness: 'LIVE',
      blockingReason: {
        code: 'WAITING_LOCAL_LOCK',
        summary: 'Waiting for another job on this runner: it is using this repository and target branch',
      },
      landingSessionId: 's-landing', retryable: false,
    };
    expect(job.promotionId).toBe('p-1');
    expect(job.claim).toBe(2);
    expect(job.round).toBe(1);
    expect(job.check?.budgetSeconds).toBe(3_600);
    expect(job.stepStartedAt).toBe('2026-10-01T00:04:00.000Z');
    expect(job.outputMovedAt).toBe('2026-10-01T00:04:30.000Z');
    expect(job.typicalMs).toBe(2_280_000);
    expect(job.liveness).toBe('LIVE');
    expect(job.blockingReason?.code).toBe('WAITING_LOCAL_LOCK');
    expect(job.landingSessionId).toBe('s-landing');
  });

  it('the line’s job carries the same fields, with and without them', () => {
    const old: ProjectIntegrationInFlight = { taskTitle: null, state: 'QUEUED', startedAt: 'q' };
    expect(old.jobId).toBeUndefined();
    expect(old.runner).toBeUndefined();
    expect(old.liveness).toBeUndefined();
    expect(old.blockingReason).toBeUndefined();

    const current: ProjectIntegrationInFlight = {
      taskTitle: 'C5', kind: 'LAND_TASK', phase: 'CHECK', state: 'RUNNING', startedAt: 'q',
      heartbeatAt: 'h', waitMs: 30_000, jobId: 'j', landingSessionId: null, taskId: 't',
      promotionId: null, runner: 'wikova', claim: 1, round: 2,
      check: { name: 'TASK_ACCEPTANCE', index: 1, count: 2, budgetSeconds: 900, startedAt: 'c' },
      stepStartedAt: 'c', outputMovedAt: 'o', progressProtocol: 'v2', typicalMs: null,
      liveness: 'QUIET',
      blockingReason: { code: 'WAITING_TASK_WORK', summary: 'Waiting to land: the work is running' },
    };
    expect(current.check?.count).toBe(2);
    expect(current.round).toBe(2);
    expect(current.liveness).toBe('QUIET');
    expect(current.blockingReason?.summary).toBe('Waiting to land: the work is running');
  });
});

/**
 * What a "needs you" push says it is about (§7.6 V12, §7.1 V2): one slug per owner item kind, the
 * words the phone, the banner and the project list route by. The fifth, `LANDED_WITHOUT_CONFIRMATION`
 * (§10.7), is pushed and counted like the other four since the owner's decision of 2026-10-28.
 */
describe('the owner item push slugs', () => {
  it('maps each of the five kinds to its own slug', () => {
    expect(OWNER_ITEM_PUSH_KINDS).toEqual({
      PROMOTION_APPROVAL: 'approve-merge-to-main',
      COORDINATOR_QUESTION: 'coordinator-question',
      ESCALATED: 'escalated-to-you',
      FUSE_PAUSED: 'fuse-paused',
      LANDED_WITHOUT_CONFIRMATION: 'landed-without-confirmation',
    });
  });

  it('names work that reached main without the owner\'s confirmation landed-without-confirmation', () => {
    const kind: OwnerItemKind = 'LANDED_WITHOUT_CONFIRMATION';
    expect(OWNER_ITEM_PUSH_KINDS[kind]).toBe('landed-without-confirmation');
  });

  it('gives no two kinds the same slug', () => {
    const slugs = Object.values(OWNER_ITEM_PUSH_KINDS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
