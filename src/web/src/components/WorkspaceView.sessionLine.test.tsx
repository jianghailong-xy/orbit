import { describe, expect, it } from 'vitest';
import { COORDINATOR_DELIVERY_KINDS, type CoordinatorDeliveryCard } from '@orbit/shared';
import { coordinatorDeliverySentence } from '../lib/coordinatorDelivery';
import { SESSION_MESSAGE_UNTITLED } from '../lib/sessionMessage';
import { SENT_BY_ORBIT, SENT_BY_YOU, sessionLine, statusLabel } from './WorkspaceView';

/**
 * The session row's second line. Kept in step with the native port
 * (`OrbitKit/App/SessionLine.swift` + `SessionLineTests`) — the two are hand-synced, so the same
 * cases are asserted on both sides.
 */
describe('sessionLine', () => {
  /**
   * A parked conversation with something waiting on the account owner.
   *
   * `pendingApprovals` is no longer only blocked tool calls: the server adds the owner decisions
   * this conversation is the surface for (`owner-decision-signal.ts`), and those are held open by
   * nobody — the card is delivered and the turn ends underneath it. So the row's amber state cannot
   * sit behind the generating gate, which is where it used to sit and why a real criteria decision
   * left the row reading as an ordinary idle reply.
   */
  it('says somebody is waiting even when the conversation has parked', () => {
    const parked = {
      status: 'AWAITING_INPUT',
      engineTurnActive: false,
      projectId: 'p_1',
      lastAssistantText: 'Filed the proposal.',
    };
    expect(sessionLine({ ...parked, pendingApprovals: 1 }, true)).toEqual({
      text: 'Waiting for approval',
      tone: 'approval',
    });
    expect(statusLabel({ ...parked, pendingApprovals: 1 })).toBe('Waiting for approval');
    // The paired negative, over the SAME row: with nothing waiting it is an ordinary preview, so
    // the amber above is about the count and not about this fixture.
    expect(sessionLine({ ...parked, pendingApprovals: 0 }, true)).toEqual({
      text: 'Filed the proposal.',
      tone: 'preview',
    });
    expect(statusLabel({ ...parked, pendingApprovals: 0 })).toBe('Waiting for your reply');
  });

  /**
   * One of the four owner items says WHICH it is, in the words the bar above the list and the card
   * in the conversation share — the oldest item, which is the one the bar names, so a person who
   * pressed either arrives at a card saying what they read. A row calling an escalated exception
   * "Waiting for approval" described the one act that was certainly not happening.
   */
  it('names which of the four is waiting, and falls back when it cannot', () => {
    const waiting = {
      status: 'AWAITING_INPUT',
      engineTurnActive: false,
      projectId: 'p_1',
      waitingKind: 'OWNER_ITEM',
      lastAssistantText: 'Filed the proposal.',
    };
    const escalated = { itemId: 'i1', kind: 'ESCALATED', title: 'Task failed: 000_00022',
                        since: '2026-09-22T00:19:41Z' };
    const paused = { itemId: 'i2', kind: 'FUSE_PAUSED', title: 'Paused',
                     since: '2026-09-22T02:00:00Z' };
    expect(sessionLine({ ...waiting, pendingApprovals: 1, ownerItems: [escalated] }, true)).toEqual({
      text: 'Escalated to you',
      tone: 'approval',
    });
    // The oldest item is the one named — the same FIFO the bar picks its target by — and the order
    // the row happens to hold them in is not what decides it.
    expect(
      statusLabel({ ...waiting, pendingApprovals: 2, ownerItems: [paused, escalated] }),
    ).toBe('Escalated to you');
    // Nothing to name keeps the generic words: a row from an older control plane, or one whose
    // items are kinds this build has no words for.
    expect(statusLabel({ ...waiting, pendingApprovals: 1 })).toBe('Waiting for approval');
    expect(
      statusLabel({ ...waiting, pendingApprovals: 1, ownerItems: [{ ...escalated, kind: 'A_FIFTH_KIND' }] }),
    ).toBe('Waiting for approval');
    // And with nothing waiting at all the kind decides nothing: the row is an ordinary preview.
    expect(sessionLine({ ...waiting, pendingApprovals: 0, ownerItems: [escalated] }, true)).toEqual({
      text: 'Filed the proposal.',
      tone: 'preview',
    });
  });

  // §10.7 / §7.6 V13 (owner 2026-10-28): the fifth owner item, in the kind word all three clients
  // copy verbatim. Not an escalation, so its `need` — the same words — is not appended a second time.
  it('names work that reached main without the owner’s confirmation by its kind word', () => {
    const landed = { itemId: 'i5', kind: 'LANDED_WITHOUT_CONFIRMATION',
                     title: 'Reached main without your confirmation: Fix the login redirect',
                     need: 'Landed without your confirmation', since: '2026-10-29T01:00:00Z' };
    const waiting = {
      status: 'AWAITING_INPUT',
      engineTurnActive: false,
      projectId: 'p_1',
      waitingKind: 'OWNER_ITEM',
      pendingApprovals: 1,
    };
    expect(sessionLine({ ...waiting, ownerItems: [landed] }, true)).toEqual({
      text: 'Landed without your confirmation',
      tone: 'approval',
    });
    // The oldest item still names the row: an older question beats it, a newer one does not.
    const question = { itemId: 'i6', kind: 'COORDINATOR_QUESTION', title: 'q', since: '2026-10-29T00:00:00Z' };
    expect(statusLabel({ ...waiting, pendingApprovals: 2, ownerItems: [landed, question] }))
      .toBe('Question from coordinator');
    expect(statusLabel({ ...waiting, pendingApprovals: 2, ownerItems: [landed, { ...question, since: '2026-10-29T02:00:00Z' }] }))
      .toBe('Landed without your confirmation');
  });

  it('writes the server need after the escalation marker', () => {
    expect(sessionLine({
      status: 'AWAITING_INPUT',
      engineTurnActive: false,
      waitingKind: 'OWNER_ITEM',
      pendingApprovals: 1,
      ownerItems: [{
        itemId: 'i1',
        kind: 'ESCALATED',
        title: 'Checks failed on the combined tree',
        need: 'Checks failed',
        since: '2026-09-22T00:19:41Z',
      }],
    }, true)).toEqual({ text: 'Escalated to you · Checks failed', tone: 'approval' });
  });

  /** A merge approval asks to merge into the project's main branch, which the item names. */
  it('names the branch a merge approval merges into, main as before', () => {
    const waiting = {
      status: 'AWAITING_INPUT',
      engineTurnActive: false,
      projectId: 'p_1',
      waitingKind: 'OWNER_ITEM',
      pendingApprovals: 1,
    };
    const approval = { itemId: 'i3', kind: 'PROMOTION_APPROVAL', title: 'Approve merge to main',
                       since: '2026-09-22T00:19:41Z' };
    expect(sessionLine({ ...waiting, ownerItems: [{ ...approval, mainBranch: 'master' }] }, true)).toEqual({
      text: 'Approve merge to master',
      tone: 'approval',
    });
    // Main by name, no repository bound (null) and an older server (absent) read as they always did.
    for (const mainBranch of ['main', null, undefined]) {
      expect(statusLabel({ ...waiting, ownerItems: [{ ...approval, mainBranch }] }), String(mainBranch))
        .toBe('Approve merge to main');
    }
    // Only the merge names a branch.
    const escalated = { itemId: 'i1', kind: 'ESCALATED', title: 'Task failed: 000_00022',
                        since: '2026-09-22T00:19:41Z', mainBranch: 'master' };
    expect(statusLabel({ ...waiting, ownerItems: [escalated] })).toBe('Escalated to you');
  });

  it('names the project closing signals in the session row', () => {
    const parked = { status: 'AWAITING_INPUT', pendingApprovals: 1, projectId: 'p_1' };
    expect(sessionLine({ ...parked, waitingKind: 'DONE_REQUEST' }, true)).toEqual({
      text: 'Ready to close',
      tone: 'approval',
    });
    expect(sessionLine({ ...parked, waitingKind: 'RECORD_AS_DONE' }, true)).toEqual({
      text: 'Record as done…',
      tone: 'approval',
    });
    expect(sessionLine({ ...parked, waitingKind: 'OWNER_REQUEST' }, true)).toEqual({
      text: 'Waiting on you',
      tone: 'approval',
    });
  });

  it('surfaces live state before any reply preview', () => {
    expect(sessionLine({ status: 'RUNNING', pendingApprovals: 2 }, true)).toEqual({
      text: 'Waiting for approval',
      tone: 'approval',
    });
    expect(
      sessionLine({ status: 'RUNNING', lastToolUse: 'mcp__orbit__task_create' }, true),
    ).toEqual({ text: 'Running task_create…', tone: 'running' });
    expect(sessionLine({ status: 'RUNNING' }, true)).toEqual({ text: 'Running…', tone: 'running' });
  });

  /**
   * A turn the runtime started for itself — a background task reporting in, a scheduled wake-up —
   * never reaches /turn-complete, so the session stays parked at AWAITING_INPUT while it streams.
   * The row must say what it is doing rather than fall through to the previous reply, which reads
   * as idle.
   */
  it('reads a self-driven turn as working, not as parked', () => {
    expect(
      sessionLine(
        {
          status: 'AWAITING_INPUT',
          engineTurnActive: true,
          lastToolUse: 'Bash',
          lastAssistantText: 'Waiting for the completion notification.',
        },
        true,
      ),
    ).toEqual({ text: 'Running Bash…', tone: 'running' });
    // Between tools there is no frontier tool, and the stale reply would read as idle.
    expect(sessionLine({ status: 'AWAITING_INPUT', engineTurnActive: true }, true)).toEqual({
      text: 'Running…',
      tone: 'running',
    });
    // Once the turn ends the server clears the flag and the reply preview takes over again.
    expect(
      sessionLine(
        { status: 'AWAITING_INPUT', engineTurnActive: false, lastAssistantText: 'All done.' },
        true,
      ),
    ).toEqual({ text: 'All done.', tone: 'preview' });
  });

  /**
   * The whole point of the line while a turn runs: it says whether what you sent has been answered
   * yet. The message is server-kept from the moment it is enqueued (SessionsService.createTurn) —
   * so it stands through the wait for a slot and through the tool phase — and it is marked as
   * yours, because unmarked it reads exactly like a reply to it.
   */
  it('shows the message you sent, marked as yours, until a reply lands', () => {
    expect(
      sessionLine(
        { status: 'RUNNING', lastAssistantText: 'previous reply', lastUserText: 'fix the drawer shadow' },
        true,
      ),
    ).toEqual({ text: 'You: fix the drawer shadow', tone: 'preview' });
    // A tool in flight still outranks it — that's what the session is doing right now.
    expect(
      sessionLine({ status: 'RUNNING', lastToolUse: 'Bash', lastUserText: 'fix the drawer shadow' }, true),
    ).toEqual({ text: 'Running Bash…', tone: 'running' });
    // The server clears it once the workspace answers, and the reply takes the line back.
    expect(sessionLine({ status: 'RUNNING', lastAssistantText: 'On it — reading the CSS.' }, true)).toEqual({
      text: 'On it — reading the CSS.',
      tone: 'preview',
    });
  });

  it('flattens the last reply into one prose line', () => {
    expect(
      sessionLine({ status: 'AWAITING_INPUT', lastAssistantText: '## Done\n\nFixed `Session`.' }, true),
    ).toEqual({ text: 'Done Fixed Session.', tone: 'preview' });
  });

  /**
   * A turn interrupted before the workspace said anything leaves the message you sent standing — the
   * server only clears `lastUserText` once the workspace actually answers — and it outranks the older
   * reply below it.
   */
  it('shows an unanswered message ahead of the previous reply', () => {
    expect(
      sessionLine(
        {
          status: 'INTERRUPTED',
          lastAssistantText: 'previous reply',
          lastUserText: '设置按钮的底色很奇怪，请帮我 review',
        },
        true,
      ),
    ).toEqual({ text: 'You: 设置按钮的底色很奇怪，请帮我 review', tone: 'preview' });
    // The row says what the bubble says, marks that are not Markdown's included.
    expect(
      sessionLine({ status: 'RUNNING', lastUserText: '把其他的 tea_user_profile_build_*_cnch 也修复了' }, true),
    ).toEqual({ text: 'You: 把其他的 tea_user_profile_build_*_cnch 也修复了', tone: 'preview' });
  });

  /**
   * Nothing to preview at all: the line falls back to the run's own state word rather than
   * vanishing. A missing line shortens the row on iOS, where the row is sized by its content.
   */
  it('falls back to the run state word when there is nothing to preview', () => {
    expect(sessionLine({ status: 'SUCCEEDED' }, true)).toEqual({
      text: 'Succeeded',
      tone: 'preview',
    });
    expect(sessionLine({ status: 'FAILED' }, true)).toEqual({ text: 'Failed', tone: 'preview' });
    expect(sessionLine({ status: 'INTERRUPTED' }, true)).toEqual({
      text: 'Interrupted',
      tone: 'preview',
    });
    // Trash (live: false) states the outcome the same way. The word is the *run's*: every
    // deliberate end is one neutral terminal regardless of endReason (sessionRunStateOf), and
    // "Completed" is the filing axis — sessionLifecycleLabel says that one, next to this.
    expect(sessionLine({ status: 'CANCELLED', endReason: 'completed' }, false)).toEqual({
      text: 'Ended',
      tone: 'preview',
    });
  });
});

/**
 * Whose message the line previews (docs/session-list-projects-design.md §3.5, owner 2026-11-07). The
 * server keeps one unanswered message per session whoever sent it, so a coordinator's row read "You:"
 * over a task's report. Another Orbit session's message (`lastUserFrom`) is named for that session,
 * as the conversation's card names it; "You" is only ever the owner's own words. Kept in step with
 * OrbitKit's `SessionLineSenderTests` and Android's `SessionLineTest`.
 */
describe('sessionLine names who sent the message it previews', () => {
  const report = 'Done: **the package builds**';
  const from = { sessionId: 'session-1', title: 'Build the package' };

  it('names another session by its title, while the turn runs and after it stopped', () => {
    expect(sessionLine({ status: 'RUNNING', lastAssistantText: 'previous reply', lastUserText: report, lastUserFrom: from }, true))
      .toEqual({ text: 'Build the package: Done: the package builds', tone: 'preview' });
    expect(sessionLine({ status: 'INTERRUPTED', lastAssistantText: 'previous reply', lastUserText: report, lastUserFrom: from }, true))
      .toEqual({ text: 'Build the package: Done: the package builds', tone: 'preview' });
    // Trash says it the same way.
    expect(sessionLine({ status: 'FAILED', lastUserText: report, lastUserFrom: from }, false))
      .toEqual({ text: 'Build the package: Done: the package builds', tone: 'preview' });
  });

  it('says You for the owner’s own message, and for an older server that names no sender', () => {
    expect(SENT_BY_YOU).toBe('You');
    expect(sessionLine({ status: 'RUNNING', lastUserText: 'ship it', lastUserFrom: null }, true))
      .toEqual({ text: 'You: ship it', tone: 'preview' });
    expect(sessionLine({ status: 'INTERRUPTED', lastUserText: 'ship it', lastUserFrom: null }, true))
      .toEqual({ text: 'You: ship it', tone: 'preview' });
    expect(sessionLine({ status: 'RUNNING', lastUserText: 'ship it' }, true))
      .toEqual({ text: 'You: ship it', tone: 'preview' });
    expect(sessionLine({ status: 'INTERRUPTED', lastUserText: 'ship it' }, true))
      .toEqual({ text: 'You: ship it', tone: 'preview' });
  });

  it('calls a sender with no title what the conversation’s card calls it, never You', () => {
    expect(SESSION_MESSAGE_UNTITLED).toBe('Untitled session');
    for (const title of ['', '   ', '\n\t ']) {
      expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'ship it', lastUserFrom: { sessionId: 'session-1', title } }, true))
        .toEqual({ text: 'Untitled session: ship it', tone: 'preview' });
    }
    // A title is named as written, without the spaces around it.
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'ship it', lastUserFrom: { sessionId: 'session-1', title: '  Build the package ' } }, true).text)
      .toBe('Build the package: ship it');
  });

  // A Feishu group member's message (`lastUserFromExternal`, docs/feishu-bot-design.md §8.2): named as the
  // conversation heads their bubble, `From Feishu · <name>`, never You.
  it('names a Feishu group member as From Feishu · <name>, while the turn runs and after it stopped', () => {
    const outsider = { source: 'FEISHU', name: 'Lin Mei' };
    expect(sessionLine({ status: 'RUNNING', lastAssistantText: 'previous reply', lastUserText: 'fix the **flaky** test', lastUserFromExternal: outsider }, true))
      .toEqual({ text: 'From Feishu · Lin Mei: fix the flaky test', tone: 'preview' });
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'fix the flaky test', lastUserFrom: null, lastUserFromExternal: outsider }, true))
      .toEqual({ text: 'From Feishu · Lin Mei: fix the flaky test', tone: 'preview' });
    expect(sessionLine({ status: 'FAILED', lastUserText: 'fix the flaky test', lastUserFromExternal: outsider }, false))
      .toEqual({ text: 'From Feishu · Lin Mei: fix the flaky test', tone: 'preview' });
    // Feishu would not say the name.
    expect(sessionLine({ status: 'RUNNING', lastUserText: 'fix it', lastUserFromExternal: { source: 'FEISHU', name: null } }, true))
      .toEqual({ text: 'From Feishu: fix it', tone: 'preview' });
    // Cleared with the text (null), or a source this client does not know: the owner's own, as before.
    expect(sessionLine({ status: 'RUNNING', lastUserText: 'fix it', lastUserFromExternal: null }, true))
      .toEqual({ text: 'You: fix it', tone: 'preview' });
    expect(sessionLine({ status: 'RUNNING', lastUserText: 'fix it', lastUserFromExternal: { source: 'SLACK', name: 'Lin Mei' } }, true))
      .toEqual({ text: 'You: fix it', tone: 'preview' });
  });

  // Somebody the owner invited to reply (ORBIT_GUEST, docs/session-guests-design.md §3): `From <name>`, never You.
  it('names a guest as From <name>, while the turn runs and after it stopped', () => {
    const guest = { source: 'ORBIT_GUEST', name: 'Alice Chen' };
    expect(sessionLine({ status: 'RUNNING', lastAssistantText: 'previous reply', lastUserText: 'Twice is fine, but CI should fail', lastUserFromExternal: guest }, true))
      .toEqual({ text: 'From Alice Chen: Twice is fine, but CI should fail', tone: 'preview' });
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'one more', lastUserFrom: null, lastUserFromExternal: guest }, true))
      .toEqual({ text: 'From Alice Chen: one more', tone: 'preview' });
    // A guest always has a name; a row from a server that sent none reads as before.
    expect(sessionLine({ status: 'RUNNING', lastUserText: 'one more', lastUserFromExternal: { source: 'ORBIT_GUEST', name: null } }, true))
      .toEqual({ text: 'You: one more', tone: 'preview' });
  });

  it('changes nothing above the message, and a sender with no message makes no line', () => {
    expect(sessionLine({ status: 'RUNNING', lastToolUse: 'Bash', lastUserText: report, lastUserFrom: from }, true))
      .toEqual({ text: 'Running Bash…', tone: 'running' });
    expect(sessionLine({ status: 'AWAITING_INPUT', pendingApprovals: 1, lastUserText: report, lastUserFrom: from }, true))
      .toEqual({ text: 'Waiting for approval', tone: 'approval' });
    expect(sessionLine({ status: 'AWAITING_INPUT', lastAssistantText: 'On it.', lastUserFrom: from }, true))
      .toEqual({ text: 'On it.', tone: 'preview' });
  });
});

/**
 * A message Orbit wrote itself (`lastUserFromOrbit`, docs/session-list-projects-design.md §3.5, owner
 * 2026-11-07): the row says Orbit, never "You". A coordinator's notification says the sentence its line
 * in the conversation says (`coordinatorDeliverySentence`); any other message of Orbit's says its first
 * line. Kept in step with OrbitKit's `SessionLineOrbitTests` and Android's `SessionLineOrbitTest`.
 */
describe('sessionLine says Orbit for the message Orbit wrote', () => {
  const evidence: CoordinatorDeliveryCard = {
    kind: 'EVIDENCE_SUBMITTED',
    task: { id: 'task-1', title: 'Write Orbit on the row' },
    revision: 2,
    count: null,
    deliveredAt: '2026-11-07T07:30:00.000Z',
    toCoordinator: true,
  };
  const notification = 'From Orbit · project “Rows” has a revision of completion evidence for you to decide\n\nTask “Write Orbit on the row” …';
  const wake = 'Orbit Watch w-1 matched at generation 2: **CI** finished\n\nThis turn was queued by the watch, not typed by a person.';

  it('says a notification’s own sentence, while the turn runs, after it stopped and in Trash', () => {
    expect(SENT_BY_ORBIT).toBe('Orbit');
    const told = { lastUserText: notification, lastUserFromOrbit: { coordinatorDelivery: evidence } };
    const line = { text: 'Orbit: Evidence revision 2 submitted: Write Orbit on the row', tone: 'preview' };
    expect(sessionLine({ status: 'RUNNING', lastAssistantText: 'previous reply', ...told }, true)).toEqual(line);
    expect(sessionLine({ status: 'AWAITING_INPUT', lastAssistantText: 'previous reply', ...told }, true)).toEqual(line);
    expect(sessionLine({ status: 'INTERRUPTED', ...told }, true)).toEqual(line);
    expect(sessionLine({ status: 'FAILED', ...told }, false)).toEqual(line);
  });

  it('says every kind of notification as its line in the conversation says it', () => {
    const cards: CoordinatorDeliveryCard[] = COORDINATOR_DELIVERY_KINDS.map((kind) => ({
      kind,
      task: { id: 'task-1', title: 'Build the package' },
      revision: 3,
      count: 2,
      deliveredAt: '2026-11-07T07:30:00.000Z',
      toCoordinator: kind !== 'CRITERIA_REJECTED',
    }));
    for (const card of cards) {
      expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: notification, lastUserFromOrbit: { coordinatorDelivery: card } }, true))
        .toEqual({ text: `Orbit: ${coordinatorDeliverySentence(card)}`, tone: 'preview' });
    }
    // Spelled out for three of them, so a sentence that changed is read here as well as in the conversation.
    const said = (card: Partial<CoordinatorDeliveryCard>) => sessionLine({
      status: 'AWAITING_INPUT', lastUserText: notification, lastUserFromOrbit: { coordinatorDelivery: { ...evidence, ...card } },
    }, true).text;
    expect(said({ kind: 'CRITERION_UNLANDED', task: null, revision: null, count: 2 })).toBe('Orbit: Work not on main yet: 2 tasks');
    expect(said({ kind: 'ACCEPTANCE_LANDED_DONE', task: null, revision: null, count: 1 })).toBe('Orbit: The only criterion landed, recorded Done');
    expect(said({ kind: 'CRITERIA_APPROVED', task: null, revision: null })).toBe('Orbit: Criteria proposal approved');
  });

  it('says the first line of any other message of Orbit’s, flattened like a preview', () => {
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: wake, lastUserFromOrbit: { coordinatorDelivery: null } }, true))
      .toEqual({ text: 'Orbit: Orbit Watch w-1 matched at generation 2: CI finished', tone: 'preview' });
    // Blank lines before it are not its first line.
    expect(sessionLine({ status: 'RUNNING', lastUserText: '\n  \nStart the task “Write Orbit on the row”.\n\nTask details:', lastUserFromOrbit: { coordinatorDelivery: null } }, true).text)
      .toBe('Orbit: Start the task “Write Orbit on the row”.');
    // A card this build cannot read is no card: the message's first line, and still Orbit's.
    for (const coordinatorDelivery of [{ kind: 'A_KIND_FROM_A_LATER_SERVER', deliveredAt: '2026-11-07T07:30:00.000Z' }, { ...evidence, revision: null }, 'evidence']) {
      expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: notification, lastUserFromOrbit: { coordinatorDelivery } }, true).text)
        .toBe('Orbit: From Orbit · project “Rows” has a revision of completion evidence for you to decide');
    }
  });

  it('says You only for the owner’s words, and names another session, as before', () => {
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'ship it', lastUserFrom: null, lastUserFromOrbit: null }, true).text)
      .toBe('You: ship it');
    // An older server sends no mark at all: every message reads as it did.
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: notification }, true).text)
      .toBe('You: From Orbit · project “Rows” has a revision of completion evidence for you to decide Task “Write Orbit on the row” …');
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'ship it', lastUserFrom: { sessionId: 'session-1', title: 'Build the package' }, lastUserFromOrbit: null }, true).text)
      .toBe('Build the package: ship it');
    // A mark that is not an object is none.
    expect(sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'ship it', lastUserFromOrbit: 'Orbit' }, true).text).toBe('You: ship it');
  });

  // The four senders one row can name, each as the server writes it (at most one of the three marks set):
  // another session, Orbit, a Feishu group member (docs/feishu-bot-design.md §8.2), and the owner.
  it('names each of the four senders, as the server marks them', () => {
    const row = (marks: Record<string, unknown>) =>
      sessionLine({ status: 'AWAITING_INPUT', lastUserText: 'ship it', lastUserFrom: null, lastUserFromOrbit: null, lastUserFromExternal: null, ...marks }, true).text;
    expect(row({ lastUserFrom: { sessionId: 'session-1', title: 'Build the package' } })).toBe('Build the package: ship it');
    expect(row({ lastUserFromOrbit: { coordinatorDelivery: null } })).toBe('Orbit: ship it');
    expect(row({ lastUserFromExternal: { source: 'FEISHU', name: 'Lin Mei' } })).toBe('From Feishu · Lin Mei: ship it');
    expect(row({})).toBe('You: ship it');
  });

  it('changes nothing above the message, and a mark with no message makes no line', () => {
    const told = { lastUserText: notification, lastUserFromOrbit: { coordinatorDelivery: evidence } };
    expect(sessionLine({ status: 'RUNNING', lastToolUse: 'Bash', ...told }, true)).toEqual({ text: 'Running Bash…', tone: 'running' });
    expect(sessionLine({ status: 'AWAITING_INPUT', pendingApprovals: 1, ...told }, true))
      .toEqual({ text: 'Waiting for approval', tone: 'approval' });
    expect(sessionLine({ status: 'AWAITING_INPUT', lastAssistantText: 'On it.', lastUserFromOrbit: { coordinatorDelivery: evidence } }, true))
      .toEqual({ text: 'On it.', tone: 'preview' });
  });
});

/**
 * The row for a session that holds a slot but whose engine is not up yet. Measured on this
 * deployment it is ~3.3s of every start (against ~50ms actually queued), and it used to render as
 * the message echoed back under a working spinner — which reads as "the agent has your prompt".
 */
describe('sessionLine while the engine is starting', () => {
  it('says it is starting rather than echoing the prompt back', () => {
    expect(
      sessionLine(
        { status: 'RUNNING', engineStartedAt: null, lastUserText: 'ship it' },
        true,
      ),
    ).toEqual({ text: 'Starting…', tone: 'running' });
  });

  it('goes back to the ordinary live line once the engine has spoken', () => {
    expect(
      sessionLine(
        {
          status: 'RUNNING',
          engineStartedAt: '2026-08-24T17:07:37.170Z',
          lastToolUse: 'Read',
        },
        true,
      ),
    ).toEqual({ text: 'Running Read…', tone: 'running' });
  });

  // The rolling-upgrade case: a control plane that never sends the field must not park every
  // running session under a startup label. Absent is not null.
  it('keeps the old behaviour for a payload that never carried the field', () => {
    expect(sessionLine({ status: 'RUNNING' }, true)).toEqual({
      text: 'Running…',
      tone: 'running',
    });
  });

  // The row the phase column exists for. Both of these are RUNNING with a null engineStartedAt —
  // one is six seconds into a cold start, the other has been compacting for four minutes — and
  // until the runner named the phase the list called them the same thing, so there was no way to
  // tell from here which session was worth opening.
  it('names the phase the runner reported, so a compaction is not just another start', () => {
    expect(
      sessionLine({ status: 'RUNNING', engineStartedAt: null, enginePhase: 'compacting' }, true),
    ).toEqual({ text: 'Compacting…', tone: 'running' });
  });

  // A phase this client cannot explain falls back rather than printing a word nobody can read:
  // runners self-update on their own schedule and outlive a release.
  it('falls back to the generic line for a phase it does not know', () => {
    expect(
      sessionLine({ status: 'RUNNING', engineStartedAt: null, enginePhase: 'reticulating' }, true),
    ).toEqual({ text: 'Starting…', tone: 'running' });
  });

  // Starting is a refinement of RUNNING; a queued session has no engine to be starting. The row
  // carries `queuedReason: null` because that is what a current server sends for an ungated
  // queued session — omitting it here would exercise the old-server fallback instead.
  it('does not pre-empt the queued line', () => {
    expect(
      sessionLine({ status: 'PENDING', engineStartedAt: null, queuedReason: null }, true),
    ).toEqual({ text: 'Queued', tone: 'queued' });
  });
});

describe('sessionLine names the gate holding a queued session', () => {
  it('says the runner is offline instead of blaming a slot', () => {
    expect(sessionLine({ status: 'PENDING', queuedReason: 'runner_offline' }, true)).toEqual({
      text: 'Runner offline',
      tone: 'queued',
    });
  });

  it('keeps slot wording when a slot really is what is missing', () => {
    expect(
      sessionLine({ status: 'PENDING', queuedReason: 'runner_at_capacity' }, true),
    ).toEqual({ text: 'Waiting for slot', tone: 'queued' });
  });
});

/**
 * The console header over a session a watch will bring back. The word comes from the watches
 * themselves (lib/watches `watchingWord`); what is asserted here is where the header puts it — the
 * same place `SessionHeader.statusWord` puts it on macOS, which is what made the two disagree while
 * the browser had no branch for it at all.
 */
describe('statusLabel over a session parked on a watch', () => {
  const parked = { status: 'AWAITING_INPUT', engineTurnActive: false, pendingApprovals: 0 };

  it('says what the wait is for instead of asking the reader for a reply', () => {
    expect(statusLabel(parked)).toBe('Waiting for your reply');
    expect(statusLabel(parked, 'Watching 7 targets')).toBe('Watching 7 targets');
  });

  it("keeps a background process out of the watch's words, and the watch out of the tray's", () => {
    // A shell left up is not what the session is waiting on: the wake is.
    expect(statusLabel({ ...parked, runningBgCount: 1 })).toBe('Background process running');
    expect(statusLabel({ ...parked, runningBgCount: 1 }, 'Watching 1 target')).toBe('Watching 1 target');
  });

  it('never hides work of its own or a question for the reader behind the wait', () => {
    // A sub-workspace is this workspace still working; a self-driven turn and an approval outrank
    // the wait for the same reason they outrank everything else the word could say.
    expect(statusLabel({ ...parked, runningSubagentCount: 1 }, 'Watching 1 target')).toBe('Running Agent');
    expect(statusLabel({ ...parked, engineTurnActive: true }, 'Watching 1 target')).toBe('Running');
    expect(statusLabel({ ...parked, pendingApprovals: 1 }, 'Watching 1 target')).toBe('Waiting for approval');
    // And it says nothing of a watch about a session that is not parked at all.
    expect(statusLabel({ status: 'RUNNING' }, 'Watching 1 target')).toBe('Running');
  });
});

/**
 * The same wait on the session list, where the screenshot found it: the row read the parked session
 * as a reply preview under a "Waiting for your reply" glyph while its header and strip said Watching.
 * The line is the strip's own (lib/watches `watchingSessions`); what is asserted here is where the
 * row puts it — the place macOS's `SessionLine` puts it — and what still outranks it.
 */
describe('sessionLine over a session parked on a watch', () => {
  const parked = {
    status: 'AWAITING_INPUT',
    engineTurnActive: false,
    pendingApprovals: 0,
    lastAssistantText: 'Nothing for you to do until it lands.',
  };
  const watching = { word: 'Watching 1 target', line: 'Watching Fix the login redirect' };

  it('says what the wait is for instead of the last reply', () => {
    expect(sessionLine(parked, true)).toEqual({ text: 'Nothing for you to do until it lands.', tone: 'preview' });
    expect(sessionLine(parked, true, watching)).toEqual({ text: 'Watching Fix the login redirect', tone: 'watching' });
    // Nothing was handed over (the search palette's rows): the reading it always had.
    expect(sessionLine(parked, true, null)).toEqual({ text: 'Nothing for you to do until it lands.', tone: 'preview' });
  });

  it("keeps a background process out of the watch's line", () => {
    expect(sessionLine({ ...parked, runningBgCount: 1 }, true)).toEqual({
      text: 'Background process running…',
      tone: 'background',
    });
    expect(sessionLine({ ...parked, runningBgCount: 1 }, true, watching)).toEqual({
      text: 'Watching Fix the login redirect',
      tone: 'watching',
    });
  });

  it('never hides work of its own or a question for the reader behind the wait', () => {
    expect(sessionLine({ ...parked, runningSubagentCount: 1 }, true, watching)).toEqual({
      text: 'Running Agent…',
      tone: 'running',
    });
    expect(sessionLine({ ...parked, engineTurnActive: true, lastToolUse: 'Bash' }, true, watching)).toEqual({
      text: 'Running Bash…',
      tone: 'running',
    });
    expect(sessionLine({ ...parked, pendingApprovals: 1 }, true, watching)).toEqual({
      text: 'Waiting for approval',
      tone: 'approval',
    });
    // Woken: the run has the line, whatever the list's copy of the watches still says.
    expect(sessionLine({ status: 'RUNNING', lastToolUse: 'Bash' }, true, watching)).toEqual({
      text: 'Running Bash…',
      tone: 'running',
    });
  });

  it('stays a static preview in Trash', () => {
    expect(sessionLine(parked, false, watching)).toEqual({ text: 'Nothing for you to do until it lands.', tone: 'preview' });
  });
});

/**
 * The rolling recap (Session.recapText, 0418): the sentence the server wrote about the session
 * takes the place of the raw last reply the row used to flatten — and only that place. A session
 * still working, still waiting on you, or holding a message you just sent keeps its own line.
 * The whole line is the sentence (the owner, 2026-10-22): when it was written is the Recap card's
 * to say, at the conversation's end (SessionRecapCard.test).
 */
describe('sessionLine over a session with a recap', () => {
  const written = new Date();
  const recapText = 'Moved the recap onto the list row; the three states are covered by tests.';
  const parked = {
    status: 'AWAITING_INPUT',
    engineTurnActive: false,
    pendingApprovals: 0,
    recapText,
    recapAt: written.toISOString(),
    lastAssistantText: 'Committed the row change.',
  };

  it('shows the recap, and nothing but the recap, in place of the last reply', () => {
    expect(sessionLine(parked, true)).toEqual({ text: recapText, tone: 'preview' });
  });

  it('reads the same whether the recap was written today, on another day or at no stated time', () => {
    const old = new Date(2026, 7, 6, 17, 38);
    expect(sessionLine({ ...parked, recapAt: old.toISOString() }, true)).toEqual({ text: recapText, tone: 'preview' });
    expect(sessionLine({ ...parked, recapAt: null }, true)).toEqual({ text: recapText, tone: 'preview' });
  });

  it('falls back to the reply when there is no recap', () => {
    expect(sessionLine({ ...parked, recapText: null }, true)).toEqual({
      text: 'Committed the row change.',
      tone: 'preview',
    });
    // Blank is not a line: the server never stores one, and drawing it would leave an empty
    // label over nothing.
    expect(sessionLine({ ...parked, recapText: '   ' }, true)).toEqual({
      text: 'Committed the row change.',
      tone: 'preview',
    });
  });

  // The account's Session recaps switch (Settings): off, the same row falls through to the reply
  // it showed before the recap existed. The third argument is this session as an observer.
  it('falls back to the reply when the account turned recaps off', () => {
    expect(sessionLine(parked, true, null, false)).toEqual({
      text: 'Committed the row change.',
      tone: 'preview',
    });
  });

  it('keeps its line in Trash, where no live state is left to outrank it', () => {
    expect(sessionLine(parked, false)).toEqual({ text: recapText, tone: 'preview' });
  });

  it('never hides work that is still happening behind it', () => {
    // Working: the tool in flight is what the row is about.
    expect(
      sessionLine(
        { ...parked, status: 'RUNNING', engineStartedAt: '2026-10-02T05:00:00Z', lastToolUse: 'Bash' },
        true,
      ),
    ).toEqual({ text: 'Running Bash…', tone: 'running' });

    // Waiting on you, a background process the session left up, a watch that will resume it, and
    // the message you sent that has no answer yet — each is newer than the recap.
    expect(sessionLine({ ...parked, pendingApprovals: 1 }, true)).toEqual({
      text: 'Waiting for approval',
      tone: 'approval',
    });
    expect(sessionLine({ ...parked, runningBgCount: 1 }, true)).toEqual({
      text: 'Background process running…',
      tone: 'background',
    });
    expect(
      sessionLine(parked, true, { word: 'Watching 1 target', line: 'Watching Fix the login redirect' }),
    ).toEqual({ text: 'Watching Fix the login redirect', tone: 'watching' });
    expect(sessionLine({ ...parked, lastUserText: 'and now the footer?' }, true)).toEqual({
      text: 'You: and now the footer?',
      tone: 'preview',
    });
  });
});

/** The row's marks beside its time (docs/session-guests-design.md §3): two people when anyone invited can reply. */
describe('the guests mark on a session row', () => {
  it('draws two people beside the time when the row has guests, and nothing when it has none', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { SessionTitleRow, SESSION_GUESTS_TIP } = await import('./WorkspaceView');
    const row = (s: Record<string, unknown>) =>
      renderToStaticMarkup(<SessionTitleRow session={{ title: 'Retry budget for flaky pg specs', lastTurnAt: new Date().toISOString(), ...s }} />);
    const shown = row({ hasGuests: true, shared: true });
    expect(shown).toContain(`<span class="session-guests" title="${SESSION_GUESTS_TIP}" aria-label="${SESSION_GUESTS_TIP}">`);
    // Beside the globe, both before the time.
    expect(shown.indexOf('session-shared')).toBeLessThan(shown.indexOf('session-guests'));
    expect(shown.indexOf('session-guests')).toBeLessThan(shown.indexOf('session-time'));
    expect(row({ hasGuests: false })).not.toContain('session-guests');
    expect(row({})).not.toContain('session-guests');
  });
});
