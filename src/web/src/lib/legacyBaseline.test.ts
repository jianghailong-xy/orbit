import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sessionNeedsOwner, sessionIsWorking } from './sessionGrouping';
import { StatusIcon, statusLabel } from '../components/WorkspaceView';
import { sessionStatusMeta } from '../components/TaskDetailPanel';
import { taskStatusLabel } from '../components/TaskStatusPill';

/**
 * Today's drawn state on web with the session facts absent (an older server): the icon and word of the
 * session list row and header, the task panel's run badge, the Tasks list pill, and the Needs you / Working
 * group of each fixture row. The recorded values are scripts/acceptance/session-three-state-check/
 * legacy-baseline.web.json; they were recorded from this code before any display change, and a later change
 * that moves one of them moves a legacy reading. UPDATE_BASELINE=<file> writes the file instead of comparing.
 */
const DIR = resolve(__dirname, '../../../../scripts/acceptance/session-three-state-check');
const fixture: { name: string; newFields: boolean; payload: Record<string, unknown> }[] = JSON.parse(
  readFileSync(resolve(DIR, 'fixture.json'), 'utf8'),
).filter((r: { newFields: boolean }) => !r.newFields);

const glyphOf = (html: string): string => {
  const classes = [...html.matchAll(/anticon-([a-z-]+)/g)].map((m) => m[1]).filter((c) => c !== 'spin');
  return classes.join('+') || 'none';
};

// The Tasks list pill reads the task's own `running` / `queued` / `queuedOnHold` (an older server sends no queuedOnHold).
const PILLS = [
  { name: 'task running', status: 'IN_PROGRESS', running: true },
  { name: 'task queued, queuedOnHold absent', status: 'OPEN', queued: true },
  { name: 'task queued, queuedOnHold false', status: 'OPEN', queued: true, queuedOnHold: false },
  { name: 'task queued, queuedOnHold true', status: 'OPEN', queued: true, queuedOnHold: true },
  { name: 'task open', status: 'OPEN' },
  { name: 'task failed', status: 'FAILED' },
];

const measure = () => ({
  rows: fixture.map((r) => {
    const p = r.payload;
    return {
      name: r.name,
      icon: glyphOf(renderToStaticMarkup(createElement(StatusIcon, { session: p }))),
      word: statusLabel(p),
      runBadge: sessionStatusMeta(p).label,
      needsYouGroup: sessionNeedsOwner(p),
      workingGroup: sessionIsWorking(p),
    };
  }),
  tasksListPill: PILLS.map(({ name, status, running, queued, queuedOnHold }) => ({
    name,
    word: taskStatusLabel(status, running, queued, queuedOnHold),
  })),
});

describe('web legacy baseline: facts absent', () => {
  it('draws today\'s icon and word for every fixture row, pill and group', () => {
    const got = measure();
    if (process.env.UPDATE_BASELINE) {
      writeFileSync(process.env.UPDATE_BASELINE, JSON.stringify(got, null, 1) + '\n');
      return;
    }
    expect(got).toEqual(JSON.parse(readFileSync(resolve(DIR, 'legacy-baseline.web.json'), 'utf8')));
  });
});
