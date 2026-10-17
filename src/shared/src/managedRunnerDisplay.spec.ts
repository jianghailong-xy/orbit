import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Through the package's own entry: what the clients import is the thing under test.
import {
  MANAGED_RUNNER_COPY,
  managedRunnerDisplay,
  managedRunnersOffered,
  type ManagedRunnerDisplay,
  type ManagedRunnerStatus,
} from './index';

/**
 * `managed-runner-states.fixture.json` is the server state the web and the native clients are both
 * rendered from (the apiserver proves every `status` in it is its own answer). This proves the
 * shared reading of it — the one the web renders, and the one OrbitKit mirrors — case by case.
 */
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'managed-runner-states.fixture.json'), 'utf8'),
) as {
  copy: Record<string, string>;
  capabilities: { name: string; httpStatus: number; body: unknown; offered: boolean }[];
  states: { name: string; status: ManagedRunnerStatus; display: ManagedRunnerDisplay | null }[];
  newer: { name: string; status: ManagedRunnerStatus; display: null }[];
};

describe('managed-runner-states.fixture.json', () => {
  it('every state is displayed exactly as the fixture says', () => {
    expect(fixture.states.length).toBeGreaterThan(0);
    for (const { name, status, display } of fixture.states) {
      expect(managedRunnerDisplay(status), name).toEqual(display);
    }
  });

  it('holds the states the clients were asked to show, Retry on a failure the server allows it for', () => {
    const kinds = new Set(fixture.states.flatMap(({ display }) => (display ? [display.kind] : [])));
    for (const kind of ['preparing', 'waitingCapacity', 'available', 'sleeping', 'waking', 'failed', 'removed'] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    const failed = fixture.states.filter(({ display }) => display?.kind === 'failed');
    expect(failed.some(({ display }) => display!.retry)).toBe(true);
    expect(failed.some(({ display }) => !display!.retry)).toBe(true);
    for (const { status, display } of failed) expect(display!.retry).toBe(status.actions.canRetry);
  });

  it('shows any reason by its sentence, a code it has never heard of included', () => {
    const unknown = fixture.states.filter(({ status }) =>
      ['REASON_FROM_A_NEWER_SERVER', 'ACCOUNT_DISABLED'].includes(status.reason?.code ?? ''));
    expect(unknown.length).toBeGreaterThan(2);
    for (const { status, display } of unknown) expect(display?.detail).toBe(status.reason!.message);
  });

  it("shows no managed UI, and does not fail, for a newer server's state or contract", () => {
    expect(fixture.newer.length).toBeGreaterThan(0);
    for (const { name, status } of fixture.newer) expect(managedRunnerDisplay(status), name).toBeNull();
  });

  it('shows no managed UI for a status that says the switch is off', () => {
    const off = fixture.states.filter(({ status }) => !status.enabled);
    expect(off.length).toBeGreaterThan(0);
    for (const { display } of off) expect(display).toBeNull();
  });

  it('offers managed UI only for a switched-on capability of this contract', () => {
    for (const { name, httpStatus, body, offered } of fixture.capabilities) {
      // A refused read is no capability, whatever its body says.
      expect(managedRunnersOffered(httpStatus === 200 ? body : null), name).toBe(offered);
    }
    expect(fixture.capabilities.filter(({ offered }) => offered)).toHaveLength(1);
    expect(managedRunnersOffered(undefined)).toBe(false);
  });

  it('accepts work exactly where the server queues it, and a first session only once a runtime is known', () => {
    for (const { name, status, display } of fixture.states) {
      if (!display) continue;
      expect(display.startsNewSession, name).toBe(display.acceptsWork && !!status.initialProvider);
      if (['FAILED', 'FENCING', 'DELETING', 'DELETED', 'NOT_PROVISIONED'].includes(status.managementState)) {
        expect(display.acceptsWork, name).toBe(false);
      }
      // Asleep, a runner the server offers no wake for takes no work: a disabled account's.
      if (['SLEEPING', 'DRAINING'].includes(status.managementState) && !status.actions.canWake) {
        expect(display.acceptsWork, name).toBe(false);
      }
    }
  });

  it('has one set of action words: the copy the clients render is the copy in the fixture', () => {
    const { title: _title, detail: _detail, ...actions } = MANAGED_RUNNER_COPY;
    expect(fixture.copy).toEqual(actions);
  });
});
