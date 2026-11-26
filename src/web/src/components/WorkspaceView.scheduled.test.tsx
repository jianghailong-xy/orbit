import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHERE SCHEDULED TASKS MEET THE CONSOLE (docs/mocks/scheduled-tasks/web/02-board.png).
 *
 * The owner's rulings: Scheduled lives in the left navigation. A workspace's session list draws no run session among
 * its own; since 2026-11-18 its runs' sessions are listed in one built-in folder, Scheduled runs, and nowhere else.
 * What the conversation does draw is read from the composition, as the landing's place is (WorkspaceView.landingSession.test.tsx): the cards and change
 * lines a session put up, and in a run's session the strip and the report; its page is otherwise any session's.
 */

const SOURCE = readFileSync(new URL('./WorkspaceView.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('./Scheduled.css', import.meta.url), 'utf8');

describe('a workspace’s session list', () => {
  it('draws run sessions only on the Scheduled runs folder’s page, even ones a server sent elsewhere', () => {
    expect(SOURCE).toContain('const onScheduledRuns = !listProjectId && folderParam === SCHEDULED_RUNS_FOLDER;');
    expect(SOURCE).toContain("row.runSource !== 'SCHEDULE_CHANGE' && (row.runSource === 'SCHEDULE') === onScheduledRuns);");
    expect(SOURCE).toContain('scheduled: onScheduledRuns,');
    // Every list the column draws comes from those rows; nothing re-reads the raw answer for rows.
    expect(SOURCE).not.toMatch(/sessionsQ\.data \?\? \[\]\)\.slice\(\)/);
  });

  it('has one Scheduled runs row on the list, only while the view has a run, and no folder rows on its page', () => {
    // The column's items (docs/session-list-scale-design.md §4): the row, then the folder rows, off its own page.
    expect(SOURCE).toContain('const hasScheduledRuns = scheduledRuns.length > 0;');
    expect(SOURCE).toContain("...(!listProjectId && !openFolder && !onScheduledRuns && hasScheduledRuns\n      ? [{ kind: 'scheduled' as const, key: 'scheduled-runs' }] : []),");
    expect(SOURCE).toContain("case 'scheduled':\n        return scheduledRunsRowView();");
    expect(SOURCE).toContain('...(!listProjectId && !onScheduledRuns ? liveListing.folders.map((row): ColumnItem =>');
    // A run's start reaches no list's stream, so the row's read polls.
    expect(SOURCE).toMatch(/sessionsQuery\(\{ runnerId: runner\.id, workspaceId: scopeWorkspaceId, view: effectiveView, scheduled: true \}\),\n\s+enabled: [^\n]+,\n\s+refetchInterval: 30_000,/);
  });

  it('keeps the folder’s page when the folder is no folder of the workspace’s', () => {
    expect(SOURCE).toContain('if (listProjectId || !folderParam || openFolder || onScheduledRuns || !foldersQ.isSuccess || !scopeWorkspaceId) return;');
  });
});

describe('a conversation', () => {
  it('draws its scheduled-task cards and change lines where they happened', () => {
    expect(SOURCE).toContain('const scheduleCards = useSessionScheduleCards(selectedTrashed ? null : selectedId);');
    expect(SOURCE).toMatch(
      /const scheduleInserts = useSessionScheduleInserts\(\n\s+selectedTrashed \? null : selectedId,\n\s+scheduleCards,\n\s+transcriptEvents,\n\s+scheduleRun,/,
    );
    expect(SOURCE).toMatch(/\[\.\.\.decisionReceipts, \.\.\.questionRecords, \.\.\.ownerRequestCards, \.\.\.scheduleInserts,/);
  });

  it('no longer seeds a new conversation for Change…: that is the schedule’s change conversation (§8.2)', () => {
    expect(SOURCE).not.toContain('composerText');
  });
});

describe('a run’s session (board 2/2 ⑤ ⑥)', () => {
  it('is known by the detail’s runSource and finds its run from the session alone', () => {
    expect(SOURCE).toContain("const isScheduleRun = detailForSelected?.runSource === 'SCHEDULE';");
    expect(SOURCE).toContain('useScheduleRunOfSession(isScheduleRun && !selectedTrashed ? selectedId : null, scheduleCards)');
    expect(SOURCE).not.toContain("searchParams.get('schedule')");
  });

  it('has an ordinary session’s header: no crumb, its own line and its Follow chip (owner 2026-11-19)', () => {
    expect(SOURCE).not.toContain('ScheduleRunCrumb');
    expect(SOURCE).not.toContain('scheduleRunHeadText');
    expect(SOURCE).toContain('!composing && selectedId && !selectedTrashed && !selectedMissing && (\n                <SessionWatchBadges sessionId={selectedId} follow={isMobile} />');
  });

  it('keeps the session column: a run’s session is an ordinary session page (owner 2026-11-19)', () => {
    expect(SOURCE).not.toContain('is-schedule-run');
    expect(CSS).not.toContain('is-schedule-run');
  });
});
