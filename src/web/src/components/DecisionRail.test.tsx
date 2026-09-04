import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_LABEL,
  DECISION_HEADING,
  DecisionRail,
  RAIL_LABEL,
  SEND_BACK_LABEL,
  completionConfirmedLine,
  formatAge,
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
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
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
