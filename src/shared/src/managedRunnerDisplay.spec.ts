import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Through the package's own entry: what the clients import is the thing under test.
import {
  MANAGED_RUNNER_COPY,
  MANAGED_RUNNER_ROW_TONE,
  firstSessionProvider,
  managedRunnerDisplay,
  managedRunnerRow,
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
  short: Record<string, string>;
  rowTone: Record<string, string>;
  entry: Record<string, string>;
  confirm: Record<string, string>;
  asleep: Record<string, string>;
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

  it('accepts work exactly where the server queues it, and a first session only where the server names what it starts on', () => {
    for (const { name, status, display } of fixture.states) {
      if (!display) continue;
      expect(display.startsNewSession, name).toBe(display.acceptsWork && !!status.firstSessionProvider);
      if (['FAILED', 'FENCING', 'DELETING', 'DELETED', 'NOT_PROVISIONED'].includes(status.managementState)) {
        expect(display.acceptsWork, name).toBe(false);
      }
      // Asleep, a runner the server offers no wake for takes no work: a disabled account's.
      if (['SLEEPING', 'DRAINING'].includes(status.managementState) && !status.actions.canWake) {
        expect(display.acceptsWork, name).toBe(false);
      }
    }
  });

  it('offers a first session before READY when the server names the owner\'s key, and reads an older server by initialProvider', () => {
    const waiting = fixture.states.filter(({ status }) => !status.initialProvider && status.firstSessionProvider);
    expect(waiting.map(({ status }) => status.managementState).sort()).toEqual(['STARTING', 'STARTING', 'WAITING_CAPACITY']);
    for (const { name, display } of waiting) expect(display?.startsNewSession, name).toBe(true);
    // A server from before `firstSessionProvider` sends no such field: the first session waits for READY, as it did.
    for (const { name, status, display } of fixture.states) {
      if (!display) continue;
      const { firstSessionProvider: _named, ...older } = status;
      expect(managedRunnerDisplay(older as ManagedRunnerStatus)?.startsNewSession, name).toBe(display.acceptsWork && !!status.initialProvider);
      expect(firstSessionProvider(older as ManagedRunnerStatus), name).toBe(status.initialProvider);
    }
  });

  it('has one set of action words: the copy the clients render is the copy in the fixture', () => {
    const { title: _title, detail: _detail, short, entry, confirm, asleep, ...actions } = MANAGED_RUNNER_COPY;
    expect(fixture.copy).toEqual(actions);
    expect(fixture.short).toEqual(short);
    expect(fixture.rowTone).toEqual(MANAGED_RUNNER_ROW_TONE);
    expect(fixture.entry).toEqual(entry);
    expect(fixture.confirm).toEqual(confirm);
    expect(fixture.asleep).toEqual(asleep);
  });

  it('gives every display kind but notOffered a short row label, and none reads Offline', () => {
    const kinds = Object.keys(MANAGED_RUNNER_COPY.title).filter((kind) => kind !== 'notOffered').sort();
    expect(Object.keys(MANAGED_RUNNER_COPY.short).sort()).toEqual(kinds);
    expect(Object.keys(MANAGED_RUNNER_ROW_TONE).sort()).toEqual(kinds);
    for (const label of Object.values(MANAGED_RUNNER_COPY.short)) expect(label).not.toMatch(/offline/i);
    expect(MANAGED_RUNNER_COPY.short.sleeping).toBe('Asleep');
    expect(MANAGED_RUNNER_ROW_TONE.sleeping).toBe('idle');
  });

  it("reads the managed runner's machine row by its state, and any other runner as before", () => {
    let asleep = 0;
    for (const { name, status, display } of fixture.states) {
      const runnerId = status.runnerId;
      // Not the managed runner, or no runner at all: shown by its heartbeat.
      expect(managedRunnerRow('another-runner', status), name).toBeNull();
      expect(managedRunnerRow(null, status), name).toBeNull();
      const row = managedRunnerRow(runnerId, status);
      if (!runnerId || !display || display.kind === 'notOffered') {
        expect(row, name).toBeNull();
        continue;
      }
      const kind = display.kind as keyof typeof MANAGED_RUNNER_COPY.short;
      const tone = MANAGED_RUNNER_ROW_TONE[kind];
      expect(row, name).toEqual({
        kind,
        label: fixture.short[kind],
        tone: tone === 'progress' && !display.moving ? 'idle' : tone,
        detail: kind === 'sleeping' && display.acceptsWork ? fixture.asleep.row : null,
        acceptsWork: display.acceptsWork,
        asleep: (kind === 'sleeping' || kind === 'stopping') && display.acceptsWork,
      });
      expect(row!.label, name).not.toMatch(/offline/i);
      if (kind === 'sleeping') {
        expect(row!.tone, name).toBe('idle');
        if (row!.asleep) asleep += 1;
      }
    }
    // A sleeping runner a message wakes is in the fixture, read as asleep and not as a fault.
    expect(asleep).toBeGreaterThan(0);
  });
});
