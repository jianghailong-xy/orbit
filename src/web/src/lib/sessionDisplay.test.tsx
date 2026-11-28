// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { LinkPreview } from '@orbit/shared';
import { SESSION_MARKS, sessionDisplayState, sessionDisplayText, sessionMarks, sessionRowIcons, sessionRowMarks } from './sessionDisplay';
import { sessionStateWord } from './sessionState';
import { sessionIsWorking, sessionNeedsOwner } from './sessionGrouping';
import { SITUATIONS } from './sessionPhaseFields.fixture';
import { StatusIcon, orbitLinkStateWord, statusGlyphMotion, statusLabel } from '../components/WorkspaceView';
import { sessionStatusMeta, taskMarkdown } from '../components/TaskDetailPanel';
import { TaskStatusPill } from '../components/TaskStatusPill';
import { OrbitLinkCard } from '../components/OrbitLinkCard';
import { SharedSessionStatus } from '../pages/SharedSessionPage';

// Static markup draws no tip: the mock leaves each one's words on the element it wraps.
vi.mock('../components/ui/Tooltip', async (importOriginal) => {
  const { cloneElement } = await import('react');
  return {
    ...(await importOriginal<typeof import('../components/ui/Tooltip')>()),
    Tooltip: ({ children, content }: { children: import('react').ReactElement; content: unknown }) =>
      cloneElement(children, { 'data-tip': typeof content === 'string' ? content : undefined } as object),
  };
});

/**
 * The approved board on web (docs/mocks/session-display-three-states, capture/rules.mjs without its Disconnected mark):
 * every surface that draws a session's state, on every row of the comparison rig's table
 * (scripts/acceptance/session-three-state-check/fixture.json, session payloads as the server sends them), with the
 * six facts present and absent.
 *
 * Facts present: the state icon and word are `phase` alone, the marks are the facts, and the Needs you / Working
 * groups keep the members they had. Facts absent (an older server): the two functions answer null and every surface
 * draws what it drew before this change, recorded per row in the board's capture (capture/web-rows.json, the web's
 * own functions run on the fixture before any display change).
 */

const DIR = resolve(__dirname, '../../../../scripts/acceptance/session-three-state-check');
type Row = { name: string; newFields: boolean; payload: Record<string, any>; row: number };
const fixture: Row[] = (JSON.parse(readFileSync(resolve(DIR, 'fixture.json'), 'utf8')) as Omit<Row, 'row'>[]).map(
  (r, i) => ({
    ...r,
    row: i + 1,
    // The server's list row sends `engineTurnActive` for a parked session whose engine started its own turn
    // (sessions.service.ts, the list projection); the rig left it out and the board's fixture adds it to rows 27/28.
    payload: i + 1 === 27 || i + 1 === 28 ? { ...r.payload, engineTurnActive: true } : r.payload,
  }),
);

type Group = 'Needs you' | 'Working' | '-';
const groupOf = (p: Record<string, any>): Group =>
  sessionNeedsOwner(p as never) ? 'Needs you' : sessionIsWorking(p as never) ? 'Working' : '-';

/** The board's after column, per row with the facts: state, icon, marks, the list row's title-line icons (Interrupted,
 *  Finished and Ended are not drawn; Background and Will resume are icons, and a list row draws Failed, Retrying and
 *  On hold as icons too: the owner, 2026-11-27); and the group, the same before and after. */
const AFTER: Record<number, { state: string; icon: string; marks: string[]; icons?: string[]; group: Group }> = {
  1: { state: 'Queued', icon: 'clock', marks: [], group: 'Working' },
  3: { state: 'Running', icon: 'spinner', marks: [], group: 'Working' },
  5: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  7: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  9: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  11: { state: 'Idle', icon: 'message', marks: ['Failed'], icons: ['FAILED'], group: 'Needs you' },
  13: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  15: { state: 'Running', icon: 'spinner', marks: [], icons: ['BACKGROUND'], group: 'Working' },
  17: { state: 'Running', icon: 'spinner', marks: ['Needs you'], group: 'Needs you' },
  19: { state: 'Queued', icon: 'clock', marks: ['On hold'], icons: ['ON_HOLD'], group: 'Working' },
  21: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  23: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  25: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  27: { state: 'Running', icon: 'spinner', marks: [], group: 'Working' },
  29: { state: 'Running', icon: 'spinner', marks: [], group: 'Working' },
  31: { state: 'Idle', icon: 'message', marks: [], icons: ['WILL_RESUME'], group: '-' },
  33: { state: 'Idle', icon: 'message', marks: [], group: '-' },
  35: { state: 'Idle', icon: 'message', marks: [], group: '-' },
};

/** What web drew before this change for each row without the facts (capture/web-rows.json): the row glyph, the
 *  header word, the run badge, the link card word, the shared header word (a public reader), and the group. */
const BEFORE: Record<number, [glyph: string, header: string, runBadge: string, linkCard: string, shared: string, group: Group]> = {
  2: ['clock-circle', 'Queued', 'Queued', 'Queued', 'Queued', 'Working'],
  4: ['loading', 'Running', 'Running', 'Running', 'Running', 'Working'],
  6: ['message', 'Waiting for your reply', 'Awaiting reply', 'Waiting for your reply', 'Waiting for owner', '-'],
  8: ['minus-circle', 'Interrupted', 'Interrupted', 'Interrupted', 'Interrupted', '-'],
  10: ['check-circle', 'Finished', 'Finished', 'Finished', 'Finished', '-'],
  12: ['close-circle', 'Failed', 'Failed', 'Failed', 'Failed', 'Needs you'],
  14: ['check-circle', 'Ended', 'Ended', 'Ended', 'Ended', '-'],
  16: ['code', 'Background process running', 'Awaiting reply', 'Background process running', 'Running in background', '-'],
  18: ['pause-circle', 'Waiting for approval', 'Running', 'Waiting for approval', 'Running', 'Needs you'],
  20: ['clock-circle', 'Queued', 'Queued', 'Queued', 'Queued', 'Working'],
  22: ['close-circle', 'Failed', 'Failed', 'cancel not honored', 'Failed', 'Needs you'],
  24: ['check-circle', 'Finished', 'Finished', 'Finished', 'Finished', '-'],
  26: ['check-circle', 'Ended', 'Ended', 'Ended', 'Ended', '-'],
  28: ['loading', 'Running', 'Awaiting reply', 'Running', 'Running', '-'],
  30: ['loading', 'Running Agent', 'Awaiting reply', 'Running Agent', 'Running', '-'],
  32: ['eye', 'Waiting to resume', 'Awaiting reply', 'Waiting to resume', 'Waiting to resume', '-'],
  34: ['check-circle', 'Ended', 'Ended', 'Ended', 'Ended', '-'],
  36: ['check-circle', 'Ended', 'Ended', 'Ended', 'Ended', '-'],
};

const antGlyph = (html: string): string =>
  [...html.matchAll(/anticon-([a-z-]+)/g)].map((m) => m[1]).filter((c) => c !== 'spin')[0] ?? 'none';
const marksIn = (html: string): string[] => [...html.matchAll(/data-mark="([A-Z_]+)"/g)].map((m) => m[1]);
const markWords = (p: Record<string, any>) => (sessionMarks(p) ?? []).map((m) => SESSION_MARKS[m].word);

const sessionPreview = (p: Record<string, any>): LinkPreview =>
  ({
    kind: 'session',
    id: 's',
    state: 'ok',
    session: {
      pendingApprovals: 0, runningBgCount: 0, runningBgJobCount: 0, watching: null, waitingKind: null,
      workspace: { id: 'w', name: 'orbit-ws01' }, model: null, numTurns: 1, createdAt: '2026-11-24T00:00:00Z',
      ...p, id: 's', title: 'Session',
    },
  }) as unknown as LinkPreview;
const linkCardHead = (p: Record<string, any>): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <OrbitLinkCard
        link={{ target: { kind: 'session', id: '0190a5b4-0000-7000-8000-000000000001' }, source: { kind: 'url', url: 'http://h/sessions/s' } } as never}
        preview={sessionPreview(p)}
        host="h"
        stateWord={orbitLinkStateWord}
      />
    </MemoryRouter>,
  );
const runsLine = (p: Record<string, any>): string =>
  taskMarkdown({ title: 'T', status: 'IN_PROGRESS', sessions: [{ ...p, createdAt: null, workspace: { name: 'orbit-ws01' } }] }, 'L')
    .split('\n')
    .find((l) => l.startsWith('- ') && l.endsWith('· orbit-ws01'))!;

describe('the board on web: facts present', () => {
  for (const r of fixture.filter((f) => f.newFields)) {
    const want = AFTER[r.row];
    it(`row ${r.row} ${r.name}: ${want.state}${want.marks.length ? ` + ${want.marks.join(', ')}` : ''}`, () => {
      const p = r.payload;
      // The two functions.
      expect(sessionDisplayState(p)).toMatchObject({ word: want.state, icon: want.icon, phase: p.phase });
      expect(markWords(p)).toEqual(want.marks);
      expect(sessionRowIcons(p)).toEqual(want.icons ?? []);
      // A list row draws Failed, Retrying and On hold as title-line icons, so its chips are the marks less those.
      expect((sessionRowMarks(p) ?? []).map((m) => SESSION_MARKS[m].word)).toEqual(want.marks.filter((m) => m === 'Needs you'));
      const text = [want.state, ...want.marks].join(' · ');
      // Session list row: the state icon from phase alone, and the marks after its line.
      const glyph = renderToStaticMarkup(<StatusIcon session={p} />);
      expect(glyph).toContain(`data-state="${p.phase}"`);
      expect(antGlyph(glyph)).toBe(want.icon === 'clock' ? 'clock-circle' : want.icon === 'spinner' ? 'loading' : 'message');
      expect(statusGlyphMotion(p)).toBe(want.icon === 'spinner' ? 'spinner' : null);
      // Session header, search palette, local status: the state word.
      expect(statusLabel(p)).toBe(want.state);
      // Task panel run badge: the state word, blue only while it runs; the Markdown Runs line: word · marks.
      expect(sessionStatusMeta(p)).toEqual({ label: want.state, tone: want.state === 'Running' ? 'blue' : 'muted' });
      expect(runsLine(p)).toBe(`- ${text} · — · orbit-ws01`);
      // Link card: the state pill and the marks; its text form (a task's last run, a project's coordinator).
      expect(orbitLinkStateWord(p)).toBe(text);
      const card = linkCardHead(p);
      expect(card).toContain(`>${want.state}</span>`);
      expect(card).toContain(`olc-state is-${want.state === 'Running' ? 'live' : 'idle'}`);
      expect(marksIn(card).map((m) => SESSION_MARKS[m as never].word)).toEqual(want.marks);
      // Shared and guest page header: the pill says the state word, the marks follow.
      expect(sessionStateWord(p, { canReply: false })).toBe(want.state);
      const shared = renderToStaticMarkup(<SharedSessionStatus head={p} canReply={false} />);
      expect(shared).toContain(want.state);
      expect(marksIn(shared).map((m) => SESSION_MARKS[m as never].word)).toEqual(want.marks);
      // The groups keep their members.
      expect(groupOf(p)).toBe(want.group);
    });
  }
});

describe('the board on web: facts absent (an older server) draws what it drew before', () => {
  for (const r of fixture.filter((f) => !f.newFields)) {
    const [glyph, header, runBadge, linkCard, shared, group] = BEFORE[r.row];
    it(`row ${r.row} ${r.name}: ${header}`, () => {
      const p = r.payload;
      expect(sessionDisplayState(p)).toBeNull();
      expect(sessionMarks(p)).toBeNull();
      expect(sessionRowIcons(p)).toEqual([]);
      expect(sessionDisplayText(p)).toBeNull();
      const icon = renderToStaticMarkup(<StatusIcon session={p} />);
      expect(antGlyph(icon)).toBe(glyph);
      expect(icon).not.toContain('data-state=');
      expect(statusLabel(p)).toBe(header);
      expect(sessionStatusMeta(p).label).toBe(runBadge);
      expect(runsLine(p)).toBe(`- ${runBadge} · — · orbit-ws01`);
      expect(orbitLinkStateWord(p)).toBe(linkCard);
      const card = linkCardHead(p);
      expect(card).toContain(`data-tip="${linkCard}">${linkCard}</span>`);
      expect(marksIn(card)).toEqual([]);
      expect(sessionStateWord(p, { canReply: false })).toBe(shared);
      expect(marksIn(renderToStaticMarkup(<SharedSessionStatus head={p} canReply={false} />))).toEqual([]);
      expect(groupOf(p)).toBe(group);
    });
  }
});

describe('the marks the fixture has no row for, on server-shaped payloads', () => {
  const failed = SITUATIONS['released by a failed turn'];
  it('a released failure the server will retry (waitingOn WAKE, retry armed) is Idle + Retrying, still in Working', () => {
    const p = { ...failed, waitingOn: 'WAKE', retryAt: new Date(Date.now() + 30_000).toISOString() };
    expect(sessionDisplayState(p)?.word).toBe('Idle');
    expect(markWords(p)).toEqual(['Retrying']);
    expect(sessionRowIcons(p)).toEqual(['RETRYING']);
    expect(sessionRowMarks(p)).toEqual([]);
    expect(statusLabel(p)).toBe('Idle');
    expect(groupOf(p)).toBe('Working');
  });
  it('a released failure whose runner went offline is the red Failed mark like any other (no Disconnected)', () => {
    const p = { ...failed, error: 'runner offline' };
    expect(markWords(p)).toEqual(['Failed']);
    expect(SESSION_MARKS.FAILED.tone).toBe('red');
    expect(statusLabel(p)).toBe('Idle');
    expect(orbitLinkStateWord(p)).toBe('Idle · Failed');
    expect(groupOf(p)).toBe('Needs you');
  });
  it('a filed (Completed) session says its state, then Completed after it, never instead of it', () => {
    const p = { ...SITUATIONS['released by End'], lifecycleState: 'COMPLETED', completedAt: '2026-11-24T00:00:00Z' };
    expect(sessionStateWord(p)).toBe('Idle');
    const shared = renderToStaticMarkup(<SharedSessionStatus head={p} canReply={false} />);
    expect(shared.indexOf('Idle')).toBeLessThan(shared.indexOf('Completed'));
    expect(marksIn(shared)).toEqual([]);
  });
});

describe('the Tasks list pill', () => {
  const pill = (props: Parameters<typeof TaskStatusPill>[0]) => renderToStaticMarkup(<TaskStatusPill {...props} />);
  it('a held queued run reads Queued with the On hold mark beside it (the server sends queuedOnHold)', () => {
    const html = pill({ status: 'OPEN', queued: true, queuedOnHold: true });
    expect(html).toContain('data-state="PENDING"');
    expect(html).toContain('anticon-clock-circle');
    expect(html).toContain('Queued</span>');
    expect(marksIn(html)).toEqual(['ON_HOLD']);
  });
  it('a running or queued run with nothing held reads its state alone', () => {
    expect(pill({ status: 'IN_PROGRESS', running: true, queuedOnHold: false })).toContain('Running');
    expect(marksIn(pill({ status: 'IN_PROGRESS', running: true, queuedOnHold: false }))).toEqual([]);
    expect(marksIn(pill({ status: 'OPEN', queued: true, queuedOnHold: false }))).toEqual([]);
  });
  it('from an older server (no queuedOnHold) and for a task with no live run, the pill as before', () => {
    expect(pill({ status: 'OPEN', queued: true })).toContain('Queued');
    expect(marksIn(pill({ status: 'OPEN', queued: true }))).toEqual([]);
    expect(pill({ status: 'DONE' })).toContain('Done');
  });
});
