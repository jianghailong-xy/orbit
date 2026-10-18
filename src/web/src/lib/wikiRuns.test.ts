import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIKI_JOB_KINDS, WIKI_SYSTEM_MODEL_READ_STATES, type WikiJobCallView, type WikiJobView, type WikiSystemModelReadState } from '@orbit/shared';
import {
  WIKI_CALL,
  WIKI_CALLS,
  WIKI_CALL_RAN,
  WIKI_CALL_STATE,
  WIKI_CALL_TOKENS,
  WIKI_CALL_WAITED,
  WIKI_MODEL_STATE_WORDS,
  WIKI_RUNS,
  WIKI_RUNS_NONE,
  WIKI_RUN_KINDS,
  WIKI_SYSTEM_MODEL,
  wikiCallRow,
  wikiDuration,
  wikiModelTone,
  wikiRunFootText,
  wikiRunRow,
  wikiRunsShown,
  wikiSystemModelLabel,
  type WikiCallRow,
} from './wikiRuns';
import {
  WIKI_DAILY_LIMIT,
  WIKI_DAILY_LIMIT_NOTE,
  WIKI_LOOKBACK,
  WIKI_LOOKBACK_NOTE,
  WIKI_MAINTENANCE_NOTE_SERVER,
  WIKI_MODEL,
  WIKI_MODEL_NOTE,
  WIKI_MODE_NOTES,
  WIKI_PRIVACY_NOTE,
  WIKI_REPO_FROM,
  WIKI_REPO_FROM_NOTE,
  WIKI_STATUS,
  wikiModeNote,
} from './wikiReviewMode';

/**
 * The server's runs on Activity and the settings page's server words, proved against
 * `src/shared/src/wiki-server-execution.fixture.json` — the file OrbitKit's `WikiServerExecutionCopyParityTests`
 * reads too, so the web and iOS say one sentence for one read.
 */

interface Fixture {
  now: string;
  settings: {
    rows: string[];
    form: { fields: Array<{ label: string; note: string }> };
    maintenanceNote: string;
    privacy: string;
    automaticNote: string;
    systemModel: string;
    models: Array<{ status: { state: WikiSystemModelReadState; model: string | null }; label: string; state: string; tone: string }>;
  };
  runs: {
    title: string;
    none: string;
    kinds: Record<string, string>;
    callsTitle: string;
    columns: string[];
    durations: Array<{ seconds: number; says: string }>;
    cases: Array<{ name: string; job: WikiJobView; kind: string; mark: string; tone: string; state: string; text: string; when: string; foot: string }>;
    calls: Array<{ name: string; call: WikiJobCallView; row: WikiCallRow }>;
  };
}

function fixture(): Fixture {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-server-execution.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-server-execution.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-server-execution.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const shared = fixture();
const now = Date.parse(shared.now);

describe('a run\'s row says the fixture\'s words', () => {
  for (const one of shared.runs.cases) {
    it(one.name, () => {
      const row = wikiRunRow(one.job, now);
      expect(row).toEqual({ kind: one.kind, mark: one.mark, tone: one.tone, state: one.state, text: one.text, when: one.when });
      expect(wikiRunFootText(one.job)).toBe(one.foot);
    });
  }

  it('covers every state a run can be in, and names every kind', () => {
    expect([...new Set(shared.runs.cases.map((one) => one.job.state))].sort()).toEqual(['cancelled', 'failed', 'queued', 'running', 'succeeded', 'waiting']);
    expect(Object.keys(shared.runs.kinds)).toEqual([...WIKI_JOB_KINDS]);
    expect(WIKI_RUN_KINDS).toEqual(shared.runs.kinds);
    expect(WIKI_RUNS).toBe(shared.runs.title);
    expect(WIKI_RUNS_NONE).toBe(shared.runs.none);
  });

  it('is drawn while the server runs the account\'s wiki, or once it ran something for the space', () => {
    expect(wikiRunsShown(false, [])).toBe(false);
    expect(wikiRunsShown(false, null)).toBe(false);
    expect(wikiRunsShown(true, [])).toBe(true);
    expect(wikiRunsShown(false, [shared.runs.cases[0].job])).toBe(true);
  });
});

describe('a call\'s row says the fixture\'s words', () => {
  for (const one of shared.runs.calls) {
    it(one.name, () => {
      expect(wikiCallRow(one.call, now)).toEqual(one.row);
    });
  }

  it('heads its columns as the fixture does', () => {
    expect([WIKI_CALL, WIKI_CALL_STATE, WIKI_CALL_WAITED, WIKI_CALL_RAN, WIKI_CALL_TOKENS]).toEqual(shared.runs.columns);
    expect(WIKI_CALLS).toBe(shared.runs.callsTitle);
  });
});

describe('durations', () => {
  it('reads to the second up to an hour, then hours and minutes, then days and hours', () => {
    for (const one of shared.runs.durations) expect(wikiDuration(one.seconds), String(one.seconds)).toBe(one.says);
  });
});

describe('the System model, as the settings page and the Runs card say it', () => {
  it('names the model and says each of its states, coloured by who has to act', () => {
    expect(Object.keys(WIKI_MODEL_STATE_WORDS)).toEqual([...WIKI_SYSTEM_MODEL_READ_STATES]);
    expect(shared.settings.models.map((one) => one.status.state)).toEqual([...WIKI_SYSTEM_MODEL_READ_STATES]);
    for (const one of shared.settings.models) {
      expect(wikiSystemModelLabel(one.status.model)).toBe(one.label);
      expect(WIKI_MODEL_STATE_WORDS[one.status.state]).toBe(one.state);
      expect(wikiModelTone(one.status.state)).toBe(one.tone);
    }
    expect(WIKI_SYSTEM_MODEL).toBe(shared.settings.systemModel);
  });

  it('says the maintenance card and Set up in the fixture\'s words while the server runs the wiki', () => {
    expect([WIKI_STATUS, WIKI_REPO_FROM, WIKI_MODEL, WIKI_DAILY_LIMIT, WIKI_LOOKBACK]).toEqual(shared.settings.rows);
    expect([
      { label: WIKI_REPO_FROM, note: WIKI_REPO_FROM_NOTE },
      { label: WIKI_MODEL, note: WIKI_MODEL_NOTE },
      { label: WIKI_DAILY_LIMIT, note: WIKI_DAILY_LIMIT_NOTE },
      { label: WIKI_LOOKBACK, note: WIKI_LOOKBACK_NOTE },
    ]).toEqual(shared.settings.form.fields);
    expect(WIKI_MAINTENANCE_NOTE_SERVER).toBe(shared.settings.maintenanceNote);
    expect(WIKI_PRIVACY_NOTE).toBe(shared.settings.privacy);
    expect(wikiModeNote('automatic', true)).toBe(shared.settings.automaticNote);
    // Under runner every mode says what it always said; the server changes Automatic's sentence alone.
    for (const mode of ['manual', 'tiered', 'automatic'] as const) expect(wikiModeNote(mode, false)).toBe(WIKI_MODE_NOTES[mode]);
    expect(wikiModeNote('tiered', true)).toBe(WIKI_MODE_NOTES.tiered);
  });
});
