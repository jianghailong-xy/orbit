import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHERE SCHEDULED TASKS MEET THE CONSOLE (docs/mocks/scheduled-tasks/web/02-board.png).
 *
 * The owner's rulings: Scheduled lives in the left navigation. A workspace's session list draws no run session among
 * its own; since 2026-11-18 its runs' sessions are listed in one built-in folder, Scheduled runs, and nowhere else.
 * What the conversation does draw is read from the composition, as the landing's place is (WorkspaceView.landingSession.test.tsx): the cards and change
 * lines a session put up, and in a run's session the crumb, the strip, the report and no session column.
 */

const SOURCE = readFileSync(new URL('./WorkspaceView.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('./Scheduled.css', import.meta.url), 'utf8');

describe('a workspace’s session list', () => {
  it('draws run sessions only on the Scheduled runs folder’s page, even ones a server sent elsewhere', () => {
    expect(SOURCE).toContain("const onScheduledRuns = !listProjectId && searchParams.get('folder') === SCHEDULED_RUNS_FOLDER;");
    expect(SOURCE).toContain("const rows = (sessionsQ.data ?? []).filter((row) => (row.runSource === 'SCHEDULE') === onScheduledRuns);");
    expect(SOURCE).toContain('scheduled: onScheduledRuns,');
    // Every list the column draws comes from those rows; nothing re-reads the raw answer for rows.
    expect(SOURCE).not.toMatch(/sessionsQ\.data \?\? \[\]\)\.slice\(\)/);
  });

  it('has one Scheduled runs row on the list, only while the view has a run, and no folder rows on its page', () => {
    expect(SOURCE).toContain('{!listProjectId && !openFolder && !onScheduledRuns && scheduledRuns.length > 0 && scheduledRunsRowView()}');
    expect(SOURCE).toContain('{!listProjectId && !onScheduledRuns && folderListing?.folders.map((row) =>');
    // A run's start reaches no list's stream, so the row's read polls.
    expect(SOURCE).toMatch(/sessionsQuery\(\{ runnerId: runner\.id, workspaceId: scopeWorkspaceId, view: effectiveView, scheduled: true \}\),\n\s+enabled: [^\n]+,\n\s+refetchInterval: 30_000,/);
  });

  it('keeps the folder’s page when the folder is no folder of the workspace’s', () => {
    expect(SOURCE).toContain('if (listProjectId || !folderParam || openFolder || onScheduledRuns || !foldersQ.isSuccess || !scopeWorkspaceId) return;');
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

  it('folds the session column away, unless it was opened from the Scheduled runs folder', () => {
    expect(SOURCE).toContain("${isScheduleRun && !composing && !onScheduledRuns ? ' is-schedule-run' : ''}");
    expect(CSS).toContain('.workspace-split.is-schedule-run > .session-col { display: none; }');
  });
});
