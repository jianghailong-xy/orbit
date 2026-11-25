// Board driver: today's web drawing for every fixture row, from the web's own functions, beside the
// board's proposal (rules.mjs). Copied into src/web/src/lib/ and run by capture/web-rows.sh; not product code.
import { readFileSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'vitest';
import { StatusIcon, sessionLine, statusLabel, orbitLinkStateWord } from '../components/WorkspaceView';
import { sessionStatusMeta } from '../components/TaskDetailPanel';
import { taskStatusLabel } from '../components/TaskStatusPill';
import { sessionStateWord, sessionRunStateOf } from './sessionState';
import { sessionNeedsOwner, sessionIsWorking } from './sessionGrouping';
// @ts-expect-error plain module of the board
import { sessionState, sessionMarks, MARKS } from './board-rules.mjs';

const glyphOf = (html: string): string => {
  const icon = /anticon-([a-z-]+)/.exec(html)?.[1] ?? '?';
  const color = /color:\s*var\(--([a-z0-9-]+)\)/.exec(html)?.[1] ?? '';
  const motion = /anticon-spin|status-glyph-active/.test(html) ? (html.includes('anticon-spin') ? ' spin' : ' breathing') : '';
  return `${icon}${motion}${color ? ` (${color})` : ''}`;
};

it('writes the web before/after for every fixture row', () => {
  const rows = JSON.parse(readFileSync(process.env.FIXTURE!, 'utf8'));
  const out = rows.map((r: any) => {
    const p = r.payload;
    const meta = sessionStatusMeta(p);
    const state = sessionRunStateOf(p);
    const line = sessionLine(p, true, null, true, null);
    const after = sessionState(p);
    const marks: string[] | null = sessionMarks(p);
    return {
      row: r.row,
      name: r.name,
      newFields: r.newFields,
      before: {
        rowGlyph: glyphOf(renderToStaticMarkup(<StatusIcon session={p} />)),
        rowLine: `${line.text} [${line.tone}]`,
        header: statusLabel(p),
        runBadge: `${meta.label} [${meta.tone}]`,
        tasksPill: taskStatusLabel('IN_PROGRESS', state === 'RUNNING', state === 'QUEUED', p.waitingOn === 'HOLD'),
        linkCard: orbitLinkStateWord(p),
        sharedHeader: sessionStateWord(p, { canReply: false }),
        group: sessionNeedsOwner(p) ? 'Needs you' : sessionIsWorking(p) ? 'Working' : '-',
      },
      after: after
        ? {
            state: after.word,
            icon: after.icon,
            marks: marks!.map((m) => MARKS[m].word),
            // The group functions do not change; the board shows they are still read off the same facts.
            group: sessionNeedsOwner(p) ? 'Needs you' : sessionIsWorking(p) ? 'Working' : '-',
          }
        : 'unchanged (older server: no facts)',
    };
  });
  writeFileSync(process.env.OUT!, JSON.stringify(out, null, 1));
});
