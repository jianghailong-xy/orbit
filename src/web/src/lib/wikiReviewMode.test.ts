import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WIKI_LIMITS,
  WIKI_MAINTENANCE_DAILY_RUN_LIMIT,
  WIKI_REJECT_REASON_LABELS,
  WIKI_REJECT_REASONS,
  WIKI_REVIEW_RULES,
  WIKI_DEFAULT_MAINTENANCE_SETTINGS,
  WIKI_DEFAULT_SPACE_SETTINGS,
  type WikiAnchor,
  type WikiChangeset,
  type WikiEntry,
  type WikiReviewMode,
  type WikiSpaceSettings,
} from '@orbit/shared';
import { WIKI_REVIEW_REJECT } from './wiki';
import {
  WIKI_AMEND,
  WIKI_AMEND_NOTE,
  WIKI_CANCEL,
  WIKI_CHALLENGED,
  WIKI_CHALLENGE_WAITS,
  WIKI_CONFIRM,
  WIKI_CONFIRMED,
  WIKI_DAILY_LIMIT,
  WIKI_DAILY_LIMIT_NOTE,
  WIKI_DEFAULT_REVIEW_MODE,
  WIKI_FLOORS_LEAD,
  WIKI_FLOORS_NOTE,
  WIKI_MAINTENANCE_EDIT,
  WIKI_MAINTENANCE_NAME,
  WIKI_MAINTENANCE_NOTE,
  WIKI_MODE_DEFAULT,
  WIKI_MODE_LABELS,
  WIKI_MODE_NOTES,
  WIKI_MODE_ORDER,
  WIKI_NOT_SENT_UNREVIEWED,
  WIKI_OFF,
  WIKI_ON,
  WIKI_OPEN_SESSION,
  WIKI_PROVIDER,
  WIKI_PROVIDER_NOTE,
  WIKI_RECONFIRM,
  WIKI_REJECTED,
  WIKI_REJECT_ON_RECORD,
  WIKI_RETIRE,
  WIKI_REVERTED,
  WIKI_REVERT_KEEPS,
  WIKI_REVERT_RUN,
  WIKI_REVERT_RUN_CONFIRM,
  WIKI_REVERT_TITLE,
  WIKI_REVIEW_MODE_HINT,
  WIKI_REVIEW_MODE_LEAD,
  WIKI_RUNS_A_DAY,
  WIKI_RUN_ADDED,
  WIKI_RUN_AMENDED,
  WIKI_RUN_REINFORCED,
  WIKI_SAVE,
  WIKI_SETTINGS,
  WIKI_SETTINGS_SECTIONS,
  WIKI_SETTINGS_TITLE,
  WIKI_SET_UP,
  WIKI_SET_UP_TITLE,
  WIKI_SPOT_CHECK,
  WIKI_SPOT_CHECK_NOTE,
  WIKI_STATUS,
  WIKI_TURN_OFF,
  WIKI_TURN_ON,
  WIKI_VIEW_RUN,
  WIKI_WORKSPACE,
  WIKI_WORKSPACE_NOTE,
  wikiBrokenAnchors,
  wikiCanConfirm,
  wikiChallengeRef,
  wikiCheckedLine,
  wikiCheckedOnMain,
  wikiEntryAnswerable,
  wikiIsRun,
  wikiMarkBanner,
  wikiModeFallback,
  wikiProviderLabel,
  wikiRecentRows,
  wikiRevertBody,
  wikiRunCounts,
  wikiRunKicker,
  wikiRunSummary,
  wikiRunWhen,
  wikiRunsADay,
  wikiAppliedChanges,
  wikiWorkspaceLabel,
  WIKI_SETTINGS_NUMBERS,
} from './wikiReviewMode';

/**
 * The review mode's words and readings, proved against `src/shared/src/wiki-review-mode.fixture.json`
 * — the same cases OrbitKit's `WikiReviewModeCopyParityTests` reads, so the settings page, an entry's
 * marks, one run's counts and a challenge's anchors are said one way on both clients.
 */

interface Fixture {
  settings: {
    title: string;
    crumb: string;
    sections: string[];
    reviewModeHint: string;
    lead: string;
    defaultTag: string;
    modes: Array<{ mode: WikiReviewMode; label: string; note: string; default: boolean }>;
    spotCheck: { title: string; note: string };
    floors: { lead: string; note: string };
    maintenance: {
      name: string;
      note: string;
      off: string;
      on: string;
      setUp: string;
      form: {
        title: string;
        fields: Array<{ label: string; note: string }>;
        unit: string;
        cancel: string;
        turnOn: string;
        save: string;
        defaults: { provider: string; dailyRunLimit: number; min: number; max: number };
      };
      rows: string[];
      edit: string;
      turnOff: string;
      runsADay: Array<{ runs: number; says: string }>;
      workspaceLabels: Array<{ workspace: Parameters<typeof wikiWorkspaceLabel>[0]; says: string }>;
      providerLabels: Array<{ provider: string; model: string | null; says: string }>;
    };
    fallbacks: Array<{ settings: Partial<WikiSpaceSettings>; says: string | null }>;
  };
  answers: { confirm: string; reject: string; confirmed: string; rejected: string; reasons: string[]; foot: string };
  marks: Array<{
    name: string;
    entry: Pick<WikiEntry, 'status' | 'trust' | 'tainted'>;
    confirm: boolean;
    reject: boolean;
    banner: { tone: string; lead: string; text: string } | null;
    whereUsed: string | null;
  }>;
  checkedLines: Array<{
    verification: { verdict: string; model: string } | null;
    tainted: boolean;
    who: string | null;
    when: string | null;
    says: string;
  }>;
  runs: Array<{
    name: string;
    changeset: WikiChangeset;
    entries: WikiEntry[];
    isRun: boolean;
    kicker: string;
    title: string;
    when: string;
    counts: string[];
    added: string[];
    amended: string[];
    reinforced: string[];
    marks: Record<string, string | null>;
    revert: string;
  }>;
  revertDialog: {
    title: string;
    keeps: string;
    confirm: string;
    cancel: string;
    action: string;
    view: string;
    openSession: string;
    reverted: string;
    groups: string[];
  };
  recent: Array<{
    name: string;
    items: Array<{ opId: string; at: string }>;
    runs: string[];
    rows: Array<{ run?: string; at?: string; items?: string[]; op?: string }>;
  }>;
  challenge: { answers: string[]; waits: string; challenged: string; amendNote: string };
  challenges: Array<{
    name: string;
    anchors: WikiAnchor[];
    broken: Array<{ state: string; label: string }>;
    ref: string | null;
    checkedOn: string | null;
  }>;
}

function fixture(): Fixture {
  // Vitest runs from src/web; the path is tried from the repository root too, so the test reads the
  // one file whichever directory it is started in.
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-review-mode.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-review-mode.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-review-mode.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

/** Run `fn` with the process in `tz`: Node re-reads `process.env.TZ` on the next Date call. */
function inTimeZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const shared = fixture();

describe('the Wiki settings page says the fixture’s words, in its order', () => {
  const settings = shared.settings;

  it('titles the page and its two sections in the order both clients draw them', () => {
    expect(WIKI_SETTINGS_TITLE).toBe(settings.title);
    expect(WIKI_SETTINGS).toBe(settings.crumb);
    expect([...WIKI_SETTINGS_SECTIONS]).toEqual(settings.sections);
    expect(WIKI_REVIEW_MODE_HINT).toBe(settings.reviewModeHint);
    expect(WIKI_REVIEW_MODE_LEAD).toBe(settings.lead);
    expect(WIKI_MODE_DEFAULT).toBe(settings.defaultTag);
  });

  it('lists Manual, Tiered, Automatic — each with its one sentence, Tiered the default', () => {
    expect([...WIKI_MODE_ORDER]).toEqual(settings.modes.map((mode) => mode.mode));
    for (const mode of settings.modes) {
      expect(WIKI_MODE_LABELS[mode.mode]).toBe(mode.label);
      expect(WIKI_MODE_NOTES[mode.mode]).toBe(mode.note);
      expect(mode.mode === WIKI_DEFAULT_REVIEW_MODE).toBe(mode.default);
    }
    // The default the page tags is the one a new space is written with.
    expect(WIKI_DEFAULT_REVIEW_MODE).toBe(WIKI_DEFAULT_SPACE_SETTINGS.reviewMode);
  });

  it('says the spot check and the floors in the confirmed words, with the numbers the rules hold', () => {
    expect(WIKI_SPOT_CHECK).toBe(settings.spotCheck.title);
    expect(WIKI_SPOT_CHECK_NOTE).toBe(settings.spotCheck.note);
    expect(WIKI_FLOORS_LEAD).toBe(settings.floors.lead);
    expect(WIKI_FLOORS_NOTE).toBe(settings.floors.note);
    // A sentence quoting a number is only true while the rule is that number.
    expect(WIKI_SPOT_CHECK_NOTE).toContain(`1 in ${WIKI_SETTINGS_NUMBERS.automaticSpotCheckEvery} `);
    expect(WIKI_SETTINGS_NUMBERS.automaticSpotCheckEvery).toBe(WIKI_REVIEW_RULES.automaticSpotCheckEvery);
    expect(WIKI_SPOT_CHECK_NOTE).toContain(`the ${WIKI_LIMITS.pendingOpsPerSpace} waiting`);
    expect(WIKI_FLOORS_NOTE).toContain(`more than ${WIKI_REVIEW_RULES.breakerMaxChangedPercent}% of the wiki`);
    expect(WIKI_DAILY_LIMIT_NOTE).toContain(`at most ${WIKI_LIMITS.opsPerChangeset} changes`);
  });

  it('draws maintenance off, its Set up form and its rows once it is on', () => {
    const maintenance = settings.maintenance;
    expect(WIKI_MAINTENANCE_NAME).toBe(maintenance.name);
    expect(WIKI_MAINTENANCE_NOTE).toBe(maintenance.note);
    expect(WIKI_OFF).toBe(maintenance.off);
    expect(WIKI_ON).toBe(maintenance.on);
    expect(WIKI_SET_UP).toBe(maintenance.setUp);
    expect(WIKI_SET_UP_TITLE).toBe(maintenance.form.title);
    expect(
      [
        [WIKI_WORKSPACE, WIKI_WORKSPACE_NOTE],
        [WIKI_PROVIDER, WIKI_PROVIDER_NOTE],
        [WIKI_DAILY_LIMIT, WIKI_DAILY_LIMIT_NOTE],
      ].map(([label, note]) => ({ label, note })),
    ).toEqual(maintenance.form.fields);
    expect(WIKI_RUNS_A_DAY).toBe(maintenance.form.unit);
    expect([WIKI_CANCEL, WIKI_TURN_ON, WIKI_SAVE]).toEqual([
      maintenance.form.cancel,
      maintenance.form.turnOn,
      maintenance.form.save,
    ]);
    expect([WIKI_STATUS, WIKI_WORKSPACE, WIKI_PROVIDER, WIKI_DAILY_LIMIT]).toEqual(maintenance.rows);
    expect([WIKI_MAINTENANCE_EDIT, WIKI_TURN_OFF]).toEqual([maintenance.edit, maintenance.turnOff]);
    // The form opens on the contract's defaults and bounds.
    expect(WIKI_DEFAULT_MAINTENANCE_SETTINGS.provider).toBe(maintenance.form.defaults.provider);
    expect(WIKI_DEFAULT_MAINTENANCE_SETTINGS.dailyRunLimit).toBe(maintenance.form.defaults.dailyRunLimit);
    expect(WIKI_MAINTENANCE_DAILY_RUN_LIMIT).toEqual({ min: maintenance.form.defaults.min, max: maintenance.form.defaults.max });
    for (const row of maintenance.runsADay) expect(wikiRunsADay(row.runs)).toBe(row.says);
    for (const row of maintenance.workspaceLabels) expect(wikiWorkspaceLabel(row.workspace)).toBe(row.says);
    for (const row of maintenance.providerLabels) expect(wikiProviderLabel(row.provider, row.model)).toBe(row.says);
  });

  it('explains a mode the space switched back to on its own, and nothing the owner chose', () => {
    inTimeZone('UTC', () => {
      for (const row of settings.fallbacks) {
        const read = { ...WIKI_DEFAULT_SPACE_SETTINGS, ...row.settings } as WikiSpaceSettings;
        expect(wikiModeFallback(read), JSON.stringify(row.settings)).toBe(row.says);
      }
    });
  });
});

describe('an entry’s marks and the owner’s answers', () => {
  it('offers Confirm and Reject — and the bar — exactly where the fixture does', () => {
    for (const mark of shared.marks) {
      expect(wikiCanConfirm(mark.entry), mark.name).toBe(mark.confirm);
      expect(wikiEntryAnswerable(mark.entry), mark.name).toBe(mark.reject);
      expect(wikiMarkBanner(mark.entry), mark.name).toEqual(mark.banner);
      const whereUsed = mark.entry.status === 'active' && mark.entry.trust === 'unreviewed' ? WIKI_NOT_SENT_UNREVIEWED : null;
      expect(whereUsed, mark.name).toBe(mark.whereUsed);
    }
  });

  it('answers in Review’s words, the four reasons in Review’s order', () => {
    const answers = shared.answers;
    expect([WIKI_CONFIRM, WIKI_REVIEW_REJECT, WIKI_CONFIRMED, WIKI_REJECTED]).toEqual([
      answers.confirm,
      answers.reject,
      answers.confirmed,
      answers.rejected,
    ]);
    expect(WIKI_REJECT_REASONS.map((reason) => WIKI_REJECT_REASON_LABELS[reason])).toEqual(answers.reasons);
    expect(WIKI_REJECT_ON_RECORD).toBe(answers.foot);
  });

  it('says who checked it and who applied it, and nothing it cannot back', () => {
    for (const line of shared.checkedLines) {
      expect(wikiCheckedLine(line)).toBe(line.says);
    }
  });
});

describe('one run', () => {
  it('counts what it applied, what the check turned away and what waits — and groups its entries', () => {
    inTimeZone('UTC', () => {
      for (const run of shared.runs) {
        const entries = new Map(run.entries.map((entry) => [entry.id, entry]));
        const summary = wikiRunSummary(run.changeset, entries);
        expect(wikiIsRun(run.changeset), run.name).toBe(run.isRun);
        expect(wikiRunKicker(run.changeset.origin), run.name).toBe(run.kicker);
        expect(wikiAppliedChanges(summary.applied), run.name).toBe(run.title);
        expect(wikiRunWhen(run.changeset.createdAt), run.name).toBe(run.when);
        expect(wikiRunCounts(summary), run.name).toEqual(run.counts);
        expect(summary.added.map((row) => row.title), run.name).toEqual(run.added);
        expect(summary.amended.map((row) => row.title), run.name).toEqual(run.amended);
        expect(summary.reinforced.map((row) => row.title), run.name).toEqual(run.reinforced);
        const marks = Object.fromEntries(
          [...summary.added, ...summary.amended, ...summary.reinforced].map((row) => [row.title, row.trust]),
        );
        expect(marks, run.name).toEqual(run.marks);
        expect(wikiRevertBody(summary), run.name).toBe(run.revert);
      }
    });
  });

  it('asks before it reverts, in the confirmed words', () => {
    const dialog = shared.revertDialog;
    expect([WIKI_REVERT_TITLE, WIKI_REVERT_KEEPS, WIKI_REVERT_RUN_CONFIRM, WIKI_CANCEL]).toEqual([
      dialog.title,
      dialog.keeps,
      dialog.confirm,
      dialog.cancel,
    ]);
    expect([WIKI_REVERT_RUN, WIKI_VIEW_RUN, WIKI_OPEN_SESSION, WIKI_REVERTED]).toEqual([
      dialog.action,
      dialog.view,
      dialog.openSession,
      dialog.reverted,
    ]);
    expect([WIKI_RUN_ADDED, WIKI_RUN_AMENDED, WIKI_RUN_REINFORCED]).toEqual(dialog.groups);
  });

  it('folds a run into one row of Recently changed, at its newest change', () => {
    const byId = new Map(shared.runs.map((run) => [run.changeset.id, run.changeset]));
    for (const recent of shared.recent) {
      const rows = wikiRecentRows(recent.items, recent.runs.map((id) => byId.get(id)!));
      expect(
        rows.map((row) =>
          row.kind === 'run'
            ? { run: row.changeset.id, at: row.at, items: row.items.map((item) => item.opId) }
            : { op: row.item.opId },
        ),
        recent.name,
      ).toEqual(recent.rows);
    }
  });
});

describe('a challenge', () => {
  it('names the anchors that broke in the server’s own words, and where they were checked', () => {
    for (const challenge of shared.challenges) {
      expect(wikiBrokenAnchors(challenge.anchors), challenge.name).toEqual(challenge.broken);
      const ref = wikiChallengeRef(challenge.anchors);
      expect(ref, challenge.name).toBe(challenge.ref);
      expect(ref ? wikiCheckedOnMain(ref) : null, challenge.name).toBe(challenge.checkedOn);
    }
  });

  it('is answered Re-confirm, Amend or Retire', () => {
    expect([WIKI_RECONFIRM, WIKI_AMEND, WIKI_RETIRE]).toEqual(shared.challenge.answers);
    expect(WIKI_CHALLENGE_WAITS).toBe(shared.challenge.waits);
    expect(WIKI_CHALLENGED).toBe(shared.challenge.challenged);
    expect(WIKI_AMEND_NOTE).toBe(shared.challenge.amendNote);
  });
});
