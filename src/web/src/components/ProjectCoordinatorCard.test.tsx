import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { SessionLifecycleState, SessionRunState } from '@orbit/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ProjectCoordinatorCard,
  type CoordinatorCardLayout,
  type CoordinatorSession,
  type CoordinatorStatus,
} from './ProjectCoordinatorCard';

/**
 * What each of the four states puts on screen.
 *
 * Every assertion here is a PREDICATE over the rendered output — "this word is inside this
 * element", "this word is not on any button" — never a fixed ordering or a whole paragraph
 * compared verbatim. A test that pins the exact copy passes while the card lies, and fails the
 * moment somebody fixes a typo; these are the four things the old control got wrong, written down
 * so it cannot get them wrong again.
 *
 * NO `../api` MOCK, deliberately, and none is needed: the card takes the payload as a prop and
 * issues no request. The last test in the file holds that property in place.
 */

const READ_AT = '2026-08-24T07:00:00.000Z';
/** 12 minutes before READ_AT, so "last active" is a fixed string rather than a race with the clock. */
const TWELVE_MIN_AGO = '2026-08-24T06:48:00.000Z';

function session(over: Partial<CoordinatorSession> = {}): CoordinatorSession {
  return {
    id: '6ZARyvpxHyfZorIuHMx1I4',
    title: '协调：实施 Project 公平调度域改造',
    runStatus: 'AWAITING_INPUT',
    runState: SessionRunState.AWAITING_INPUT,
    lifecycleState: SessionLifecycleState.OPEN,
    filingState: 'OPEN',
    endReason: null,
    startedAt: TWELVE_MIN_AGO,
    finishedAt: null,
    completedAt: null,
    deletedAt: null,
    engineTurnActive: false,
    pendingApprovals: 0,
    ...over,
  };
}

/** A LIVE payload: pointer set, session reachable, workspace and agent both named. */
function liveStatus(over: Partial<CoordinatorSession> = {}): CoordinatorStatus {
  return {
    projectId: '34CVrUINmbGw6RWddCF0v',
    readAt: READ_AT,
    state: 'LIVE',
    coordination: {
      sessionId: '6ZARyvpxHyfZorIuHMx1I4',
      sessionIdAbsentReason: null,
      session: session(over),
      sessionAbsentReason: null,
      // 0-based: "2" is this project's THIRD coordinator.
      coordinatorGeneration: '2',
      workspaceId: '3CuIHiSJZBQ7nLVUwc7ekz',
      workspaceIdAbsentReason: null,
      workspaceName: 'orbit-main',
      workspaceNameAbsentReason: null,
      agentId: '3CuIHiSJZBQ7nLVUwc7ekz',
      agentIdAbsentReason: null,
      agentName: 'Claude Opus 5',
      agentNameAbsentReason: null,
    },
    openability: {
      canOpen: true,
      willCreate: false,
      refusalCode: null,
      refusalDetail: null,
      refusalCodeAbsentReason: 'NOTHING_REFUSES',
      requiredAction: null,
      requiredActionAbsentReason: 'NOTHING_REFUSES',
      landing: {
        workspaceId: null,
        workspaceIdAbsentReason: 'COORDINATOR_ALREADY_LIVE',
        workspaceName: null,
        workspaceNameAbsentReason: 'COORDINATOR_ALREADY_LIVE',
        agentId: null,
        agentName: null,
        fixed: true,
      },
    },
  };
}

/** Nothing has ever coordinated this project: both pointers null, the landing free but decided. */
function neverOpenedStatus(): CoordinatorStatus {
  const s = liveStatus();
  return {
    ...s,
    state: 'NEVER_OPENED',
    coordination: {
      ...s.coordination,
      sessionId: null,
      sessionIdAbsentReason: 'COORDINATOR_NEVER_OPENED',
      session: null,
      sessionAbsentReason: 'COORDINATOR_NEVER_OPENED',
      coordinatorGeneration: '0',
      workspaceId: null,
      workspaceIdAbsentReason: 'NO_COORDINATION_WORKSPACE',
      workspaceName: null,
      workspaceNameAbsentReason: 'NO_COORDINATION_WORKSPACE',
      agentId: null,
      agentIdAbsentReason: 'NO_COORDINATOR_AGENT',
      agentName: null,
      agentNameAbsentReason: 'NO_COORDINATOR_AGENT',
    },
    openability: {
      ...s.openability,
      willCreate: true,
      landing: {
        workspaceId: '3CuIHiSJZBQ7nLVUwc7ekz',
        workspaceIdAbsentReason: null,
        workspaceName: 'orbit-main',
        workspaceNameAbsentReason: null,
        agentId: null,
        agentName: null,
        fixed: false,
      },
    },
  };
}

/** The pointer names a session in Trash; the workspace survives, so the replacement is fixed. */
function trashedStatus(): CoordinatorStatus {
  const s = liveStatus();
  return {
    ...s,
    state: 'TRASHED',
    coordination: {
      ...s.coordination,
      session: session({
        lifecycleState: SessionLifecycleState.TRASH,
        deletedAt: '2026-08-23T22:00:00.000Z',
      }),
    },
    openability: {
      ...s.openability,
      willCreate: true,
      landing: {
        workspaceId: '3CuIHiSJZBQ7nLVUwc7ekz',
        workspaceIdAbsentReason: null,
        workspaceName: 'orbit-main',
        workspaceNameAbsentReason: null,
        agentId: null,
        agentName: null,
        fixed: true,
      },
    },
  };
}

/** The bound workspace is disabled, so no press can succeed. */
function unavailableStatus(): CoordinatorStatus {
  const s = liveStatus();
  return {
    ...s,
    state: 'UNAVAILABLE',
    coordination: { ...s.coordination, sessionId: null, session: null },
    openability: {
      ...s.openability,
      canOpen: false,
      willCreate: false,
      refusalCode: 'COORDINATOR_UNAVAILABLE',
      refusalDetail: 'WORKSPACE_DISABLED',
      refusalCodeAbsentReason: null,
      requiredAction: 'Enable the workspace, or bind it to a runner.',
      requiredActionAbsentReason: null,
      landing: {
        workspaceId: null,
        workspaceIdAbsentReason: 'LANDING_REFUSED',
        workspaceName: null,
        workspaceNameAbsentReason: 'LANDING_REFUSED',
        agentId: null,
        agentName: null,
        fixed: true,
      },
    },
  };
}

function paint(
  status: CoordinatorStatus,
  opts: { layout?: CoordinatorCardLayout; openTaskCount?: number } = {},
): string {
  return renderToStaticMarkup(
    <ProjectCoordinatorCard
      status={status}
      layout={opts.layout}
      openTaskCount={opts.openTaskCount}
    />,
  );
}

/** Everything a reader can actually read, with the markup taken out. */
const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/** What every button on the card is called. Order-independent on purpose: what matters is that a
 *  given word is, or is not, on ANY of them. */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
  );
}

/**
 * The status pill — its opening tag through its own closing tag.
 *
 * Sliced rather than searched so a test can ask whether the colour and the words are in the SAME
 * element, not merely both somewhere on the page: colour-plus-label is the accessibility claim,
 * and two facts that happen to co-occur do not make it.
 */
function pillOf(html: string): string {
  const start = html.indexOf('<span data-tone=');
  expect(start, 'the card renders a status pill').toBeGreaterThanOrEqual(0);
  const tag = /<(\/?)span\b[^>]*?>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error('unterminated status pill');
}

describe('ProjectCoordinatorCard — NEVER_OPENED', () => {
  it('leads with the fact that nothing here starts on its own', () => {
    expect(text(paint(neverOpenedStatus()))).toContain('never start on their own');
  });

  it('names the workspace it will open in AND says the binding cannot be changed later', () => {
    // The old control decided this silently on the first press and froze it forever.
    const body = text(paint(neverOpenedStatus()));
    expect(body).toContain('orbit-main');
    expect(body).toMatch(/Permanent/);
    expect(body).toMatch(/cannot be moved to another workspace later/);
  });

  it('offers a way to pick a different workspace before that press', () => {
    expect(buttonLabels(paint(neverOpenedStatus()))).toContain('Change');
  });

  it('says why there is nowhere to open, instead of a button that would 400', () => {
    const s = neverOpenedStatus();
    s.openability = {
      ...s.openability,
      canOpen: false,
      refusalCode: 'NO_LANDING_WORKSPACE',
      refusalDetail: 'NO_TASK_ASSIGNEE',
      refusalCodeAbsentReason: null,
      requiredAction: 'Assign a task in this project to an agent first.',
      requiredActionAbsentReason: null,
      landing: {
        workspaceId: null,
        workspaceIdAbsentReason: 'LANDING_REFUSED',
        workspaceName: null,
        workspaceNameAbsentReason: 'LANDING_REFUSED',
        agentId: null,
        agentName: null,
        fixed: false,
      },
    };
    const html = paint(s);
    expect(text(html)).toContain('Assign a task in this project to an agent first.');
    expect(html).toMatch(/<button\b[^>]*\bdisabled\b/);
  });
});

describe('ProjectCoordinatorCard — LIVE', () => {
  it('shows the last activity time AND which coordinator of the project this is', () => {
    const body = text(paint(liveStatus()));
    expect(body).toContain('12m ago');
    expect(body).toContain('3rd coordinator of this project');
  });

  it('names the conversation, the workspace and the agent', () => {
    const body = text(paint(liveStatus()));
    expect(body).toContain('协调：实施 Project 公平调度域改造');
    expect(body).toContain('orbit-main');
    expect(body).toContain('Claude Opus 5');
  });

  it('says how much work waits on it, and that none of it starts by itself', () => {
    const body = text(paint(liveStatus(), { openTaskCount: 8 }));
    expect(body).toContain('8 open tasks are dispatched from here');
    expect(body).toContain('none of them starts automatically');
  });

  it('reads Working while the engine is producing output', () => {
    const html = paint(liveStatus({ runState: SessionRunState.RUNNING, runStatus: 'RUNNING' }));
    expect(pillOf(html)).toContain('Working');
  });

  it('reads Working for a self-driven turn parked at AWAITING_INPUT', () => {
    // engineTurnActive is what tells a background wake-up apart from a turn that has ended.
    const html = paint(liveStatus({ engineTurnActive: true }));
    expect(pillOf(html)).toContain('Working');
  });

  it('reads Needs you when a turn has ended without one', () => {
    expect(pillOf(paint(liveStatus()))).toContain('Needs you');
  });

  it('reads Needs you — not Working — while an approval card is up', () => {
    // An approval blocks INSIDE the turn, so the session is RUNNING the whole time it is waiting.
    // Answering Working there would hide the one state that is actually asking for a person.
    const html = paint(
      liveStatus({ runState: SessionRunState.RUNNING, runStatus: 'RUNNING', pendingApprovals: 1 }),
    );
    expect(pillOf(html)).toContain('Needs you');
    expect(pillOf(html)).not.toContain('Working');
  });

  it('reads Idle for a failed coordinator, which is reopened rather than replaced', () => {
    const html = paint(
      liveStatus({
        runState: SessionRunState.FAILED,
        runStatus: 'FAILED',
        finishedAt: TWELVE_MIN_AGO,
        startedAt: '2026-08-24T06:30:00.000Z',
      }),
    );
    expect(pillOf(html)).toContain('Idle');
  });
});

describe('ProjectCoordinatorCard — TRASHED', () => {
  it('never calls the button Open — there is nothing to open', () => {
    // The old control said "Open coordinator" here and dropped the reader into a blank new
    // session, taking the whole project's discussion out of sight.
    for (const label of buttonLabels(paint(trashedStatus()))) {
      expect(label).not.toMatch(/Open/i);
    }
  });

  it('says in so many words that a new session does not inherit the old conversation', () => {
    expect(text(paint(trashedStatus()))).toContain('does not carry that conversation over');
  });

  it('offers to restore the trashed conversation', () => {
    expect(buttonLabels(paint(trashedStatus()))).toContain('Restore');
  });

  it('counts the replacement from the generation, and drops Restore once it is purged', () => {
    expect(buttonLabels(paint(trashedStatus()))).toContain('Start a 4th coordinator');

    const purged = trashedStatus();
    purged.coordination = {
      ...purged.coordination,
      sessionId: null,
      sessionIdAbsentReason: 'COORDINATOR_SESSION_PURGED',
      session: null,
      sessionAbsentReason: 'COORDINATOR_SESSION_PURGED',
    };
    // Only a session still in Trash can be restored; offering it for a purged one is a dead button.
    expect(buttonLabels(paint(purged))).not.toContain('Restore');
    expect(text(paint(purged))).toContain('does not carry that conversation over');
  });
});

describe('ProjectCoordinatorCard — UNAVAILABLE', () => {
  it('names the workspace and offers no Retry', () => {
    // Retry was the old affordance, and it returned the same 409 forever: the refusal is a
    // property of committed rows, not of the attempt.
    const html = paint(unavailableStatus());
    expect(text(html)).toContain('orbit-main');
    expect(text(html)).not.toMatch(/Retry/i);
  });

  it('gives both ways out — repair the workspace, or bind the project elsewhere', () => {
    const labels = buttonLabels(paint(unavailableStatus()));
    expect(labels).toContain('Enable orbit-main');
    expect(labels.some((l) => /Rebind/i.test(l))).toBe(true);
  });

  it('picks its sentence and its fix from refusalDetail', () => {
    const unbound = unavailableStatus();
    unbound.openability = { ...unbound.openability, refusalDetail: 'WORKSPACE_UNBOUND' };
    expect(text(paint(unbound))).toContain('not bound to a runner');
    expect(buttonLabels(paint(unbound))).toContain('Bind orbit-main to a runner');
  });

  it('offers only a rebind when the workspace itself was forgotten', () => {
    // WORKSPACE_FORGOTTEN is the case with no workspace left to name, which is exactly why it has
    // no repair to offer.
    const forgotten = unavailableStatus();
    forgotten.openability = { ...forgotten.openability, refusalDetail: 'WORKSPACE_FORGOTTEN' };
    forgotten.coordination = {
      ...forgotten.coordination,
      workspaceId: null,
      workspaceIdAbsentReason: 'COORDINATION_WORKSPACE_PURGED',
      workspaceName: null,
      workspaceNameAbsentReason: 'COORDINATION_WORKSPACE_PURGED',
    };
    const labels = buttonLabels(paint(forgotten));
    expect(labels.some((l) => /Rebind/i.test(l))).toBe(true);
    expect(labels.some((l) => /Enable|Restore|Bind .* to a runner/i.test(l))).toBe(false);
    expect(text(paint(forgotten))).toContain('no longer records the workspace');
  });
});

describe('ProjectCoordinatorCard — colour is never the only channel', () => {
  it('carries the label in the same element as the colour, in all four states', () => {
    const cases: Array<[CoordinatorStatus, string, string]> = [
      [neverOpenedStatus(), 'neutral', 'Not started'],
      [liveStatus({ runState: SessionRunState.RUNNING, runStatus: 'RUNNING' }), 'brand', 'Working'],
      [liveStatus(), 'warning', 'Needs you'],
      [trashedStatus(), 'neutral', 'Deleted'],
      [unavailableStatus(), 'error', 'Cannot be opened'],
    ];
    const token: Record<string, string> = {
      neutral: 'var(--text-2)',
      brand: 'var(--brand-strong)',
      warning: 'var(--warning)',
      error: 'var(--error)',
    };

    for (const [status, tone, label] of cases) {
      const pill = pillOf(paint(status));
      expect(pill, `${status.state}/${tone} carries its tone`).toContain(`data-tone="${tone}"`);
      expect(pill, `${status.state}/${tone} carries its colour token`).toContain(token[tone]);
      expect(pill, `${status.state}/${tone} carries its words`).toContain(label);
      // A second channel for the same fact, because Orbit's tokens do not separate under CVD.
      expect(pill).toMatch(/data-glyph="(disc|ring|diamond)"/);
    }
  });

  it('invents no colour of its own — every value it paints is an index.css token', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../index.css', import.meta.url)),
      'utf8',
    );
    const html = [neverOpenedStatus(), liveStatus(), trashedStatus(), unavailableStatus()]
      .map((s) => paint(s))
      .join('');

    const ours = [...html.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(ours.length).toBeGreaterThan(0);
    for (const name of new Set(ours)) {
      expect(css, `${name} is declared in index.css`).toContain(`${name}:`);
    }
    // No literal colours smuggled in beside the tokens. antd supplies its own, so only the card's
    // inline styles are searched.
    for (const style of [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1])) {
      expect(style, 'no hex literal').not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(style, 'no rgb()/hsl() literal').not.toMatch(/\b(rgba?|hsla?)\(/i);
    }
  });
});

describe('ProjectCoordinatorCard — layout', () => {
  it('is a fixed 352px column on desktop and full width when narrow', () => {
    expect(paint(liveStatus(), { layout: 'desktop' })).toMatch(/width:352px/);
    expect(paint(liveStatus(), { layout: 'narrow' })).toMatch(/width:100%/);
  });

  it('says the same things in both layouts', () => {
    for (const status of [neverOpenedStatus(), liveStatus(), trashedStatus(), unavailableStatus()]) {
      const desktop = pillOf(paint(status, { layout: 'desktop' }));
      const narrow = pillOf(paint(status, { layout: 'narrow' }));
      // The surface tint differs (desktop parks this in the header's driving seat); the state it
      // reports must not.
      expect(narrow).toContain(desktop.slice(desktop.indexOf('data-glyph=')));
    }
  });
});

describe('ProjectCoordinatorCard — presentational', () => {
  it('renders all four states with no ../api mock in this file', () => {
    // Criterion 4 restated as something a run can fail on: this file mocks nothing, so a card that
    // reached for the network would throw here rather than in the page that adopts it.
    for (const status of [neverOpenedStatus(), liveStatus(), trashedStatus(), unavailableStatus()]) {
      expect(paint(status).length).toBeGreaterThan(0);
    }
  });

  it('imports neither the api client nor the router', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./ProjectCoordinatorCard.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from '\.\.\/api'/);
    expect(source).not.toMatch(/from 'react-router-dom'/);
    expect(source).not.toMatch(/@tanstack\/react-query/);
  });
});
