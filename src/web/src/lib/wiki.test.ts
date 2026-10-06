import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiAnchorCheck, WikiEntry } from '@orbit/shared';
import {
  WIKI_REJECT_MENU,
  wikiDecidedToast,
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
  wikiProposalsFrom,
  wikiProposalsToReview,
  wikiTabOf,
  WIKI_ACTIVITY,
  WIKI_MANAGE_SPACES,
  moveWikiSeen,
  readWikiSeen,
  readWikiSeenBefore,
  wikiActivityPath,
  wikiCountInSpace,
  wikiInSpace,
  wikiNewSinceLastLooked,
  wikiSeenKey,
  wikiSpaceWaiting,
  wikiWaitingOnYou,
  writeWikiSeen,
  wikiAllPrinciples,
  wikiShortDay,
} from './wiki';
import { WIKI_NO_DOCUMENTS, wikiDocumentCount } from './wikiDocs';

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
  it('says the six levels in the words every surface shares', () => {
    expect(WIKI_TRUST_LABELS).toEqual({
      owner: 'Owner',
      confirmed: 'Confirmed',
      auto: 'Auto',
      unreviewed: 'Unreviewed',
      proposed: 'Proposed',
      external: 'Web-derived',
    });
    // The tones: an owner's entry is the inverse surface, a confirmed one is brand, a proposal is
    // grey, and anything web-derived is amber — the colour that means "a person has to look at this"
    // everywhere else in the app. What a review mode applied is green when it is pushed (Auto) and
    // grey when it is only shown (Unreviewed).
    expect(WIKI_TRUST_TONE.owner).toBe('owner');
    expect(WIKI_TRUST_TONE.confirmed).toBe('blue');
    expect(WIKI_TRUST_TONE.auto).toBe('green');
    expect(WIKI_TRUST_TONE.unreviewed).toBe('muted');
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

  it('reads the check the anchor re-verification keeps, a symbol’s hashes and all', () => {
    // What `anchorRules.verify.check` stores beside a symbol: the region it found and the baseline it holds it to.
    const check: WikiAnchorCheck = {
      state: 'changed',
      ref: 'c'.repeat(40),
      at: '2026-09-28T02:00:00.000Z',
      regionSha256: 'b'.repeat(64),
      baselineSha256: 'a'.repeat(64),
    };
    expect(wikiAnchorStateOf({ check })).toEqual({ word: 'Changed', tone: 'amber' });
    expect(wikiAnchorStateOf({ check: { ...check, state: 'verified' } })).toEqual({ word: 'ccccccc', tone: 'green' });
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

  it('says what an answer did, in the words of the card it was given on', () => {
    expect(wikiDecidedToast('add', 'accept')).toBe('Accepted');
    expect(wikiDecidedToast('amend', 'accept')).toBe('Accepted');
    expect(wikiDecidedToast('add', 'edit')).toBe('Accepted with your edits');
    expect(wikiDecidedToast('add', 'reject')).toBe('Rejected');
    // A retirement's Retire is an accept, and its Keep a rejection — but the owner kept the entry.
    expect(wikiDecidedToast('retire', 'accept')).toBe('Retired');
    expect(wikiDecidedToast('retire', 'reject')).toBe('Kept');
    // A challenge's three answers.
    expect(wikiDecidedToast('challenge', 'reconfirm')).toBe('Re-confirmed');
    expect(wikiDecidedToast('challenge', 'amend')).toBe('Amended');
    expect(wikiDecidedToast('challenge', 'retire')).toBe('Retired');
  });

  it('counts the proposals in the number it says: one proposal, several proposals', () => {
    expect(wikiProposalsToReview(1)).toBe('1 proposal to review');
    expect(wikiProposalsToReview(3)).toBe('3 proposals to review');
    expect(wikiProposalsToReview(0)).toBe('0 proposals to review');
    expect(wikiProposalsFrom(1, 1)).toBe('1 proposal from 1 session');
    expect(wikiProposalsFrom(3, 2)).toBe('3 proposals from 2 sessions');
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

/**
 * Activity's words and the number waiting on the owner (design §12.3.7): declared here, once, for the
 * pages and for OrbitKit's copy-parity tests to read.
 */
describe('the words of Activity and of what waits', () => {
  it('says them as the design writes them', () => {
    expect(WIKI_ACTIVITY).toBe('Activity');
    expect(wikiWaitingOnYou(3)).toBe('3 waiting on you');
    expect(wikiNewSinceLastLooked(4)).toBe('4 new since you last looked');
    expect(wikiCountInSpace(2, 'wikova')).toBe('· 2 in wikova');
    expect(wikiInSpace('wikova')).toBe('· in wikova');
    expect(wikiSpaceWaiting(2)).toBe('· 2 waiting');
    expect(wikiProposalsToReview(1)).toBe('1 proposal to review');
    expect(`${wikiProposalsToReview(3)} ${wikiCountInSpace(2, 'wikova')}`).toBe('3 proposals to review · 2 in wikova');
    expect(wikiActivityPath('orbit')).toBe('/wiki/orbit/activity');
  });

  it("says the native picker's words as the design writes them", () => {
    expect(WIKI_MANAGE_SPACES).toBe('Manage spaces');
    expect(wikiDocumentCount(35)).toBe('35 documents');
    expect(wikiDocumentCount(1)).toBe('1 document');
    expect(wikiDocumentCount(1234)).toBe('1,234 documents');
    expect(WIKI_NO_DOCUMENTS).toBe('No documents yet');
  });
});

/** The home's principles (design §12.3.1, mock 31 ③): the first three, then the way to all of them. */
describe('the words of the home’s principles', () => {
  it('says the way to the rest with their number, and a principle’s day as month/day', () => {
    expect(wikiAllPrinciples(6)).toBe('All 6 ›');
    expect(wikiShortDay('2026-09-06T12:00:00.000Z')).toBe('9/6');
    expect(wikiShortDay('2026-10-19T12:00:00.000Z')).toBe('10/19');
    expect(wikiShortDay('not a day')).toBeNull();
  });
});

/**
 * "Since you last looked" on Activity, which a reader reaches from the home: the home moves the space's
 * stamp as it opens, and Activity reads what it said before that, so what changed since the reader's
 * last visit is still marked one page later.
 */
describe('the stamp a page after the home reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is what the stamp said before this tab moved it, and the stamp itself until it has', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    });
    const key = wikiSeenKey('stamp-test', 'home');
    writeWikiSeen(key, 1_000);
    expect(readWikiSeenBefore(key)).toBe(1_000);

    // The home opens: the stamp moves to now, and the visit before is kept for Activity.
    moveWikiSeen(key, 5_000);
    expect(readWikiSeen(key)).toBe(5_000);
    expect(readWikiSeenBefore(key)).toBe(1_000);

    // Activity opens and moves it in its turn: the next page compares against the home's visit.
    moveWikiSeen(key, 9_000);
    expect(readWikiSeen(key)).toBe(9_000);
    expect(readWikiSeenBefore(key)).toBe(5_000);
  });

  it('keeps what the stamp said when one opening moves it twice, as React does in development', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    });
    const key = wikiSeenKey('stamp-twice', 'home');
    writeWikiSeen(key, 1_000);
    moveWikiSeen(key, 50_000);
    moveWikiSeen(key, 50_002);
    expect(readWikiSeenBefore(key)).toBe(1_000);
    expect(readWikiSeen(key)).toBe(50_002);
  });
});
