import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueuedTurnMeta } from './WorkspaceView';
import { isSteerKind } from '../lib/steerDelivery';

/**
 * The queued tail is where the two kinds of mid-turn message are told apart before either has a
 * transcript row of its own, and it is the only place the withdraw is offered. Which kind a
 * message is was decided by the server under the Session row lock and travels as `kind` — on the
 * POST /turns answer and on every GET /sessions/:id/turns after it — so these check the rendered
 * markup against that field alone, never against what the tab believed the session was doing.
 *
 * The codex case is what makes this worth pinning: codex reaches an engine over JSON-RPC rather
 * than an open stdin, so before `turn/steer` a mid-turn message there was always queued. Now it
 * can be either, and the same row has to read one way or the other purely from what came back.
 */
describe('the queued tail tells a steer from a queued message', () => {
  const render = (kind: string | undefined) =>
    renderToStaticMarkup(<QueuedTurnMeta steer={isSteerKind(kind)} onCancel={() => {}} />);

  it('offers Cancel on a message that is still waiting for its own turn', () => {
    const html = render('message');

    expect(html).toContain('Queued');
    expect(html).toContain('Cancel');
  });

  it('shows a steer as already on its way, and offers no Cancel', () => {
    // The server refuses to withdraw one — the engine may be reading it as we ask — so a Cancel
    // here would be a button that always fails (see cancel-queued-turn / steer-queue-visibility).
    const html = render('steer');

    expect(html).toContain('Sending…');
    expect(html).not.toContain('Cancel');
    expect(html).not.toContain('Queued');
  });

  it('re-files a steer as a withdrawable message when the server takes it back', () => {
    // A codex steer the engine provably never read is un-filed onto the same row — same seq,
    // same clientTurnId — and comes back as the ordinary message it would have been had it been
    // sent a moment later (contract §4.7, `steer_requeue`). Nothing is published for that, so
    // the queued list IS the announcement: the row reappears with kind `message`, and the
    // withdraw has to come back with it or the message is stuck being un-cancellable forever.
    expect(render('steer')).not.toContain('Cancel');
    expect(render('message')).toContain('Cancel');
  });

  it('reads a server that says nothing about the kind as the queued message it used to be', () => {
    // A runner/apiserver from before steer existed omits `kind`. Reading absent as "steer" would
    // drop the withdraw from a message that really can be withdrawn.
    const html = render(undefined);

    expect(html).toContain('Queued');
    expect(html).toContain('Cancel');
  });
});
