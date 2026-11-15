import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHERE SCHEDULED TASKS MEET THE CONSOLE (docs/mocks/scheduled-tasks/web/02-board.png).
 *
 * The owner's ruling: Scheduled lives in the left navigation only. A workspace's session list carries nothing of it —
 * no entry, no run sessions — and a run's session is reached from its schedule. What the conversation does draw is
 * read from the composition, as the landing's place is (WorkspaceView.landingSession.test.tsx): the cards and change
 * lines a session put up, and in a run's session the crumb, the strip, the report and no session column.
 */

const SOURCE = readFileSync(new URL('./WorkspaceView.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('./Scheduled.css', import.meta.url), 'utf8');

describe('a workspace’s session list', () => {
  it('draws no run session, even one a server sent', () => {
    expect(SOURCE).toContain("const rows = (sessionsQ.data ?? []).filter((row) => row.runSource !== 'SCHEDULE');");
    // Every list the column draws comes from those rows; nothing re-reads the raw answer for rows.
    expect(SOURCE).not.toMatch(/sessionsQ\.data \?\? \[\]\)\.slice\(\)/);
  });

  it('has no Scheduled entry of its own', () => {
    const column = SOURCE.slice(SOURCE.indexOf('<aside className={`session-col'), SOURCE.indexOf('<div className="workspace-header">'));
    expect(column.length).toBeGreaterThan(0);
    expect(column).not.toMatch(/Schedul|SCHEDULE_COPY/);
  });
});

describe('a conversation', () => {
  it('draws its scheduled-task cards and change lines where they happened', () => {
    expect(SOURCE).toContain('const scheduleInserts = useSessionScheduleInserts(selectedTrashed ? null : selectedId, transcriptEvents, scheduleRun);');
    expect(SOURCE).toMatch(/\[\.\.\.decisionReceipts, \.\.\.questionRecords, \.\.\.ownerRequestCards, \.\.\.scheduleInserts,/);
  });

  it('opens Change… with the schedule named in a new conversation’s composer, never a form', () => {
    expect(SOURCE).toContain('const seed = entry?.usr?.composerText;');
    expect(SOURCE).toContain('setText(seed);');
  });
});

describe('a run’s session (board 2/2 ⑤ ⑥)', () => {
  it('is known by the detail’s runSource and finds its run from the session alone', () => {
    expect(SOURCE).toContain("const isScheduleRun = detailForSelected?.runSource === 'SCHEDULE';");
    expect(SOURCE).toContain('useScheduleRunOfSession(isScheduleRun && !selectedTrashed ? selectedId : null)');
    expect(SOURCE).not.toContain("searchParams.get('schedule')");
  });

  it('has the crumb at the head of the header', () => {
    const header = SOURCE.indexOf('<div className="workspace-header-main">');
    const crumb = SOURCE.indexOf('<ScheduleRunCrumb of={scheduleRun} />');
    expect(crumb).toBeGreaterThan(header);
    expect(crumb - header).toBeLessThan(200);
  });

  it('has no Follow chip, and its header line is the run’s: state · agent · duration', () => {
    expect(SOURCE).toContain('!selectedMissing && !isScheduleRun && (\n                <SessionWatchBadges sessionId={selectedId} />');
    expect(SOURCE).toMatch(/: selected && isScheduleRun && scheduleRun\n\s+\? scheduleRunHeadText\(\{\n\s+state: headLifecycleWord,\n\s+engine: scheduleRunAgentName\(scheduleRun, ENGINE_CLI_NAMES\[selectedEngine\] \?\? null\),/);
  });

  it('folds the session column away', () => {
    expect(SOURCE).toContain("${isScheduleRun && !composing ? ' is-schedule-run' : ''}");
    expect(CSS).toContain('.workspace-split.is-schedule-run > .session-col { display: none; }');
  });
});
