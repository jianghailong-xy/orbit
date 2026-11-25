import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SessionSearchHit } from './dto';
import { LEGACY_END_REASONS, SessionEndReason } from './enums';
import type { LinkPreviewSession } from './link-preview';
import type { ControlSessionEnded, ControlSessionSummary } from './realtime';
import type { GuestSessionSummary } from './session-guests';
import {
  SESSION_BACKGROUND_FIELD_NAMES,
  SESSION_PHASE_FIELD_NAMES,
  SESSION_PHASES,
  SESSION_TURN_OUTCOMES,
  SESSION_WAITING_ON,
  type SessionBackgroundFields,
  type SessionPhaseFields,
} from './session-phase';
import type { SessionActivity } from './task-run-reason';

/**
 * Holds the shared session-state vocabulary (session-phase.ts) and the wire types that carry it to
 * contracts/session-state.contract.json, plan step 5.1. The server is held to the same file by
 * src/apiserver/src/sessions/session-payloads-phase.pg.spec.ts, and OrbitKit by SessionStateContractTests.swift.
 */

const ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'contracts/session-state.contract.json'), 'utf8')) as any;

/** The fields on each shared wire type, as a key list the compiler checks: a field leaving a type fails here. */
type Carried<T> = { [K in keyof SessionPhaseFields]-?: K extends keyof T ? true : never };
const ALL = { phase: true, released: true, lastTurnOutcome: true, waitingOn: true, endReason: true, workFinished: true } as const;
const SUMMARY: Carried<ControlSessionSummary> = ALL;
const ENDED: Carried<ControlSessionEnded> = ALL;
const PREVIEW: Carried<LinkPreviewSession> = ALL;
const GUEST: Carried<GuestSessionSummary> = ALL;
const SEARCH: Carried<SessionSearchHit> = ALL;
const SHARED_TYPES: Record<string, Record<string, true>> = {
  ControlSessionSummary: SUMMARY,
  ControlSessionEnded: ENDED,
  LinkPreviewSession: PREVIEW,
  GuestSessionSummary: GUEST,
  SessionSearchHit: SEARCH,
};
/** The Background mark's inputs on each shared wire type, checked the same way. */
type CarriedBackground<T> = { [K in keyof SessionBackgroundFields]-?: K extends keyof T ? true : never };
const BACKGROUND = { activity: true, runningBgCount: true } as const;
const SHARED_BACKGROUND: Record<string, Record<string, true>> = {
  ControlSessionSummary: BACKGROUND satisfies CarriedBackground<ControlSessionSummary>,
  ControlSessionEnded: BACKGROUND satisfies CarriedBackground<ControlSessionEnded>,
  LinkPreviewSession: BACKGROUND satisfies CarriedBackground<LinkPreviewSession>,
  GuestSessionSummary: BACKGROUND satisfies CarriedBackground<GuestSessionSummary>,
  SessionSearchHit: BACKGROUND satisfies CarriedBackground<SessionSearchHit>,
};
/** Every SessionActivity value, as a key list the compiler checks against the type. */
const ACTIVITIES: Record<SessionActivity, true> = { TURN: true, BACKGROUND_JOB: true, WAITING: true };

describe('session-state contract', () => {
  it('is version 1 and points at a document that exists', () => {
    expect(CONTRACT.name).toBe('orbit.session-state');
    expect(CONTRACT.contractVersion).toBe(1);
    expect(existsSync(path.join(ROOT, CONTRACT.doc))).toBe(true);
  });

  it('lists the fields in the order the shared constant names them', () => {
    expect(Object.keys(CONTRACT.fields)).toEqual([...SESSION_PHASE_FIELD_NAMES]);
  });

  it('gives each enum field the shared value list', () => {
    expect(CONTRACT.fields.phase.values).toEqual([...SESSION_PHASES]);
    expect(CONTRACT.fields.phase.sharedConstant).toBe('SESSION_PHASES');
    expect(CONTRACT.fields.waitingOn.values).toEqual([...SESSION_WAITING_ON]);
    expect(CONTRACT.fields.waitingOn.sharedConstant).toBe('SESSION_WAITING_ON');
    expect(CONTRACT.fields.lastTurnOutcome.values).toEqual([...SESSION_TURN_OUTCOMES]);
    expect(CONTRACT.fields.lastTurnOutcome.sharedConstant).toBe('SESSION_TURN_OUTCOMES');
    expect(CONTRACT.fields.released.type).toBe('boolean');
    expect(CONTRACT.fields.workFinished.type).toBe('boolean');
    expect(CONTRACT.fields.workFinished.decidedBy).toBe('releaseFinishedTheWork');
    expect(CONTRACT.fields.endReason.decidedBy).toBe('session.end_reason');
    expect(CONTRACT.fields.endReason.values).toEqual([...Object.values(SessionEndReason), ...LEGACY_END_REASONS]);
  });

  it('never names a release cause or a succeeded word for a session (decisions D9 and D2)', () => {
    const text = JSON.stringify(CONTRACT.fields);
    expect(text).not.toMatch(/releaseCause|release_cause/u);
    expect([...SESSION_PHASES, ...SESSION_WAITING_ON, ...SESSION_TURN_OUTCOMES]).not.toContain('SUCCEEDED');
  });

  it('keeps the legacy fields beside the new ones', () => {
    expect(CONTRACT.legacyFields).toEqual(['status', 'runStatus', 'runState', 'sessionState', 'filingState']);
  });

  it('lists every payload kind with all six fields, and each named shared type carries them', () => {
    expect(Object.keys(CONTRACT.payloads)).toEqual([
      'listRow', 'detail', 'sessionSummary', 'sessionEnded', 'linkPreview', 'guestRow', 'sharedHead', 'taskRun',
      'searchHit',
    ]);
    for (const [kind, payload] of Object.entries<{ sharedType: string | null; fields: string[] }>(CONTRACT.payloads)) {
      expect(payload.fields, kind).toEqual([...SESSION_PHASE_FIELD_NAMES]);
      if (payload.sharedType !== null) {
        expect(SHARED_TYPES[payload.sharedType], `${kind}: ${payload.sharedType} is not a known shared type`).toBeDefined();
        expect(Object.keys(SHARED_TYPES[payload.sharedType]!), kind).toEqual([...SESSION_PHASE_FIELD_NAMES]);
      }
    }
  });

  it('names the Background mark\'s two inputs, and every payload kind and shared type carries them', () => {
    expect(Object.keys(CONTRACT.backgroundFields)).toEqual([...SESSION_BACKGROUND_FIELD_NAMES]);
    expect(CONTRACT.backgroundFields.activity.values).toEqual(Object.keys(ACTIVITIES));
    expect(CONTRACT.backgroundFields.activity.sharedType).toBe('SessionActivity');
    expect(CONTRACT.backgroundFields.activity.decidedBy).toBe('sessionActivitySql');
    expect(CONTRACT.backgroundFields.activity.nullable).toBe(true);
    expect(CONTRACT.backgroundFields.runningBgCount.type).toBe('integer');
    expect(CONTRACT.backgroundFields.runningBgCount.nullable).toBe(false);
    expect(CONTRACT.backgroundFields.runningBgCount.decidedBy).toBe('cardinality(session.running_bg_shells)');
    for (const [kind, payload] of Object.entries<{ sharedType: string | null; background: string[] }>(CONTRACT.payloads)) {
      expect(payload.background, kind).toEqual([...SESSION_BACKGROUND_FIELD_NAMES]);
      if (payload.sharedType !== null) {
        expect(Object.keys(SHARED_BACKGROUND[payload.sharedType]!), kind).toEqual([...SESSION_BACKGROUND_FIELD_NAMES]);
      }
    }
  });

  it('states every vector in the field vocabulary, with the invariants the design holds', () => {
    expect(CONTRACT.vectors.length).toBeGreaterThan(0);
    for (const vector of CONTRACT.vectors) {
      const e = vector.expect;
      expect(Object.keys(e), vector.id).toEqual([...SESSION_PHASE_FIELD_NAMES]);
      expect(SESSION_PHASES, vector.id).toContain(e.phase);
      expect(typeof e.released, vector.id).toBe('boolean');
      if (e.lastTurnOutcome !== null) expect(SESSION_TURN_OUTCOMES, vector.id).toContain(e.lastTurnOutcome);
      if (e.waitingOn !== null) expect(SESSION_WAITING_ON, vector.id).toContain(e.waitingOn);
      if (e.released) expect(e.phase, vector.id).toBe('IDLE');
      if (e.waitingOn === 'HOLD') expect(e.phase, vector.id).toBe('PENDING');
      if (e.waitingOn === 'WAKE') expect(e.phase, vector.id).toBe('IDLE');
      if (e.phase === 'RUNNING') expect([null, 'PERSON'], vector.id).toContain(e.waitingOn);
      expect(typeof e.workFinished, vector.id).toBe('boolean');
      if (e.endReason !== null) expect(CONTRACT.fields.endReason.values, vector.id).toContain(e.endReason);
      // releaseFinishedTheWork: released, and task_done or a landing container with no end reason.
      expect(e.workFinished, vector.id).toBe(e.released
        && (e.endReason === 'task_done' || (vector.given.sessionKind === 'LANDING' && e.endReason === null)));
      // The end reason is the row's, as given.
      expect(e.endReason, vector.id).toBe(vector.given.endReason ?? null);
    }
  });

  it('covers all seven statuses and the four shapes of plan step 5.1', () => {
    const ids = CONTRACT.vectors.map((v: { id: string }) => v.id);
    expect(ids).toEqual(expect.arrayContaining([
      'PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
      'job running', 'waiting on an approval', 'watch armed', 'paused account', 'settled landing',
    ]));
  });
});
