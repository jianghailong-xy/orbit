import { describe, expect, it } from 'vitest';
import type { WikiEntry } from '@orbit/shared';
import {
  WIKI_REJECT_MENU,
  WIKI_TRUST_LABELS,
  WIKI_TRUST_TONE,
  wikiAnchorMark,
  wikiAnchorStateOf,
  wikiChangeNote,
  wikiChangeVerb,
  wikiChangedSince,
  wikiChangesDiff,
  wikiEntriesOfKind,
  wikiEntryPath,
  wikiFieldRows,
  wikiKindWord,
  wikiTabOf,
  wikiTopicSummaries,
  wikiTopicsOf,
} from './wiki';

/**
 * The Wiki's derivations, which is where its words and its readings live.
 *
 * The pages are mostly arrangement; what a test can hold is the vocabulary the arrangement is made of
 * — that a trust badge says Owner / Confirmed / Proposed / Web-derived, that `Amend` covers a
 * supersede while `Changed` stays the anchor's word, that a pitfall's Details are its own four
 * fields, and that a diff puts the old value on red and the new on green.
 */

let counter = 0;
const id = (): string => `0196a000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

function entry(over: Partial<WikiEntry> = {}): WikiEntry {
  return {
    id: id(),
    spaceId: 'space',
    kind: 'principle',
    status: 'active',
    trust: 'owner',
    currentRevision: 1,
    title: 'A clock never starts agent work',
    summary: 'Work starts from a committed fact.',
    fields: { statement: 'A clock never starts agent work.', rationale: 'Time is not a fact.' },
    topics: ['tasks-dispatch'],
    aliases: [],
    anchors: [],
    anchorState: 'verified',
    anchorCheckedRef: 'a'.repeat(40),
    anchorCheckedAt: '2026-09-24T00:00:00.000Z',
    tainted: false,
    challenged: false,
    unsupported: false,
    pinned: false,
    supersedesId: null,
    supersededById: null,
    validFrom: '2026-09-24T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-09-20T00:00:00.000Z',
    retiredAt: null,
    ...over,
  } as WikiEntry;
}

describe('the trust vocabulary', () => {
  it('says the four levels in the words every surface shares', () => {
    expect(WIKI_TRUST_LABELS).toEqual({
      owner: 'Owner',
      confirmed: 'Confirmed',
      proposed: 'Proposed',
      external: 'Web-derived',
    });
    // The tones: an owner's entry is the inverse surface, a confirmed one is brand, a proposal is
    // grey, and anything web-derived is amber — the colour that means "a person has to look at this"
    // everywhere else in the app.
    expect(WIKI_TRUST_TONE.owner).toBe('owner');
    expect(WIKI_TRUST_TONE.confirmed).toBe('blue');
    expect(WIKI_TRUST_TONE.proposed).toBe('muted');
    expect(WIKI_TRUST_TONE.external).toBe('amber');
  });

  it('names a kind in prose, and a kind it has no word for as itself', () => {
    expect(wikiKindWord('pitfall')).toBe('Pitfall');
    expect(wikiKindWord('assumption')).toBe('Assumption');
    expect(wikiKindWord('something-new')).toBe('something-new');
  });
});

describe('the anchor column', () => {
  it('shows the ref an anchor was checked at, and nothing at all when nothing has checked it', () => {
    expect(wikiAnchorMark(entry())).toEqual({ word: 'aaaaaaa', tone: 'green' });
    expect(wikiAnchorMark(entry({ anchorState: 'changed' }))).toEqual({ word: 'Changed', tone: 'amber' });
    expect(wikiAnchorMark(entry({ anchorState: 'missing' }))).toEqual({ word: 'Missing', tone: 'red' });
    // Unchecked draws no mark: an entry nothing has re-checked yet has not changed, and a warning
    // there would put every freshly written entry in amber.
    expect(wikiAnchorMark(entry({ anchorState: 'unchecked', anchorCheckedRef: null }))).toBeNull();
  });

  it('reads one anchor’s own check, and says so when it has none', () => {
    expect(wikiAnchorStateOf({ check: { state: 'verified', ref: 'b'.repeat(40) } })).toEqual({
      word: 'bbbbbbb',
      tone: 'green',
    });
    expect(wikiAnchorStateOf({ check: { state: 'missing' } }).tone).toBe('red');
    expect(wikiAnchorStateOf({}).word).toBe('Unchecked');
  });
});

describe('topics, read out of the entries that carry them', () => {
  it('counts each slug once per entry, and puts the most-used topic first', () => {
    const entries = [
      entry({ title: 'One', topics: ['tasks-dispatch', 'runner-engines'] }),
      entry({ title: 'Two', topics: ['tasks-dispatch'] }),
      entry({ title: 'Three', topics: ['tasks-dispatch', 'tasks-dispatch'] }),
    ];
    const topics = wikiTopicSummaries(entries);
    expect(topics.map((topic) => [topic.slug, topic.count])).toEqual([
      ['tasks-dispatch', 3],
      ['runner-engines', 1],
    ]);
    // The latest entry carrying the topic is what the grid's second line says something about.
    expect(topics[0].latest?.title).toBe('Three');
    expect(wikiTopicsOf(entries[2])).toEqual(['tasks-dispatch']);
  });

  it('has no topics when no entry names one', () => {
    expect(wikiTopicSummaries([entry({ topics: [] })])).toEqual([]);
  });
});

describe('what changed since the reader was last here', () => {
  it('counts the entries written after the stamp, and everything when there is no stamp', () => {
    const old = entry({ validFrom: '2026-09-01T00:00:00.000Z' });
    const fresh = entry({ validFrom: '2026-09-25T00:00:00.000Z' });
    const since = Date.parse('2026-09-20T00:00:00.000Z');
    expect(wikiChangedSince([old, fresh], since)).toEqual([fresh]);
    // A reader who has never been here sees everything as new, which is what "since your last visit"
    // means when there was no last visit.
    expect(wikiChangedSince([old, fresh], 0)).toHaveLength(2);
  });
});

describe('an entry’s Details, walked from its kind’s schema', () => {
  it('gives a pitfall its own four fields, in the schema’s order', () => {
    const rows = wikiFieldRows('pitfall', {
      trigger: { paths: ['src/runner-go/'], commands: ['go test ./...'] },
      symptom: 'eleven tests fail and one hangs',
      cause: 'the tests read the session’s own ORBIT_* variables',
      fix: 'unset them before go test',
    });
    expect(rows.map((row) => row.label)).toEqual(['Trigger', 'Symptom', 'Cause', 'Fix']);
    expect(rows[0].value).toEqual(['Paths: src/runner-go/', 'Commands: go test ./...']);
    // An optional field nothing filled is left out rather than drawn empty.
    expect(rows.map((row) => row.label)).not.toContain('Detector');
  });

  it('gives a decision its four parts and calls the alternatives what the design calls them', () => {
    const rows = wikiFieldRows('decision', {
      context: 'Ordering meant pausing lists',
      decision: 'Add priority to tasks',
      alternatives: [{ option: 'A scheduler session', whyRejected: 'one more agent to babysit' }],
      consequences: 'migration 0304',
      decidedAt: '2026-09-25',
    });
    expect(rows.map((row) => row.label)).toEqual([
      'Context',
      'Decision',
      'Rejected',
      'Consequences',
      'Decided',
    ]);
    expect(rows[2].value).toEqual(['A scheduler session — one more agent to babysit']);
  });

  it('falls back to the fields it was handed for a kind this phase does not write', () => {
    // `assumption` is reserved in storage and written by no phase-1 door, so it has no schema here:
    // a page meeting one shows what the entry carries rather than nothing at all.
    expect(wikiFieldRows('assumption', { anything: 'at all' })).toEqual([
      { label: 'Anything', value: 'at all' },
    ]);
  });
});

describe('the red and green of a pending amendment', () => {
  it('puts the current value on red and the proposed one on green, one hunk per changed key', () => {
    const hunks = wikiChangesDiff(
      { summary: 'Run /upgrade from a clean checkout', title: 'Deploy' },
      { summary: 'Refreshing the Postgres image is opt-in: --pull-base' },
    );
    expect(hunks).toHaveLength(1);
    expect(hunks[0].label).toBe('Summary');
    expect(hunks[0].lines).toEqual([
      { sign: '-', text: 'Run /upgrade from a clean checkout' },
      { sign: '+', text: 'Refreshing the Postgres image is opt-in: --pull-base' },
    ]);
  });

  it('shows nothing for a key the op does not name, because an omitted key carries over', () => {
    expect(wikiChangesDiff({ title: 'Deploy' }, {})).toEqual([]);
    expect(wikiChangesDiff({ title: 'Deploy' }, undefined)).toEqual([]);
  });
});

describe('the change feed’s verbs', () => {
  it('says what happened, from the op and its decision rather than from the entry’s trust', () => {
    const item = (over: Partial<{ op: string; decision: string; origin: string }>) => ({
      op: 'add',
      decision: 'auto_applied',
      origin: 'agent',
      ...over,
    });
    expect(wikiChangeVerb(item({ origin: 'owner' }))).toBe('Added by you');
    expect(wikiChangeVerb(item({ decision: 'accepted' }))).toBe('Confirmed by you');
    expect(wikiChangeVerb(item({ op: 'amend', origin: 'owner' }))).toBe('Amended by you');
    expect(wikiChangeVerb(item({ op: 'amend' }))).toBe('Amended');
    expect(wikiChangeVerb(item({ op: 'retire' }))).toBe('Retired');
    expect(wikiChangeVerb(item({ op: 'supersede' }))).toBe('Superseded');
  });

  it('adds the note a retirement carries, naming what replaced it when there is one', () => {
    expect(wikiChangeNote({ op: 'retire', reason: 'the fix landed', supersededByTitle: null })).toBe(
      'the fix landed',
    );
    expect(wikiChangeNote({ op: 'retire', reason: 'old', supersededByTitle: 'The new one' })).toBe(
      'replaced by “The new one”',
    );
    expect(wikiChangeNote({ op: 'add', reason: null, supersededByTitle: null })).toBeNull();
  });
});

describe('the words Review decides by', () => {
  it('files a supersede under Amend, and keeps Change for the anchor', () => {
    expect(wikiTabOf('add')).toBe('add');
    expect(wikiTabOf('amend')).toBe('amend');
    expect(wikiTabOf('supersede')).toBe('amend');
    expect(wikiTabOf('retire')).toBe('retire');
  });

  it('offers the contract’s four reasons, in the order it lists them', () => {
    expect(WIKI_REJECT_MENU).toEqual([
      { reason: 'not_true', label: 'Not true' },
      { reason: 'not_useful', label: 'Not useful' },
      { reason: 'duplicate', label: 'Duplicate' },
      { reason: 'too_specific', label: 'Too specific' },
    ]);
  });
});

describe('the decisions the log shows', () => {
  it('takes one kind, newest change first', () => {
    const older = entry({ kind: 'decision', validFrom: '2026-09-01T00:00:00.000Z' });
    const newer = entry({ kind: 'decision', validFrom: '2026-09-20T00:00:00.000Z' });
    const other = entry({ kind: 'pitfall', validFrom: '2026-09-25T00:00:00.000Z' });
    expect(wikiEntriesOfKind([older, newer, other], 'decision').map((row) => row.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });
});

describe('the entry’s own link', () => {
  it('carries the public id, which is what a route takes back', () => {
    const uuid = '0196a000-0000-7000-8000-000000000042';
    expect(wikiEntryPath('orbit', uuid)).toBe(`/wiki/orbit/e/${wikiEntryPath('orbit', uuid).split('/').pop()}`);
    expect(wikiEntryPath('orbit', uuid)).toContain('/wiki/orbit/e/');
    expect(wikiEntryPath('orbit', uuid)).not.toContain(uuid);
  });
});
