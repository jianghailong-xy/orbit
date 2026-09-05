import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_LABEL,
  DECISION_HEADING,
  DecisionCard,
  DecisionLog,
  DecisionStrip,
  NEEDS_DECISION_LABEL,
  SEND_BACK_LABEL,
  WAITING_ON_YOU_HEADING,
  WAITING_ON_YOU_LABEL,
  completionConfirmedLine,
  formatAge,
  formatSubmitted,
  needsDecisionCount,
  sentBackLine,
  waitingOnYouCount,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * What the strip puts on screen, and — the half that matters more — what it does not.
 *
 * Every assertion is a PREDICATE over the rendered output: this word is present, that control is
 * absent, this many of these exist. None of them pins a paragraph verbatim, because a test that
 * does passes while the screen lies and fails when somebody fixes a typo.
 *
 * The reverse assertions are the point of the file, and there are now three of them.
 *
 *  - "No bulk answer" is not a feature anybody will notice missing — it is a property that quietly
 *    disappears the first time somebody with fifteen pending rows wants to be done with them.
 *  - "No control that is pressable and doomed" is the rule the previous round of this card was
 *    fixed to satisfy, asserted over every state the card can be in rather than over the two
 *    somebody remembered.
 *  - And "nothing is shown to a reader who cannot act on it", which is what this round is about.
 *    The rows are found on the ACCOUNT, so the failure mode is not that a session sees too few —
 *    it is that every session sees all of them, one fact painted onto as many faces as there are
 *    open windows. That regression is invisible to any test that renders one session, so the test
 *    below renders four and asserts the group appears in exactly the ones with standing to answer.
 *    A greyed group carrying the same stall to everybody was that same broadcast one heading
 *    further down, so the copy it was worded in is asserted ABSENT from the rendered output.
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
      { kind: 'TOOL_CALL', ref: 'toolu_first', resolved: true, reason: null },
      { kind: 'COMMIT', ref: '7ad996c2', resolved: false, reason: 'no COMMIT of this task matches this reference' },
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

/** The strip as a reader first meets it: folded. */
const collapsed = (payload: PendingDecisionQueue): string =>
  render(
    <DecisionStrip
      queue={payload}
      open={false}
      expandedTaskId={null}
      onToggle={() => {}}
      onExpand={() => {}}
    />,
  );

/** And after the one interaction that opens it. */
const expandedStrip = (payload: PendingDecisionQueue, expandedTaskId: string | null = null): string =>
  render(
    <DecisionStrip
      queue={payload}
      open
      expandedTaskId={expandedTaskId}
      onToggle={() => {}}
      onExpand={() => {}}
    />,
  );

/** Count non-overlapping occurrences — "how many of these are on screen" is the whole question in
 *  the bulk-action tests, and `includes` cannot answer it. */
function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The one rendered `<button>` carrying this label. Asserts there is exactly one, so a question
 *  about "the Confirm button" cannot silently be answered about a different one. */
function actionButton(html: string, label: string): string {
  const buttons = html
    .split('<button')
    .slice(1)
    .map((chunk) => `<button${chunk.split('</button>')[0]}</button>`)
    .filter((button) => button.includes(label));
  expect(buttons.length).toBe(1);
  return buttons[0];
}

/** Whether that button can be pressed at all. `disabled` is the whole answer: a control greyed by
 *  CSS alone still fires, and "looks unavailable" is not what this file is asserting anywhere. */
function pressable(html: string, label: string): boolean {
  return !/\sdisabled(?:=|\s|>)/.test(actionButton(html, label));
}

/** One card, on its own, in whatever state the matrix below is asking about. */
function card(
  only: PendingDecisionRow,
  over: { note?: string; busy?: boolean } = {},
): string {
  return render(
    <DecisionCard
      row={only}
      narrow={false}
      note={over.note ?? ''}
      busy={over.busy ?? false}
      error={null}
      onNote={() => {}}
      onDecide={() => {}}
    />,
  );
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

    // No group headings, no rows, no cards: the counts are the whole of the folded state.
    expect(html).not.toContain(NEEDS_DECISION_LABEL);
    expect(html).not.toContain(WAITING_ON_YOU_LABEL);
    expect(html).not.toContain('the decision door');
    expect(html).not.toContain('the SOURCE contract rebase');
    expect(occurrences(html, 'decision-rail-row')).toBe(0);
    expect(html).not.toContain(CONFIRM_LABEL);
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
 * The scope claim, which is what this round is about.
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
    expect(html).not.toContain(DECISION_HEADING);
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

  it('never lists a row under DECIDE that the door would refuse from this reader', () => {
    // The property, said without reference to the fixture: whatever arrives, what is rendered
    // under the heading that asks for a decision is answerable by the reader it is shown to.
    const html = expandedStrip(accountWide(['task-b']), 'task-b');
    expect(html).not.toContain('run of the task it is deciding');
    expect(html).not.toContain('the SOURCE selector audit');
  });
});

describe('the expanded card', () => {
  const expanded = (over: Partial<PendingDecisionRow> = {}, narrow = false): string => {
    const only = row({ taskId: 'task-open', ...over });
    return render(
      <DecisionStrip
        queue={{
          decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
          count: 1,
          oldestAgeSeconds: only.ageSeconds,
          pending: [only],
          waitingOnYou: [],
        }}
        open
        expandedTaskId="task-open"
        narrow={narrow}
        onToggle={() => {}}
        onExpand={() => {}}
      />,
    );
  };

  it('leads the group with the oldest age, and puts the facts on every row', () => {
    const html = expandedStrip(queue());
    expect(html).toContain(NEEDS_DECISION_LABEL);
    expect(html).toContain('oldest 3h');
    expect(occurrences(html, 'decision-rail-row')).toBe(3);
    expect(html.indexOf('the decision door')).toBeLessThan(html.indexOf('the evidence envelope'));
    expect(html.indexOf('the evidence envelope')).toBeLessThan(html.indexOf('the stalled inventory'));
    expect(html).toContain('3t4PyphGUWQtzDGfvOLY9R');
    expect(occurrences(html, 'rev 2')).toBe(3);
    expect(html).toContain('40m');
  });

  it('is headed DECISION REQUIRED and quotes the criterion by key and by text', () => {
    const html = expanded();
    expect(html).toContain(DECISION_HEADING);
    expect(html).toContain('Against criterion');
    expect(html).toContain('3t4PyphGUWQtzDGfvOLY9R');
    expect(html).toContain('coordinator 会话有判断面');
  });

  it('names the revision and what each citation resolved to', () => {
    const html = expanded();
    expect(html).toContain('Evidence rev 2');
    expect(html).toContain('1 of 2 resolved');
    expect(html).toContain('toolu_first');
    expect(html).toContain('no COMMIT of this task matches this reference');
  });

  it('never folds the declared gaps, and folds the citation list instead when narrow', () => {
    const wide = expanded();
    const narrow = expanded({}, true);

    for (const html of [wide, narrow]) {
      expect(html).toContain('Declared gaps');
      expect(html).toContain('iOS is not covered by this project');
    }
    // What narrow gives up is the per-citation list; the tally that says how many held stays.
    expect(narrow).toContain('1 of 2 resolved');
    expect(narrow).not.toContain('toolu_first');
    expect(wide).toContain('toolu_first');
  });

  it('says an empty gap list is a claim rather than an omission', () => {
    expect(expanded({ gaps: [] })).toContain('declared no gaps');
  });

  it('states the independence assertion on a row it does offer', () => {
    expect(expanded()).toContain('this session did not do this work');
  });

  it('offers exactly two buttons: Confirm completion and Send back', () => {
    const html = expanded();
    expect(html).toContain(CONFIRM_LABEL);
    expect(html).toContain(SEND_BACK_LABEL);
    expect(occurrences(html, CONFIRM_LABEL)).toBe(1);
    expect(occurrences(html, SEND_BACK_LABEL)).toBe(1);
  });
});

describe('there is no way to answer more than one at a time', () => {
  const threeWithOneOpen = expandedStrip(queue(), 'task-oldest');

  it('offers one pair of buttons however many rows are waiting', () => {
    // Three questions on screen, one card open, one pair of buttons. Judging three means opening
    // three cards; there is no press that answers a row nobody read.
    expect(occurrences(threeWithOneOpen, 'decision-rail-row')).toBe(3);
    expect(occurrences(threeWithOneOpen, CONFIRM_LABEL)).toBe(1);
    expect(occurrences(threeWithOneOpen, SEND_BACK_LABEL)).toBe(1);
  });

  it('renders no selection control a bulk action could be built on', () => {
    expect(threeWithOneOpen).not.toContain('type="checkbox"');
    expect(threeWithOneOpen).not.toContain('type="radio"');
    expect(threeWithOneOpen.toLowerCase()).not.toContain('select all');
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
      expect(threeWithOneOpen).not.toContain(label);
    }
  });

  it('never says Mark complete, because nothing here writes a status', () => {
    expect(threeWithOneOpen).not.toContain('Mark complete');
    expect(threeWithOneOpen.toLowerCase()).not.toContain('mark complete');
  });
});

/**
 * A decision is an EVENT. It happened once, and it goes on having happened.
 *
 * The pinned strip says what is true NOW, so an answered question leaves it on the next read. If
 * that were the whole story a decision would be a thing that made a row silently vanish — so the
 * sentence describing it belongs in the log, where the rest of what happened is.
 */
describe('what a decision leaves behind', () => {
  it('names the task, the standard and the exact version that was answered', () => {
    expect(completionConfirmedLine('the stalled inventory', '3t4PyphGUWQtzDGfvOLY9R', '3')).toBe(
      'Completion confirmed — the stalled inventory against 3t4PyphGUWQtzDGfvOLY9R, bound to rev 3',
    );
    // Legacy evidence has no key to name; the line says so rather than leaving a blank.
    expect(completionConfirmedLine('the SOURCE contract rebase', null, '1')).toContain(
      'no stated criterion',
    );
    expect(sentBackLine('the stalled inventory', '3')).toBe(
      'Sent back — the stalled inventory, bound to rev 3',
    );
  });

  it('renders in the log rather than in the pinned strip', () => {
    const line = completionConfirmedLine('the stalled inventory', '3t4PyphGUWQtzDGfvOLY9R', '3');
    const log = render(<DecisionLog lines={[line]} />);
    expect(log).toContain('decision-log-line');
    expect(log).toContain(line);

    // And the strip has no channel for it at all: there is no prop that would put a past answer in
    // the pinned area, so one cannot accumulate there.
    expect(expandedStrip(queue())).not.toContain('Completion confirmed');
    expect(render(<DecisionLog lines={[]} />)).toBe('');
  });

  it('keeps them in the order they happened', () => {
    const first = completionConfirmedLine('the decision door', 'C2', '1');
    const second = sentBackLine('the evidence envelope', '4');
    const html = render(<DecisionLog lines={[first, second]} />);
    expect(html.indexOf(first)).toBeLessThan(html.indexOf(second));
  });
});

describe('the strip is a read face', () => {
  it('renders the whole payload it was handed without issuing a request', () => {
    // No `../api` is mocked anywhere in this file, and every test above renders. A component that
    // fetched on render would have thrown on the missing token, so this holds the property that
    // the rows come from the server's derived read and nothing is assembled here.
    expect(expandedStrip(queue(), 'task-middle')).toContain(DECISION_HEADING);
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
      const renders = [
        collapsed(payload),
        expandedStrip(payload),
        expandedStrip(payload, 'task-legacy'),
        expandedStrip(payload, 'task-answerable'),
      ];
      for (const html of renders) {
        expect(html.toLowerCase()).not.toContain('waiting on the submitter');
        expect(html.toUpperCase()).not.toContain('NOTHING FOR YOU TO DO HERE');
        expect(html.toUpperCase()).not.toContain('NOTHING TO DECIDE YET');
      }
    }
  });

  it('reads as an instruction in the one session that can act on it', () => {
    const html = expandedStrip(mine(), 'task-legacy');

    // Its own group, addressed to the reader, with the row it is about under it.
    expect(html).toContain(WAITING_ON_YOU_LABEL);
    expect(html).toContain('the SOURCE contract rebase');
    expect(html).toContain(WAITING_ON_YOU_HEADING);
    // Greyed is not hidden, and never was: the row is still a control that opens.
    expect(html).toContain('decision-rail-summary');
    // The reason is the door's own, and the sentence after it says what to do about it.
    expect(html).toContain('quotes no project criterion');
    expect(html).toContain('This is your own submission');
    expect(html).toContain('submit another evidence revision quoting the project criterion');
    expect(html).toContain('not by this session and not by any other');
    // Still nothing to press: this session cannot decide it either, and never could.
    expect(html).not.toContain(DECISION_HEADING);
    expect(pressable(html, CONFIRM_LABEL)).toBe(false);
    expect(pressable(html, SEND_BACK_LABEL)).toBe(false);
  });

  it('leaves Confirm completion unpressable, and offers no note nobody could send', () => {
    const html = card(undecidable());

    expect(pressable(html, CONFIRM_LABEL)).toBe(false);
    // Send back is refused too — the door checks the criterion before it looks at which decision
    // was asked for — so it is not lit either, and the box for the note it would carry is gone.
    expect(pressable(html, SEND_BACK_LABEL)).toBe(false);
    expect(html).not.toContain('What the next evidence revision must show');
  });

  it('still shows everything a reader would need to chase the submitter', () => {
    const html = card(undecidable({ gaps: ['the full suite has not been run against this branch'] }));

    expect(html).toContain('Evidence rev 2');
    expect(html).toContain('Declared gaps');
    expect(html).toContain('the full suite has not been run against this branch');
  });
});

describe('no control is ever pressable and doomed', () => {
  const answerable = () => row();

  it('offers both buttons on a row this session may answer', () => {
    // The rules as stated: confirm needs standing, send back needs standing and a note.
    const empty = card(answerable());
    expect(pressable(empty, CONFIRM_LABEL)).toBe(true);
    expect(pressable(empty, SEND_BACK_LABEL)).toBe(false);

    const noted = card(answerable(), { note: 'cite the run that produced it' });
    expect(pressable(noted, CONFIRM_LABEL)).toBe(true);
    expect(pressable(noted, SEND_BACK_LABEL)).toBe(true);
  });

  it('holds both buttons while an answer is in flight', () => {
    const busy = card(answerable(), { note: 'cite the run that produced it', busy: true });
    expect(pressable(busy, CONFIRM_LABEL)).toBe(false);
    expect(pressable(busy, SEND_BACK_LABEL)).toBe(false);
  });

  /**
   * The property this card exists to have, over every state it can be in.
   *
   * The three things the decision door checks before it writes anything are: a live stated
   * criterion to measure against, a session that did not do the work, and — for a send-back — a
   * note. Each one is a REFUSAL, so a button that is pressable while one of them is missing is a
   * button whose only outcome is an error message. This asserts the implication in that direction
   * as well as the equality: pressable ⇒ the request would be accepted.
   */
  it('never lights a button the server would refuse, in any combination', () => {
    for (const decidable of [true, false]) {
      for (const independent of [true, false]) {
        for (const note of ['', '  ', 'say what the next revision must show']) {
          for (const busy of [true, false]) {
            const subject = decidable ? row() : undecidable();
            const html = card(
              {
                ...subject,
                independence: independent
                  ? { independent: true, disqualification: null, requiredAction: null }
                  : { ...DISQUALIFIED },
              },
              { note, busy },
            );
            const state = `decidable=${decidable} independent=${independent} `
              + `note=${JSON.stringify(note)} busy=${busy}`;
            const wouldBeAccepted = decidable && independent && !busy;

            expect(pressable(html, CONFIRM_LABEL), `CONFIRM at ${state}`).toBe(wouldBeAccepted);
            expect(pressable(html, SEND_BACK_LABEL), `SEND_BACK at ${state}`).toBe(
              wouldBeAccepted && note.trim() !== '',
            );
            // Said the other way round, because this is the direction that fails when somebody
            // adds a fourth state and forgets one of the three checks: a pressable Confirm is a
            // Confirm the door would take.
            if (pressable(html, CONFIRM_LABEL)) {
              expect(decidable, `a pressable CONFIRM at ${state}`).toBe(true);
              expect(independent, `a pressable CONFIRM at ${state}`).toBe(true);
            }
          }
        }
      }
    }
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

describe('the revision line says when, whatever else it has', () => {
  it('names the moment beside the revision', () => {
    // The screenshot this task started from: `Evidence rev 2 —` and then nothing at all.
    const html = card(row());
    expect(html).toContain('Evidence rev 2');
    expect(html).toContain('submitted 1h 30m ago');
  });

  it('says legacy evidence states no claim rather than trailing off after the dash', () => {
    const html = card(undecidable({ ageSeconds: 50 * 3600 }));
    expect(html).toContain('submitted 2d 2h ago');
    expect(html).toContain('this revision states no claim');
  });

  it('reads a fresh submission as a moment rather than as an age', () => {
    expect(formatSubmitted(30)).toBe('submitted just now');
    expect(formatSubmitted(40 * 60)).toBe('submitted 40m ago');
    expect(formatSubmitted(90 * 60)).toBe('submitted 1h 30m ago');
  });

  it('reads ages in whole units', () => {
    expect(formatAge(30)).toBe('just now');
    expect(formatAge(40 * 60)).toBe('40m');
    expect(formatAge(3 * HOUR)).toBe('3h');
    expect(formatAge(90 * 60)).toBe('1h 30m');
    expect(formatAge(50 * HOUR)).toBe('2d 2h');
  });
});
