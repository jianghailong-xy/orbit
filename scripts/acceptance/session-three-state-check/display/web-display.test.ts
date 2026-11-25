import { readFileSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'vitest';
import { SESSION_MARKS, sessionDisplayState, sessionDisplayText, sessionMarks } from './sessionDisplay';
import { sessionStateWord } from './sessionState';
import { sessionIsWorking, sessionNeedsOwner } from './sessionGrouping';
import { StatusIcon, orbitLinkStateWord, statusLabel } from '../components/WorkspaceView';
import { sessionStatusMeta } from '../components/TaskDetailPanel';

// Copy to src/web/src/lib/ of the checkout under test and run with ROWS=<rows.json> OUT=<result.json>.
const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

it('writes what web draws for every row', () => {
  const rows = JSON.parse(readFileSync(process.env.ROWS!, 'utf8'));
  const out = rows.map((r: any) => {
    const p = r.payload;
    const state = sessionDisplayState(p);
    const marks = sessionMarks(p);
    const surfaces: Record<string, string> = {
      header: statusLabel(p),
      runBadge: sessionStatusMeta(p).label,
      markdownRun: sessionDisplayText(p) ?? sessionStatusMeta(p).label,
      linkCard: orbitLinkStateWord(p),
      sharedPage: sessionStateWord(p, { canReply: false }),
    };
    // The list row's icon as the component draws it: data-state from the facts, else the legacy glyph.
    const icon = renderToStaticMarkup(createElement(StatusIcon, { session: p }));
    return {
      id: r.id, client: 'web', state: state?.word ?? null,
      marks: marks ? marks.map((m) => SESSION_MARKS[m].word) : null,
      drawnIcon: attr(icon, 'data-state'), surfaces,
      group: { needsYou: sessionNeedsOwner(p), working: sessionIsWorking(p) },
    };
  });
  writeFileSync(process.env.OUT!, JSON.stringify(out, null, 1));
});
