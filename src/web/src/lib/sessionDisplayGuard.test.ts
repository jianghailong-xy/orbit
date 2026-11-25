import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asksDisplayFirst, sevenStateReads, type ReadSite } from './sessionDisplayGuard';

/**
 * No web surface turns the session facts back into the seven run states to pick a state icon or word (project
 * criterion 3, the approved board docs/mocks/session-display-three-states). The state icon and word come from
 * lib/sessionDisplay's two functions; the seven run states (lib/sessionState) are read only:
 *
 * - DRAWN_FROM_FACTS_FIRST: by a function that draws a state icon or word and asks sessionDisplayState / sessionMarks /
 *   sessionDisplayText BEFORE the read, so the read is reached only for an older server's payload, which carries no
 *   facts and keeps today's drawing (legacyBaseline.test.ts);
 * - NOT_AN_ICON_OR_WORD: by a function that decides something else (what the composer offers, the row's second line,
 *   a card, a group), each with why.
 *
 * A read anywhere else fails here by its file and function. To add one: draw the state from lib/sessionDisplay; or,
 * when the read decides no icon or word, list it under NOT_AN_ICON_OR_WORD with why.
 */

const DRAWN_FROM_FACTS_FIRST: Record<string, string[]> = {
  'components/WorkspaceView.tsx': ['StatusIcon', 'statusLabel', 'orbitLinkStateWord', 'statusGlyphMotion', 'downloadHtml'],
  'components/TaskDetailPanel.tsx': ['sessionStatusMeta', 'runRow', 'TaskDetailPanel'],
  'components/OrbitLinkCard.tsx': ['OrbitLinkCard'],
  'lib/sessionState.ts': ['sessionStateWord'],
  'pages/SharedSessionPage.tsx': ['sharedStateTone'],
};

const NOT_AN_ICON_OR_WORD: Record<string, Record<string, string>> = {
  'lib/sessionState.ts': {
    sessionReadingState: 'the legacy reader itself',
    sessionRunStateOf: 'the legacy reader itself',
    sessionActivityOf: 'the legacy reader itself',
    sessionStateOf: 'deprecated compatibility reader, called by nothing in the product',
    sessionRetryPending: 'whether an armed retry is still believed (the retry card, the ended banner)',
    sessionIsStarting: 'whether the engine has not spoken yet (the Starting line and notice)',
    legacySessionLive: 'held or not, for an older server without `released` (send versus resume)',
    isSessionWorking: 'whether anything runs, for an older server (polling and groups)',
    isSessionBusy: 'whether a turn is queued or dispatched (which run is the task panel\'s live run, Stop)',
    sessionEndedBanner: 'the ended banner\'s prose about how the session ended, not the state word',
  },
  'lib/sessionGrouping.ts': { sessionFailed: 'Needs you group membership, which must not change' },
  'lib/claudeRegion.ts': { claudeRegionHeld: 'whether a queued turn is held for the Claude region (the queue line)' },
  'lib/runnerSlots.ts': { waitingNoticeFor: 'whether the starting/compacting notice shows (the row line, the notice)' },
  'components/RunNeverStartedCard.tsx': {
    applies: 'whether the never-started card shows',
    sourceRefused: 'the never-started card\'s foot sentence',
    regionUnsupported: 'the never-started card\'s cause',
    machineCause: 'the never-started card\'s cause',
    runNeverStarted: 'whether the never-started card shows',
  },
  'components/WikiChatPanel.tsx': { WikiChatSession: 'whether a turn is generating (Stop and the composer)' },
  'components/WorkspaceView.tsx': {
    resumeWords: 'the row\'s second line and the resume strip (content the board keeps)',
    sessionLine: 'the row\'s second line (content the board keeps unchanged)',
    restsForRecap: 'whether the Recap card shows',
    WorkspaceView: 'composer, Stop, queued-turn and export behaviour of the open conversation',
  },
  'pages/SharedTaskPage.tsx': {
    RunRow: 'the public task page: its payload sends a run only as `state`, with none of the facts to read',
  },
};

const SRC = resolve(__dirname, '..');
const productFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return productFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.|fixture|\.d\.ts$|sessionDisplayGuard\.ts$/.test(name) ? [path] : [];
  });

const reads = new Map<string, { source: string; sites: ReadSite[] }>();
for (const path of productFiles(SRC)) {
  const source = readFileSync(path, 'utf8');
  const sites = sevenStateReads(source);
  if (sites.length) reads.set(relative(SRC, path), { source, sites });
}

describe('no surface picks a state icon or word from the seven run states', () => {
  for (const [file, { source, sites }] of reads) {
    it(`${file} reads the seven run states only where listed`, () => {
      const unlisted = sites
        .filter((s) => !DRAWN_FROM_FACTS_FIRST[file]?.includes(s.fn) && !NOT_AN_ICON_OR_WORD[file]?.[s.fn])
        .map((s) => `${file}:${s.line} ${s.fn} reads ${s.reader}`);
      expect(unlisted, 'draw the state from lib/sessionDisplay, or list why this is no icon or word').toEqual([]);
      const ungated = sites
        .filter((s) => DRAWN_FROM_FACTS_FIRST[file]?.includes(s.fn) && !asksDisplayFirst(source, s))
        .map((s) => `${file}:${s.line} ${s.fn} reads ${s.reader} without asking lib/sessionDisplay first`);
      expect(ungated).toEqual([]);
    });
  }

  it('every listed function still reads them (a stale entry would let a new read in unseen)', () => {
    const seen = new Set([...reads].flatMap(([file, { sites }]) => sites.map((s) => `${file} ${s.fn}`)));
    const listed = [
      ...Object.entries(DRAWN_FROM_FACTS_FIRST).flatMap(([file, fns]) => fns.map((fn) => `${file} ${fn}`)),
      ...Object.entries(NOT_AN_ICON_OR_WORD).flatMap(([file, fns]) => Object.keys(fns).map((fn) => `${file} ${fn}`)),
    ];
    expect(listed.filter((entry) => !seen.has(entry))).toEqual([]);
  });
});

describe('the scanner', () => {
  it('names the function a read is in, skips prose and strings, and sees the gate', () => {
    const source = [
      "// sessionRunStateOf(s) in a comment",
      "const word = 'sessionRunStateOf(s)';",
      'export function Glyph({ s }: { s: any }) {',
      '  const shown = sessionDisplayState(s);',
      '  if (shown) return shown.word;',
      '  return `${sessionRunStateOf(s)}`;',
      '}',
      'export const badge = (s: any) => SESSION_STATE_META[sessionReadingState(s)];',
      'function Panel() {',
      '  const row = (s: any) => {',
      '    return sessionRunStateOf(s) === "FAILED";',
      '  };',
      '  return row;',
      '}',
    ].join('\n');
    const sites = sevenStateReads(source);
    expect(sites.map((s) => `${s.fn}:${s.line}:${s.reader}`)).toEqual([
      'Glyph:6:sessionRunStateOf',
      'badge:8:SESSION_STATE_META',
      'badge:8:sessionReadingState',
      'row:11:sessionRunStateOf',
    ]);
    expect(sites.map((s) => asksDisplayFirst(source, s))).toEqual([true, false, false, false]);
  });
});
