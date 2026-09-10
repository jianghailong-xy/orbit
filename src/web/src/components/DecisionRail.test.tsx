import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DecisionStrip,
  NEEDS_DECISION_LABEL,
  NO_CARD_NOTE,
  POINTER_HINT,
  WAITING_ON_YOU_ACTION,
  WAITING_ON_YOU_LABEL,
  decisionRowKey,
  formatAge,
  needsDecisionCount,
  waitingOnYouCount,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';
import { DECISION_CONFIRM_ACTION, DECISION_SEND_BACK_ACTION } from './EvidenceDecisionCard';

/**
 * What the strip puts on screen, and — the half that matters more — what it does not.
 *
 * Every assertion is a PREDICATE over the rendered output: this word is present, that control is
 * absent, this many of these exist. None of them pins a paragraph verbatim, because a test that
 * does passes while the screen lies and fails when somebody fixes a typo.
 *
 * The reverse assertions are the point of the file, and there are now four of them.
 *
 *  - "Nothing here answers anything" is what this round is about. The strip used to carry Confirm
 *    and Send back and post them itself, which made two decision surfaces for one fact; on
 *    2026-09-09 they raced and the loser got `EVIDENCE_JUDGMENT_ALREADY_DECIDED`. The assertion is
 *    a CENSUS of the rendered `<button>`s rather than a list of labels that should not appear:
 *    every control in the output has to be one of the two that navigate, so a re-added action is
 *    caught whether it is pressable, `disabled`, hidden by CSS or spelled some other way.
 *  - "A pointer that cannot point is not a pointer" is the other half of the same round. A row
 *    with no card on screen renders as text carrying the sentence saying why — not as a control
 *    that does nothing, which would have been worse than the button it replaced.
 *  - "No bulk answer" is not a feature anybody will notice missing — it is a property that quietly
 *    disappears the first time somebody with fifteen pending rows wants to be done with them.
 *  - And "nothing is shown to a reader who cannot act on it". The rows are found on the ACCOUNT,
 *    so the failure mode is not that a session sees too few — it is that every session sees all of
 *    them, one fact painted onto as many faces as there are open windows. That regression is
 *    invisible to any test that renders one session, so the test below renders four and asserts
 *    the group appears in exactly the ones with standing to answer.
 *
 * NO `../api` MOCK and none needed: `DecisionStrip` takes its payload as a prop and issues no
 * request. The last test in the file holds that property in place.
 */

const HOUR = 3600;

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: '34IovIcRNjv3rAC1vespN',
    title: 'the derived pending queue',
    criterion: {
      key: '3t4PyphGUWQtzDGfvOLY9R',
      text: 'coordinator 会话有判断面：待决队列派生自事实而非投递队列',
    },
    evidenceRevision: '2',
    ageSeconds: 90 * 60,
    claim: 'the web render test and the full API suite both passed',
    gaps: ['iOS is not covered by this project'],
    citations: [
      {
        kind: 'TOOL_CALL',
        ref: 'toolu_first',
        resolved: true,
        reason: null,
        label: 'Bash · npm test --run DecisionRail',
      },
      {
        kind: 'COMMIT',
        ref: '7ad996c2',
        resolved: false,
        reason: 'no COMMIT of this task matches this reference',
        label: null,
      },
    ],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

/** What the server sends for evidence no decision can be recorded about: the door's reason, and
 *  the action in the door's own vocabulary. */
function undecidable(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return row({
    criterion: null,
    claim: '',
    citations: [],
    decidability: {
      decidable: false,
      refusal:
        'this evidence quotes no project criterion, so there is no stated standard to decide it '
        + 'against',
      requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
    },
    ...over,
  });
}

/** The door's answer for a row this reader took part in, exactly as the server words it. */
const DISQUALIFIED = {
  independent: false,
  disqualification: 'this session is a run of the task it is deciding',
  requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
} as const;

/** Three waiting facts, oldest first, exactly as the server hands them over. */
function queue(over: Partial<PendingDecisionQueue> = {}): PendingDecisionQueue {
  const pending = [
    row({ taskId: 'task-oldest', title: 'the decision door', ageSeconds: 3 * HOUR }),
    row({ taskId: 'task-middle', title: 'the evidence envelope', ageSeconds: 2 * HOUR }),
    row({ taskId: 'task-newest', title: 'the stalled inventory', ageSeconds: 40 * 60 }),
  ];
  return {
    decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
    count: pending.length,
    oldestAgeSeconds: pending[0].ageSeconds,
    pending,
    waitingOnYou: [],
    ...over,
  };
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element);

/** The two answers the page can give about a row: its card is on screen, or it is not. Most tests
 *  take the second, because that is the state a rail is in whenever no coordinator turn is live. */
const NO_CARDS = (): boolean => false;
const EVERY_CARD = (): boolean => true;

/** The strip as a reader first meets it: folded. */
const collapsed = (payload: PendingDecisionQueue): string =>
  render(<DecisionStrip queue={payload} open={false} onToggle={() => {}} />);

/** And after the one interaction that opens it. */
const expandedStrip = (
  payload: PendingDecisionQueue,
  hasCard: (row: PendingDecisionRow) => boolean = NO_CARDS,
): string =>
  render(<DecisionStrip queue={payload} open hasCard={hasCard} onToggle={() => {}} />);

/** Count non-overlapping occurrences — "how many of these are on screen" is the whole question in
 *  the bulk-action tests, and `includes` cannot answer it. */
function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * Every `<button>` in the output, as its opening tag.
 *
 * A census rather than a search. Asked as "is the confirm label absent" this file would pass on a
 * strip that grew a differently-worded action, a disabled one, or one hidden by a stylesheet —
 * all three of which leave the second decision door standing. Asked as "what is here", the answer
 * has to be a list somebody deliberately extended.
 */
function buttonTags(html: string): string[] {
  return html
    .split('<button')
    .slice(1)
    .map((chunk) => `<button${chunk.split('>')[0]}>`);
}

/**
 * Source with its comments taken out.
 *
 * The same trick `rules()` plays on the stylesheet below, and for the same reason turned around: a
 * file that explains why a thing was removed necessarily NAMES the removed thing, so a scan for
 * the name has to be asked of the code rather than of the prose about it.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The two controls this strip is allowed to have, both of which move a reader rather than write
 *  anything: the fold, and a row that points at its card. */
const NAVIGATION = ['decision-strip-line', 'decision-rail-pointer'];

function strayControls(html: string): string[] {
  return buttonTags(html).filter((tag) => !NAVIGATION.some((cls) => tag.includes(cls)));
}

describe('the collapsed strip', () => {
  const mixed = queue({
    waitingOnYou: [undecidable({
      taskId: 'task-legacy',
      title: 'the SOURCE contract rebase',
      independence: { ...DISQUALIFIED },
    })],
  });

  it('is one line carrying two numbers and nothing else', () => {
    const html = collapsed(mixed);

    expect(occurrences(html, 'decision-strip-line')).toBe(1);
    expect(occurrences(html, 'decision-strip-count')).toBe(2);
    expect(html).toContain(needsDecisionCount(3));
    expect(html).toContain(waitingOnYouCount(1));
  });

  it('says nothing about any individual row until it is asked to', () => {
    const html = collapsed(mixed);

    // No group headings, no rows: the counts are the whole of the folded state.
    expect(html).not.toContain(NEEDS_DECISION_LABEL);
    expect(html).not.toContain(WAITING_ON_YOU_LABEL);
    expect(html).not.toContain('the decision door');
    expect(html).not.toContain('the SOURCE contract rebase');
    expect(occurrences(html, 'decision-rail-row')).toBe(0);
  });

  it('opens only on a deliberate act, and says which state it is in', () => {
    // The fold is a real control with a real state, so a reader (and a screen reader) can tell
    // whether there is more without pressing it to find out.
    expect(collapsed(mixed)).toContain('aria-expanded="false"');
    const opened = expandedStrip(mixed);
    expect(opened).toContain('aria-expanded="true"');
    // And only then does anything about a row exist on screen.
    expect(opened).toContain(NEEDS_DECISION_LABEL);
    expect(opened).toContain('the decision door');
  });

  it('carries one number when only one group has anything in it', () => {
    const onlyDecisions = collapsed(queue());
    expect(occurrences(onlyDecisions, 'decision-strip-count')).toBe(1);
    expect(onlyDecisions).toContain(needsDecisionCount(3));

    const onlyWaiting = collapsed(queue({
      count: 0,
      pending: [],
      oldestAgeSeconds: null,
      waitingOnYou: [undecidable({ taskId: 'task-legacy', independence: { ...DISQUALIFIED } })],
    }));
    expect(occurrences(onlyWaiting, 'decision-strip-count')).toBe(1);
    expect(onlyWaiting).toContain(waitingOnYouCount(1));
    // Nothing is being asked of this reader, so the mark of attention is not there either.
    expect(onlyWaiting).not.toContain('decision-strip-dot');
    expect(collapsed(queue())).toContain('decision-strip-dot');
  });

  it('renders nothing at all when nothing is waiting', () => {
    const html = collapsed(queue({ count: 0, pending: [], oldestAgeSeconds: null }));
    expect(html).toBe('');
  });
});

/**
 * The claim this round exists to make: there is ONE decision surface, and it is not this one.
 *
 * Asserted over the rendered output rather than over the source, and as a census of controls
 * rather than as a list of forbidden labels — the two ways the property comes back are somebody
 * re-adding the buttons `disabled` (still a door, still one lock away) and somebody adding an
 * action worded differently. A census catches both. The negative control is to put either back:
 * one extra `<button>` that is not the fold or a pointer, and `strayControls` stops being empty.
 */
describe('nothing in the strip answers anything', () => {
  /** Every shape the strip can take, in one array, so the census is asked of all of them and not
   *  of the one state somebody remembered. */
  const everyState = (): string[] => {
    const mine: PendingDecisionQueue = {
      decidingSessionId: 'the-submitting-run',
      count: 1,
      oldestAgeSeconds: 3 * HOUR,
      pending: [row({ taskId: 'task-answerable' })],
      waitingOnYou: [undecidable({ taskId: 'task-legacy', independence: { ...DISQUALIFIED } })],
    };
    return [
      collapsed(queue()),
      collapsed(mine),
      expandedStrip(queue(), NO_CARDS),
      expandedStrip(queue(), EVERY_CARD),
      expandedStrip(mine, NO_CARDS),
      expandedStrip(mine, EVERY_CARD),
      // One row pointing and its neighbours not: the mixed state, which is the usual one.
      expandedStrip(queue(), (each) => each.taskId === 'task-middle'),
    ];
  };

  it('renders no control other than the fold and the pointers', () => {
    for (const html of everyState()) {
      expect(strayControls(html)).toEqual([]);
    }
  });

  it('never renders either decision as a word on screen', () => {
    // The two verdicts are the evidence card's words, and that card is the one place a reader may
    // meet them (`EvidenceDecisionCard.tsx`).
    for (const html of everyState()) {
      expect(html).not.toContain(DECISION_CONFIRM_ACTION);
      expect(html).not.toContain(DECISION_SEND_BACK_ACTION);
    }
  });

  it('offers nowhere to write the note a send-back would carry', () => {
    for (const html of everyState()) {
      expect(html).not.toContain('<textarea');
      expect(html).not.toContain('<input');
      expect(html).not.toContain('What the next evidence revision must show');
    }
  });

  it('does not call the write it used to make', async () => {
    // The one claim in this file that a render cannot make: `decideEvidence` was DELETED rather
    // than left unreferenced behind a hidden button, so there is no export to import and no call
    // site to re-enable. Asserted over the CODE — the prose above it names the removed function on
    // purpose, and a prohibition that a sentence explaining it can trip is a prohibition nobody
    // will be able to keep.
    const module = await import('./DecisionRail');
    expect(Object.keys(module)).not.toContain('decideEvidence');
    const code = codeOf(readFileSync(new URL('./DecisionRail.tsx', import.meta.url), 'utf8'));
    expect(code).not.toContain('decideEvidence');
    // And nothing in it writes anywhere by any other name: no client, no mutation, no POST.
    expect(code).not.toContain("from '../api'");
    expect(code).not.toContain("method: 'POST'");
    expect(code).not.toContain('useMutation');
  });
});

/**
 * The scope claim.
 *
 * The queue is found on the ACCOUNT — there is nowhere else to find it, since a question is a shape
 * some task's columns have. What is put in front of a reader is a different question, and getting
 * it wrong does not look like a missing row: it looks like every open session showing the same
 * list, most of whose rows their reader can do nothing about. So these render N sessions of the
 * SAME account-level facts and assert the group appears in exactly the ones with standing.
 */
describe('a question is put to the sessions that can answer it, and to no others', () => {
  const A = row({ taskId: 'task-a', title: 'the SOURCE contract rebase', ageSeconds: 33 * HOUR });
  const B = row({ taskId: 'task-b', title: 'the SOURCE selector audit', ageSeconds: 32 * HOUR });
  const C = row({ taskId: 'task-c', title: 'the stalled inventory', ageSeconds: 20 * 60 });

  /**
   * The whole account's three questions, as the server WOULD have handed them to every session
   * before this fix: one list, with per-row independence and nothing else distinguishing readers.
   * Rendering this is the only way to catch a regression that puts the account back in front of
   * everybody — a fixture already scoped per session would agree with a screen that ignores scope.
   */
  const accountWide = (disqualifiedTaskIds: string[]): PendingDecisionQueue => {
    const pending = [A, B, C].map((each) => (
      disqualifiedTaskIds.includes(each.taskId)
        ? { ...each, independence: { ...DISQUALIFIED } }
        : each
    ));
    return {
      decidingSessionId: 'session-under-test',
      count: pending.length,
      oldestAgeSeconds: pending[0].ageSeconds,
      pending,
      waitingOnYou: [],
    };
  };

  const READERS = [
    { name: 'the coordinator', did: [] as string[], answerable: ['task-a', 'task-b', 'task-c'] },
    { name: 'the run behind A', did: ['task-a'], answerable: ['task-b', 'task-c'] },
    { name: 'the run behind B', did: ['task-b'], answerable: ['task-a', 'task-c'] },
    { name: 'the run that did all three', did: ['task-a', 'task-b', 'task-c'], answerable: [] },
  ];

  it('does not render the same account-level list once per open session', () => {
    const showing = READERS.filter(
      (reader) => expandedStrip(accountWide(reader.did)).includes(NEEDS_DECISION_LABEL),
    );

    // N readers of one account, M groups rendered, and M is decided by standing rather than by how
    // many sessions happen to be open. Before this, every one of the four rendered it.
    expect(READERS.length).toBe(4);
    expect(showing.map((reader) => reader.name)).toEqual([
      'the coordinator',
      'the run behind A',
      'the run behind B',
    ]);
  });

  it('does not show the group at all to a session that may answer nothing', () => {
    const html = expandedStrip(accountWide(['task-a', 'task-b', 'task-c']));

    // Absent, not greyed: a heading that says DECIDE over rows nobody here may decide is the same
    // false promise the card was fixed for, said one level up.
    expect(html).not.toContain(NEEDS_DECISION_LABEL);
    expect(html).not.toContain('the SOURCE contract rebase');
    expect(occurrences(html, 'decision-rail-row')).toBe(0);
    // And the folded line does not offer a count for a group that is not there.
    expect(collapsed(accountWide(['task-a', 'task-b', 'task-c']))).toBe('');
  });

  it('shows a reader the rows it may answer, and the count agrees with the list', () => {
    for (const reader of READERS.filter((each) => each.answerable.length > 0)) {
      const payload = accountWide(reader.did);
      const html = expandedStrip(payload);
      const folded = collapsed(payload);

      expect(occurrences(html, 'decision-rail-row'), reader.name).toBe(reader.answerable.length);
      expect(folded, reader.name).toContain(needsDecisionCount(reader.answerable.length));
      for (const answerable of reader.answerable) {
        const title = [A, B, C].find((each) => each.taskId === answerable)!.title;
        expect(html, `${reader.name} cannot see ${answerable}`).toContain(title);
      }
      for (const own of reader.did) {
        const title = [A, B, C].find((each) => each.taskId === own)!.title;
        expect(html, `${reader.name} was asked about its own work`).not.toContain(title);
      }
    }
  });

  /**
   * The one row, said as the acceptance names it: a row this session may not answer is neither
   * counted nor listed — and, now that a row can be a control, is not offered a pointer either.
   *
   * Held over BOTH answers the page can give about a live card, because the pointer is the one
   * thing on a row that a scope bug could newly leak: a strip that took `hasCard` as the whole
   * question would light one on a row it must not be showing at all.
   */
  it('leaves a row this session did the work for out of the count, the list and the pointers', () => {
    const payload = accountWide(['task-b']);

    expect(collapsed(payload)).toContain(needsDecisionCount(2));
    for (const hasCard of [NO_CARDS, EVERY_CARD]) {
      const html = expandedStrip(payload, hasCard);
      expect(html).not.toContain('the SOURCE selector audit');
      expect(html).not.toContain(B.taskId);
      expect(html).not.toContain('run of the task it is deciding');
      expect(occurrences(html, 'decision-rail-row')).toBe(2);
      expect(occurrences(html, 'decision-rail-pointer')).toBe(hasCard === EVERY_CARD ? 2 : 0);
    }
  });
});

/**
 * The pointer, and the state this round had to answer before it could exist: no card to point at.
 *
 * The rail used to be able to decide whether or not a coordinator turn was running, which is why
 * it could be a decision surface at all. Turning it into a pointer spends that: a row whose card
 * is not on screen has nowhere to go. The page answers which rows have one with the evidence card's
 * own filter (`evidenceDecisionCardRows`), so what the strip has to get right is what it does with
 * a `false` — which is to stop being a control and say why.
 */
describe('a row points at its card, or says there is none', () => {
  const one = (over: Partial<PendingDecisionRow> = {}): PendingDecisionQueue => {
    const only = row({ taskId: 'task-open', ...over });
    return {
      decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
      count: 1,
      oldestAgeSeconds: only.ageSeconds,
      pending: [only],
      waitingOnYou: [],
    };
  };

  it('is a control when the card is on screen, and says where it goes', () => {
    const html = expandedStrip(one(), EVERY_CARD);

    expect(occurrences(html, 'decision-rail-pointer')).toBe(1);
    expect(html).toContain(POINTER_HINT);
    // Still the same four facts a row has always led with.
    expect(html).toContain('the derived pending queue');
    expect(html).toContain('rev 2');
    expect(html).toContain('1h 30m');
  });

  it('is not a control at all when there is no card to reach', () => {
    const html = expandedStrip(one(), NO_CARDS);

    // The row is still there, and it is still readable — it is simply not something to press.
    expect(occurrences(html, 'decision-rail-row')).toBe(1);
    expect(html).toContain('the derived pending queue');
    expect(html).toContain('decision-rail-inert');
    expect(html).not.toContain('decision-rail-pointer');
    expect(html).not.toContain(POINTER_HINT);
    // Nothing inside the group is a button: the only one left in the whole render is the fold.
    expect(occurrences(html, '<button')).toBe(1);
    expect(html).toContain('decision-strip-line');
  });

  it('says what is happening instead, rather than leaving a dead row', () => {
    // The acceptance's core: what replaces the pointer is a sentence, and it names where a
    // decision is actually made. A blank row would be the same "pressed it, nothing happened"
    // one step earlier.
    const html = expandedStrip(one(), NO_CARDS);
    expect(html).toContain('decision-rail-why');
    expect(html).toContain(NO_CARD_NOTE);
    expect(NO_CARD_NOTE.toLowerCase()).toContain('coordinator session');
    // And it is gone the moment there is somewhere to go.
    expect(expandedStrip(one(), EVERY_CARD)).not.toContain(NO_CARD_NOTE);
  });

  it('gives every row its own answer rather than one for the group', () => {
    // Three rows, one card. The one with a card points; the other two say why they do not.
    const html = expandedStrip(queue(), (each) => each.taskId === 'task-middle');

    expect(occurrences(html, 'decision-rail-pointer')).toBe(1);
    expect(occurrences(html, 'decision-rail-inert')).toBe(2);
    expect(occurrences(html, NO_CARD_NOTE)).toBe(2);
    // The pointer is on the row it belongs to.
    const pointer = html.slice(html.indexOf('decision-rail-pointer'));
    expect(pointer.slice(0, pointer.indexOf('</button>'))).toContain('the evidence envelope');
  });

  it('never points at a row the door itself would refuse, whatever the page says', () => {
    // Belt and braces, and deliberately: no ask is ever raised over an undecidable row, so a
    // `true` here could only come from a page that got the key wrong. It costs a sentence.
    const html = expandedStrip(
      { ...one(), pending: [undecidable({ taskId: 'task-open' })] },
      EVERY_CARD,
    );
    expect(html).not.toContain('decision-rail-pointer');
    expect(html).toContain('decision-rail-inert');
  });

  it('names the row and the version it is about, so a stale read points nowhere', () => {
    // The handle the card publishes and the strip looks up. Task alone would send a reader holding
    // a rev-1 row to the card raised about rev 2, which is a decision about the wrong version.
    expect(decisionRowKey(row())).toBe('34IovIcRNjv3rAC1vespN@2');
    expect(decisionRowKey(row({ evidenceRevision: '3' }))).not.toBe(decisionRowKey(row()));
  });
});

describe('there is no way to answer more than one at a time', () => {
  const three = expandedStrip(queue(), EVERY_CARD);

  it('renders no selection control a bulk action could be built on', () => {
    expect(three).not.toContain('type="checkbox"');
    expect(three).not.toContain('type="radio"');
    expect(three.toLowerCase()).not.toContain('select all');
  });

  it('offers no control whose label answers "all" of them', () => {
    for (const label of [
      'Confirm all',
      'confirm all',
      'Send all back',
      'Approve all',
      'approve all',
      'Decide all',
      'Answer all',
    ]) {
      expect(three).not.toContain(label);
    }
  });

  it('never says Mark complete, because nothing here writes a status', () => {
    expect(three).not.toContain('Mark complete');
    expect(three.toLowerCase()).not.toContain('mark complete');
  });
});

describe('the strip is a read face', () => {
  it('renders the whole payload it was handed without issuing a request', () => {
    // No `../api` is mocked anywhere in this file, and every test above renders. A component that
    // fetched on render would have thrown on the missing token, so this holds the property that
    // the rows come from the server's derived read and nothing is assembled here.
    expect(expandedStrip(queue())).toContain(NEEDS_DECISION_LABEL);
  });
});

/**
 * The rows no decision can be recorded about, and the one session they are ever sent to.
 *
 * They are not decisions and they are not put among them. Every row under the heading that asks
 * for a decision is one the reader could act on; these go to the party who can clear them — the
 * submitter, in the session that filed them — and to nobody else at all. Showing everybody else a
 * greyed copy was the same one fact on as many faces as there were open windows, said politely: a
 * reader chasing the stalled population has the report of stalled tasks to read, and does not need
 * it pinned to every screen in the account.
 */
describe('a row the door would refuse whatever was pressed', () => {
  const legacy = undecidable({ taskId: 'task-legacy', title: 'the SOURCE contract rebase' });

  /** The one reader it is sent to: the session that filed the submission. */
  const mine = (): PendingDecisionQueue => {
    const answerable = row({ taskId: 'task-answerable', title: 'the derived pending queue' });
    return {
      decidingSessionId: 'the-submitting-run',
      count: 1,
      oldestAgeSeconds: answerable.ageSeconds,
      pending: [answerable],
      waitingOnYou: [{ ...legacy, independence: { ...DISQUALIFIED } }],
    };
  };

  /** And what every OTHER session is now handed about the same account fact: no group, no field,
   *  nothing. This is the payload the server sends them, and rendering it is the whole test. */
  const theirs = (): PendingDecisionQueue => {
    const answerable = row({ taskId: 'task-answerable', title: 'the derived pending queue' });
    return {
      decidingSessionId: 'some-other-run',
      count: 1,
      oldestAgeSeconds: answerable.ageSeconds,
      pending: [answerable],
      waitingOnYou: [],
    };
  };

  it('is never listed among the decisions, and never counted as one', () => {
    const html = expandedStrip(mine());

    expect(html).toContain(NEEDS_DECISION_LABEL);
    expect(html).toContain(WAITING_ON_YOU_LABEL);
    expect(html).toContain('the SOURCE contract rebase');
    // The number the strip leads with counts only what a decider can answer. A "2" that includes
    // one nobody can answer is the same false promise one level up.
    expect(collapsed(mine())).toContain(needsDecisionCount(1));
    expect(collapsed(mine())).toContain(waitingOnYouCount(1));
    expect(html).toContain('1 to resubmit');
    // And it is below, in the other group: the answerable row comes before that group's heading,
    // the unanswerable one after it.
    expect(html.indexOf('the derived pending queue')).toBeLessThan(html.indexOf(WAITING_ON_YOU_LABEL));
    expect(html.indexOf(WAITING_ON_YOU_LABEL)).toBeLessThan(html.indexOf('the SOURCE contract rebase'));
  });

  it('is not shown at all to a session that is not the one who filed it', () => {
    // The payload for every other reader, rendered: the decidable question is still there and the
    // stall is simply not, in any group and under any heading. Before this round the same fact
    // came back to all of them as a greyed line headed with an apology for existing.
    const html = expandedStrip(theirs());

    expect(html).toContain(NEEDS_DECISION_LABEL);
    expect(html).toContain('the derived pending queue');
    expect(html).not.toContain(WAITING_ON_YOU_LABEL);
    expect(html).not.toContain('the SOURCE contract rebase');
    expect(occurrences(html, 'decision-rail-row')).toBe(1);
    // And the folded line carries one number, because there is one group.
    expect(occurrences(collapsed(theirs()), 'decision-strip-count')).toBe(1);
  });

  /**
   * The copy that addressed "everybody else", asserted absent from what is actually rendered.
   *
   * A predicate over the OUTPUT rather than over the props: a constant can be renamed, a group can
   * be re-added under another name, and either would leave these sentences back on screen while a
   * test that asserted about the payload went on passing.
   */
  it('never says a word about a submitter this reader is not', () => {
    for (const payload of [mine(), theirs(), queue()]) {
      for (const html of [
        collapsed(payload),
        expandedStrip(payload, NO_CARDS),
        expandedStrip(payload, EVERY_CARD),
      ]) {
        expect(html.toLowerCase()).not.toContain('waiting on the submitter');
        expect(html.toUpperCase()).not.toContain('NOTHING FOR YOU TO DO HERE');
        expect(html.toUpperCase()).not.toContain('NOTHING TO DECIDE YET');
      }
    }
  });

  it('reads as an instruction in the one session that can act on it', () => {
    const html = expandedStrip(mine());

    // Its own group, addressed to the reader, with the row it is about under it.
    expect(html).toContain(WAITING_ON_YOU_LABEL);
    expect(html).toContain('the SOURCE contract rebase');
    // The reason is the door's own, and the sentence after it says what to do about it — on the
    // row, not behind a disclosure, because it is the only thing this group has to say.
    expect(html).toContain('quotes no project criterion');
    expect(html).toContain(WAITING_ON_YOU_ACTION);
    expect(html).toContain('submit another evidence revision quoting the project criterion');
    // And the reason it is not a pointer is its own, not the generic one: there will never be a
    // card for this row anywhere, so it is not told where one is drawn. Read off THIS group — the
    // decidable row in the group above does carry the generic sentence, and a predicate over the
    // whole strip would be answered by that one.
    const group = html.slice(html.indexOf(WAITING_ON_YOU_LABEL));
    expect(group).toContain('decision-rail-inert');
    expect(group).toContain(WAITING_ON_YOU_ACTION);
    expect(group).not.toContain(NO_CARD_NOTE);
  });

  it('still shows enough to chase the submission it is about', () => {
    const html = expandedStrip(mine());

    expect(html).toContain('rev 2');
    expect(html).toContain('no stated criterion');
  });
});

/**
 * The two claims that outlive any one render: what the stylesheet does with a disabled primary,
 * and what these files still SAY about a group that no longer exists.
 */
describe('what is left on disk', () => {
  /** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
  const fromRepo = (...candidates: string[]): string => {
    const found = candidates.map((each) => resolve(process.cwd(), each)).find(existsSync);
    if (!found) throw new Error(`none of ${candidates.join(', ')} exists from ${process.cwd()}`);
    return readFileSync(found, 'utf8');
  };

  /** Selector/body pairs, comments stripped so a rule cannot be satisfied by a sentence about it. */
  function rules(css: string): Array<{ selector: string; body: string }> {
    const found: Array<{ selector: string; body: string }> = [];
    const pattern = /([^{}]+)\{([^{}]*)\}/gu;
    const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    for (let match = pattern.exec(stripped); match; match = pattern.exec(stripped)) {
      found.push({ selector: match[1].trim(), body: match[2] });
    }
    return found;
  }

  it('gives a disabled primary a different shape, not the same shape at half strength', () => {
    // `CardAction.tsx` promises that an action which cannot succeed arrives as `disabled` rather
    // than lit-and-refused. JS kept it and the stylesheet did not: `.card-action:disabled` set
    // opacity and a cursor, so a solid brand slab at 50% was still the most pressable-looking
    // thing on a card that has just said no decision can be recorded here. The fill has to go.
    const css = fromRepo('src/index.css', 'src/web/src/index.css');
    // `:not(:disabled)` mentions both halves and is the hover rule, so it is taken out of the
    // selector before the question is asked. Without that this passes on the stylesheet it was
    // written to reject.
    const disabledPrimary = rules(css).filter((rule) => {
      const selector = rule.selector.replace(/:not\([^)]*\)/gu, '');
      return /\.card-action--primary\b/u.test(selector) && selector.includes(':disabled');
    });

    expect(disabledPrimary.length).toBeGreaterThan(0);
    expect(disabledPrimary.some((rule) => /(^|[;\s])background\s*:/u.test(rule.body))).toBe(true);
    // And the enabled tone still is the solid one, so this is a difference in shape between the
    // two states rather than the primary having quietly stopped being primary.
    const enabledPrimary = rules(css).filter((rule) => rule.selector.trim() === '.card-action--primary');
    expect(enabledPrimary.length).toBe(1);
    expect(enabledPrimary[0].body).toMatch(/background\s*:\s*var\(--brand\)/u);
  });

  it('leaves no text describing the group that was removed', () => {
    // Contract prose is part of the contract. A comment that still explains why a third group is
    // kept, beside an implementation that no longer has one, is a file telling a reader something
    // untrue — and it is how a removed thing gets added back by somebody who believed the comment.
    for (const [name, body] of [
      ['pending-evidence-judgments.ts', fromRepo(
        '../apiserver/src/tasks/pending-evidence-judgments.ts',
        'src/apiserver/src/tasks/pending-evidence-judgments.ts',
      )],
      ['DecisionRail.tsx', fromRepo(
        'src/components/DecisionRail.tsx',
        'src/web/src/components/DecisionRail.tsx',
      )],
    ] as const) {
      expect(body.toLowerCase().includes('awaitingsubmitter'), name).toBe(false);
    }
  });
});

describe('the row says when, in whole units', () => {
  it('reads ages in whole units', () => {
    expect(formatAge(30)).toBe('just now');
    expect(formatAge(40 * 60)).toBe('40m');
    expect(formatAge(3 * HOUR)).toBe('3h');
    expect(formatAge(90 * 60)).toBe('1h 30m');
    expect(formatAge(50 * HOUR)).toBe('2d 2h');
  });

  it('leads the group with the oldest, and puts the age on every row', () => {
    const html = expandedStrip(queue());
    expect(html).toContain('oldest 3h');
    expect(occurrences(html, 'decision-rail-row')).toBe(3);
    expect(html.indexOf('the decision door')).toBeLessThan(html.indexOf('the evidence envelope'));
    expect(html.indexOf('the evidence envelope')).toBeLessThan(html.indexOf('the stalled inventory'));
    expect(html).toContain('3t4PyphGUWQtzDGfvOLY9R');
    expect(occurrences(html, 'rev 2')).toBe(3);
    expect(html).toContain('40m');
  });
});
