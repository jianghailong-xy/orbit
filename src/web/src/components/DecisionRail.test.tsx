import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AWAITING_SUBMITTER_HEADING,
  AWAITING_SUBMITTER_LABEL,
  CONFIRM_LABEL,
  DECISION_HEADING,
  DecisionCard,
  DecisionRail,
  RAIL_LABEL,
  SEND_BACK_LABEL,
  completionConfirmedLine,
  formatAge,
  formatSubmitted,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * What the rail puts on screen, and — the half that matters more — what it does not.
 *
 * Every assertion is a PREDICATE over the rendered output: this word is present, that control is
 * absent, this many of these exist. None of them pins a paragraph verbatim, because a test that
 * does passes while the screen lies and fails when somebody fixes a typo.
 *
 * The reverse assertion is the point of the file. "No bulk answer" is not a feature anybody will
 * notice missing — it is a property that quietly disappears the first time somebody with fifteen
 * pending rows wants to be done with them, and the only thing that keeps it is a test that fails
 * when it goes. So: no checkbox, no control that says "all", exactly one pair of buttons however
 * many rows are waiting, and never the words `Mark complete`.
 *
 * NO `../api` MOCK and none needed: `DecisionRail` takes its payload as a prop and issues no
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
    awaitingSubmitter: [],
    ...over,
  };
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element);

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

describe('the pinned rail', () => {
  it('renders one row per pending fact, with the count and the oldest age', () => {
    const html = render(<DecisionRail queue={queue()} expandedTaskId={null} onExpand={() => {}} />);

    expect(html).toContain(RAIL_LABEL);
    expect(html).toContain('3 waiting');
    // The rail leads with the age of the oldest question, and the oldest row is the first one.
    expect(html).toContain('oldest 3h');
    expect(occurrences(html, 'decision-rail-row')).toBe(3);
    expect(html.indexOf('the decision door')).toBeLessThan(html.indexOf('the evidence envelope'));
    expect(html.indexOf('the evidence envelope')).toBeLessThan(html.indexOf('the stalled inventory'));
  });

  it('puts the task, the criterion, the evidence revision and the age on every row', () => {
    const html = render(<DecisionRail queue={queue()} expandedTaskId={null} onExpand={() => {}} />);

    expect(html).toContain('the decision door');
    expect(html).toContain('3t4PyphGUWQtzDGfvOLY9R');
    expect(occurrences(html, 'rev 2')).toBe(3);
    expect(html).toContain('40m');
  });

  it('renders nothing at all when nothing is waiting', () => {
    const html = render(
      <DecisionRail
        queue={queue({ count: 0, pending: [], oldestAgeSeconds: null })}
        expandedTaskId={null}
        onExpand={() => {}}
      />,
    );
    expect(html).toBe('');
  });
});

describe('the expanded card', () => {
  const expanded = (over: Partial<PendingDecisionRow> = {}, narrow = false): string => {
    const only = row({ taskId: 'task-open', ...over });
    return render(
      <DecisionRail
        queue={{
          decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
          count: 1,
          oldestAgeSeconds: only.ageSeconds,
          pending: [only],
          awaitingSubmitter: [],
        }}
        expandedTaskId="task-open"
        narrow={narrow}
        onExpand={() => {}}
      />,
    );
  };

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

  it('states the independence assertion, and says why when the reader may not answer', () => {
    expect(expanded()).toContain('this session did not do this work');

    const disqualified = expanded({
      independence: {
        independent: false,
        disqualification: 'this session is a run of the task it is deciding',
        requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
      },
    });
    expect(disqualified).toContain('run of the task it is deciding');
    // Still a question, and still on the rail: it is simply not this reader's to settle.
    expect(disqualified).toContain(DECISION_HEADING);
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
  const threeWithOneOpen = render(
    <DecisionRail queue={queue()} expandedTaskId="task-oldest" onExpand={() => {}} />,
  );

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

describe('the copy', () => {
  it('states a settled row as the standard and the version that was answered', () => {
    expect(completionConfirmedLine('3t4PyphGUWQtzDGfvOLY9R', '2')).toBe(
      'Completion confirmed — coordinator · 3t4PyphGUWQtzDGfvOLY9R · rev 2',
    );
  });

  it('shows the settled line in place of the rail once the last question is answered', () => {
    const html = render(
      <DecisionRail
        queue={queue({ count: 0, pending: [], oldestAgeSeconds: null })}
        expandedTaskId={null}
        settled={completionConfirmedLine('3t4PyphGUWQtzDGfvOLY9R', '2')}
        onExpand={() => {}}
      />,
    );
    expect(html).toContain('Completion confirmed — coordinator');
    expect(html).toContain('rev 2');
  });

  it('reads ages in whole units', () => {
    expect(formatAge(30)).toBe('just now');
    expect(formatAge(40 * 60)).toBe('40m');
    expect(formatAge(3 * HOUR)).toBe('3h');
    expect(formatAge(90 * 60)).toBe('1h 30m');
    expect(formatAge(50 * HOUR)).toBe('2d 2h');
  });
});

describe('the rail is a read face', () => {
  it('renders the whole payload it was handed without issuing a request', () => {
    // No `../api` is mocked anywhere in this file, and every test above renders. A component that
    // fetched on render would have thrown on the missing token, so this holds the property that
    // the rows come from the server's derived read and nothing is assembled here.
    expect(render(<DecisionRail queue={queue()} expandedTaskId="task-middle" onExpand={() => {}} />))
      .toContain(DECISION_HEADING);
  });
});

describe('a row the door would refuse whatever was pressed', () => {
  const mixed = (): PendingDecisionQueue => {
    const answerable = row({ taskId: 'task-answerable', title: 'the derived pending queue' });
    return {
      decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
      count: 1,
      oldestAgeSeconds: answerable.ageSeconds,
      pending: [answerable],
      awaitingSubmitter: [undecidable({ taskId: 'task-legacy', title: 'the SOURCE contract rebase' })],
    };
  };

  it('is listed, but not among the ones a decision is being asked for', () => {
    const html = render(
      <DecisionRail queue={mixed()} expandedTaskId={null} onExpand={() => {}} />,
    );

    // Both groups are on screen: the row is not hidden, and the submitter is not left waiting on a
    // question nobody can see.
    expect(html).toContain(RAIL_LABEL);
    expect(html).toContain(AWAITING_SUBMITTER_LABEL);
    expect(html).toContain('the SOURCE contract rebase');
    // The number the rail leads with counts only what a decider can answer. A "2 waiting" that
    // includes one nobody can answer is the same false promise one level up.
    expect(html).toContain('1 waiting');
    expect(html).not.toContain('2 waiting');
    expect(html).toContain('1 cannot be decided yet');
    // And it is below, in the other group: the answerable row comes before that group's heading,
    // the unanswerable one after it.
    expect(html.indexOf('the derived pending queue')).toBeLessThan(html.indexOf(AWAITING_SUBMITTER_LABEL));
    expect(html.indexOf(AWAITING_SUBMITTER_LABEL)).toBeLessThan(html.indexOf('the SOURCE contract rebase'));
  });

  it('is headed by what is missing rather than by a demand nobody can meet', () => {
    const html = render(
      <DecisionRail queue={mixed()} expandedTaskId="task-legacy" onExpand={() => {}} />,
    );

    expect(html).toContain(AWAITING_SUBMITTER_HEADING);
    expect(html).not.toContain(DECISION_HEADING);
    // The reason is the door's own, and the sentence after it says who clears it and how.
    expect(html).toContain('quotes no project criterion');
    expect(html).toContain('The next evidence revision has to quote the project criterion');
    expect(html).toContain('not by this session and not by any other');
  });

  it('leaves Confirm completion unpressable, and offers no note nobody could send', () => {
    const html = card(undecidable());

    // (4) The action that would always be refused is not an action.
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
    // (5) The rules as stated: confirm needs standing, send back needs standing and a note.
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
   * (6) The property this card exists to have, over every state it can be in.
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
                  : {
                      independent: false,
                      disqualification: 'this session is a run of the task it is deciding',
                      requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
                    },
              },
              { note, busy },
            );
            const state = `decidable=${decidable} independent=${independent} note=${JSON.stringify(note)} busy=${busy}`;
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
});
