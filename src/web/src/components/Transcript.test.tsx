import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  AutoRetryCtx,
  type AutoRetryHelp,
  AuthErrorCtx,
  ExportCtx,
  LiveToolOutputsCtx,
  MD,
  type RunEvent,
  Transcript,
  UndeliveredCtx,
} from './Transcript';
import { encodeId } from '../lib/idCodec';
import { transcriptEventsWithDurableDeliveryReceipts } from '../lib/acceptedUserTurn';

const LIST_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const LIST_B62 = encodeId(LIST_UUID);

const AUTH_FAILED =
  'Failed to authenticate: Codex is installed on this runner but not signed in — sign in from here, or run `codex login` on that machine.';

const errorEvent = (seq: number, message: string): RunEvent => ({
  seq,
  type: 'error',
  payload: { message },
});

const cards = (html: string) => html.split('chat-authfix"').length - 1;

describe('transcript sign-in cards', () => {
  it('folds a re-reported sign-in failure into the card already there', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[errorEvent(1, AUTH_FAILED), errorEvent(2, AUTH_FAILED)]} />,
    );

    expect(cards(html)).toBe(1);
  });

  it('keeps a card per failure when the runner reports different ones', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          errorEvent(1, AUTH_FAILED),
          errorEvent(2, 'Failed to authenticate: OAuth session expired and could not be refreshed'),
        ]}
      />,
    );

    expect(cards(html)).toBe(2);
  });

  it('shows the message the retry would re-send', () => {
    const html = renderToStaticMarkup(
      <AuthErrorCtx.Provider
        value={{ provider: 'codex', onRetry: () => {}, retryText: 'ship the thing' }}
      >
        <Transcript events={[errorEvent(1, AUTH_FAILED)]} />
      </AuthErrorCtx.Provider>,
    );

    expect(html).toContain('ship the thing');
    expect(html).toContain('Retry — re-send my last message');
  });
});

// A provider that briefly cannot answer is a pause, not an error to act on: the transcript owes
// the reader a pending retry, not a red line they have to do something about. The distinction is
// made on the error text alone, so the two halves are tested together.
describe('transient provider error card', () => {
  const OVERLOADED =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  const TOO_LONG =
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
    '"message":"prompt is too long: 234523 tokens > 200000 maximum"}}';

  const render = (text: string, help?: AutoRetryHelp) =>
    renderToStaticMarkup(
      <AutoRetryCtx.Provider value={help ?? null}>
        <Transcript events={[{ seq: 1, type: 'assistant', payload: { text } }]} />
      </AutoRetryCtx.Provider>,
    );

  it('turns an overloaded API into a retry card carrying the error verbatim', () => {
    const html = render(OVERLOADED);

    expect(html).toContain('chat-quota');
    expect(html).toContain('Provider unavailable');
    expect(html).toContain('overloaded_error');
    expect(html).not.toContain('chat-error');
  });

  it('turns the API key rate-limit wrapper into the same card', () => {
    const html = render(
      "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
    );

    expect(html).toContain('chat-quota');
    expect(html).toContain('Provider unavailable');
    expect(html).toContain('rate limit');
    expect(html).not.toContain('chat-error');
  });

  it('leaves an error a re-send would reproduce as a plain error line', () => {
    const html = render(TOO_LONG);

    expect(html).toContain('chat-error');
    expect(html).toContain('prompt is too long');
    expect(html).not.toContain('Provider unavailable');
  });

  it('counts down to the armed retry', () => {
    const html = render(OVERLOADED, {
      provider: 'claude',
      retryAt: new Date(Date.now() + 30_000).toISOString(),
      attempts: 1,
    });

    expect(html).toContain('Retrying');
    expect(html).toContain('sec');
  });

  it('says so once the attempts are spent, rather than showing a dead countdown', () => {
    const html = render(OVERLOADED, { provider: 'claude', retryAt: null, attempts: 3 });

    expect(html).toContain('Auto-retry gave up');
    expect(html).toContain('the API is still failing');
  });
});

// Which window ran out is the whole point of the card: a 5-hour quota named as the weekly one
// tells the reader to come back in days for something that returns this evening.
describe('spent quota card', () => {
  const render = (text: string) =>
    renderToStaticMarkup(
      <AutoRetryCtx.Provider value={{ provider: 'claude', runnerName: 'wikova' }}>
        <Transcript events={[{ seq: 1, type: 'assistant', payload: { text } }]} />
      </AutoRetryCtx.Provider>,
    );

  // ...and titled by its length, never by the runtime's word for it: "Session limit reached"
  // in a product whose sessions are the thing on screen reads as a limit on this session.
  it('names the rolling window the runtime actually named', () => {
    const html = render("You've hit your session limit · resets 8:20pm (Europe/Berlin)");

    expect(html).toContain('5-hour limit reached');
    expect(html).toContain('The 5-hour quota');
    expect(html).not.toContain('Session limit');
    expect(html).not.toContain('Weekly limit');
  });

  it('names the weekly window only when the runtime does', () => {
    const html = render("You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)");

    expect(html).toContain('Weekly limit reached');
  });

  // The quote of what a retry would re-send earns its space when that message has scrolled
  // away. When the bubble is the line directly above the card — the usual case, since a quota
  // is spent on the message that just went out — it is the same sentence twice, and it is the
  // tallest thing in the card.
  const LIMIT = "You've hit your session limit · resets 8:20pm (Europe/Berlin)";
  const withRetry = (events: RunEvent[]) =>
    renderToStaticMarkup(
      <AutoRetryCtx.Provider value={{ provider: 'claude', onRetry: () => {}, retryText: 'ship it' }}>
        <Transcript events={events} />
      </AutoRetryCtx.Provider>,
    );

  it('drops the quoted message when the bubble it would quote is right above', () => {
    const html = withRetry([
      { seq: 1, type: 'user', payload: { text: 'ship it' } },
      { seq: 2, type: 'assistant', payload: { text: LIMIT } },
    ]);

    expect(html).not.toContain('Will re-send');
    expect(html).toContain('Retry now');
  });

  it('quotes it when the failure landed deeper into the turn', () => {
    const html = withRetry([
      { seq: 1, type: 'user', payload: { text: 'ship it' } },
      { seq: 2, type: 'assistant', payload: { text: 'On it.' } },
      { seq: 3, type: 'assistant', payload: { text: LIMIT } },
    ]);

    expect(html).toContain('Will re-send');
  });

  // Switching auto-retry off used to unmount the row it lived in, so the click read as the card
  // breaking rather than as a setting changing. The switch stays, off, and flips back — which is
  // only offerable when the reply named a time to flip back *to*.
  const offCard = (text: string, help: Partial<AutoRetryHelp> = {}) =>
    renderToStaticMarkup(
      <AutoRetryCtx.Provider
        value={{ provider: 'claude', retryAt: null, attempts: 0, onArmAuto: () => {}, ...help }}
      >
        <Transcript events={[{ seq: 1, type: 'assistant', payload: { text } }]} />
      </AutoRetryCtx.Provider>,
    );

  it('keeps the switch on the card when auto-retry is off, in the off position', () => {
    const html = offCard(LIMIT);

    expect(html).toContain('data-on="false"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('Off — nothing will re-send until you do.');
  });

  it('offers no switch when the runtime named no time to re-arm for', () => {
    const html = offCard(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to " +
        'purchase more credits.',
    );

    expect(html).toContain('chat-quota');
    expect(html).not.toContain('class="sw"');
  });

  it('gives up rather than offering to re-arm once the attempts are spent', () => {
    const html = offCard(LIMIT, { attempts: 5 });

    expect(html).toContain('Auto-retry gave up');
    expect(html).not.toContain('class="sw"');
  });

  // The reply that surfaced this was an *answer* about a quota outage — it quoted the Codex
  // wording while explaining why a task had run 28 times. Read as the provider refusing to
  // answer, it vanished from the transcript behind a card announcing a limit nobody had hit.
  it('leaves an answer that merely quotes a quota error as the answer', () => {
    const html = render(
      'All 27 failed with the same codex error: "You\'ve hit your usage limit. Visit ' +
        'https://chatgpt.com/codex/settings/usage to purchase more credits." The weekly limit ' +
        'is not what stopped them.',
    );

    expect(html).not.toContain('chat-quota');
    expect(html).toContain('All 27 failed');
  });
});

describe('message delivery', () => {
  const userEvent = (seq: number, turnId: string, text: string, delivery?: string): RunEvent => ({
    seq,
    type: 'user',
    turnId,
    payload: delivery ? { text, delivery } : { text },
  });
  const deliveryEvent = (
    seq: number,
    turnId: string,
    delivery: string,
    reason?: string,
  ): RunEvent => ({
    seq,
    type: 'user_delivery',
    payload: { turnId, delivery, ...(reason ? { reason, retryable: true } : {}) },
  });

  it('marks a message the engine never received', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          userEvent(1, 't1', 'rename the widget', 'enqueued'),
          deliveryEvent(2, 't1', 'failed', 'claude stdin is closed'),
        ]}
      />,
    );

    expect(html).toContain('Not delivered');
    expect(html).toContain('claude stdin is closed');
  });

  it('says nothing about a message that arrived', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          userEvent(1, 't1', 'rename the widget', 'enqueued'),
          deliveryEvent(2, 't1', 'written'),
          deliveryEvent(3, 't1', 'acknowledged'),
        ]}
      />,
    );

    expect(html).not.toContain('Not delivered');
  });

  it('shows a re-filed message once, in the place it was typed', () => {
    // A steer the engine provably never read is handed back and runs as an ordinary turn: the
    // same row, the same turn id, delivered a second time. Two bubbles would show what the
    // person sent twice and leave the first one looking like it failed.
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          { seq: 1, type: 'user', turnId: 't1', payload: { text: 'adjust this', delivery: 'enqueued', steer: true } },
          deliveryEvent(2, 't1', 'written'),
          deliveryEvent(3, 't1', 'requeued'),
          userEvent(4, 't1', 'adjust this', 'enqueued'),
        ]}
      />,
    );

    expect(html.split('adjust this').length - 1).toBe(1);
    // And it stops narrating a delivery it is no longer having: it is an ordinary queued
    // message now, and an ordinary message's bubble says nothing about how it got there.
    expect(html).not.toContain('Queued for next turn instead');
    expect(html).not.toContain('Not delivered');
  });

  it('says a re-filed message is coming back before its delivery lands', () => {
    // The window between the two: the bubble is open, the engine is not going to read it, and
    // the turn that will is not here yet. Silence would read exactly like a dropped message.
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          { seq: 1, type: 'user', turnId: 't1', payload: { text: 'adjust this', delivery: 'enqueued', steer: true } },
          deliveryEvent(2, 't1', 'requeued'),
        ]}
      />,
    );

    expect(html).toContain('Queued for next turn instead');
    expect(html).not.toContain('Not delivered');
  });

  it('marks only the message that failed, not the one before it', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          userEvent(1, 't1', 'first', 'enqueued'),
          deliveryEvent(2, 't1', 'acknowledged'),
          userEvent(3, 't2', 'second', 'enqueued'),
          deliveryEvent(4, 't2', 'failed', 'claude process has exited'),
        ]}
      />,
    );

    expect(html.split('chat-undelivered').length - 1).toBe(1);
    expect(html.indexOf('second')).toBeLessThan(html.indexOf('Not delivered'));
  });

  it('keeps a server-only terminal receipt on its original USER before newer turns', () => {
    const events = transcriptEventsWithDurableDeliveryReceipts(
      [
        userEvent(1, 't-current', 'original adjustment', 'written'),
        userEvent(2, 't-b', 'newer B'),
        userEvent(3, 't-c', 'newer C'),
      ],
      [{
        turnId: 't-current',
        placement: 'steer',
        delivery: 'unconfirmed',
        deliveryReason: 'runner disappeared before acknowledgement',
      }],
    );
    const html = renderToStaticMarkup(<Transcript events={events} />);

    expect(html.split('original adjustment').length - 1).toBe(1);
    expect(html.split('Delivery could not be confirmed').length - 1).toBe(1);
    expect(html.indexOf('original adjustment')).toBeLessThan(
      html.indexOf('Delivery could not be confirmed'),
    );
    expect(html.indexOf('Delivery could not be confirmed')).toBeLessThan(html.indexOf('newer B'));
    expect(html.indexOf('newer B')).toBeLessThan(html.indexOf('newer C'));
    expect(html).not.toContain('Put back in the composer');
  });

  it('leaves a transcript recorded before delivery was reported alone', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[userEvent(1, 't1', 'rename the widget')]} />,
    );

    expect(html).not.toContain('chat-undelivered');
    expect(html).toContain('rename the widget');
  });
});

describe('a message steered into the running turn', () => {
  // The events the runner publishes for a steer: its own `user` event (filed against its own
  // turn, carrying the kind and the first delivery state), then one `user_delivery` per
  // transition. Rebuilding the bubble from these alone is exactly what a reload does.
  const steerEvent = (seq: number, turnId: string, text: string, delivery = 'enqueued'): RunEvent => ({
    seq,
    type: 'user',
    turnId,
    payload: { text, delivery, steer: true },
  });
  const messageEvent = (seq: number, turnId: string, text: string): RunEvent => ({
    seq,
    type: 'user',
    turnId,
    payload: { text, delivery: 'enqueued' },
  });
  const deliveryEvent = (seq: number, turnId: string, delivery: string, reason?: string): RunEvent => ({
    seq,
    type: 'user_delivery',
    payload: { turnId, delivery, ...(reason ? { reason, retryable: true } : {}) },
  });

  it('shows it on its way while the engine has not taken it yet', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[steerEvent(1, 't1', 'use the other endpoint')]} />,
    );

    expect(html).toContain('Sending…');
    expect(html).not.toContain('Sent into this turn');
  });

  it('moves to delivering once its bytes are in the engine', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[steerEvent(1, 't1', 'use the other endpoint'), deliveryEvent(2, 't1', 'written')]}
      />,
    );

    expect(html).toContain('Delivering…');
    expect(html).not.toContain('Sending…');
  });

  it('says it landed only once the engine echoed it back', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          steerEvent(1, 't1', 'use the other endpoint'),
          deliveryEvent(2, 't1', 'written'),
          deliveryEvent(3, 't1', 'acknowledged'),
        ]}
      />,
    );

    expect(html).toContain('Sent into this turn');
    expect(html).not.toContain('Delivering…');
  });

  it('replaces the progress with the failure, not both', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          steerEvent(1, 't1', 'use the other endpoint'),
          deliveryEvent(2, 't1', 'failed', 'no turn is running'),
        ]}
      />,
    );

    expect(html).toContain('Not delivered');
    expect(html).toContain('no turn is running');
    expect(html).not.toContain('Sending…');
    expect(html).not.toContain('chat-steer-state');
  });

  it('restores the whole state from the durable events alone', () => {
    // What a refresh or a reconnect replays. Nothing here comes from the send that made it:
    // the local bubble is long gone, and the state has to survive in the transcript itself.
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          messageEvent(1, 't0', 'refactor the parser'),
          steerEvent(2, 't1', 'use the other endpoint'),
          deliveryEvent(3, 't1', 'acknowledged'),
        ]}
      />,
    );

    expect(html).toContain('use the other endpoint');
    expect(html).toContain('Sent into this turn');
    // …and says nothing about the ordinary message it was steering, whose own reply reports it.
    expect(html.split('chat-steer-state').length - 1).toBe(1);
  });

  it('narrates nothing for an ordinary message', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          messageEvent(1, 't1', 'refactor the parser'),
          deliveryEvent(2, 't1', 'written'),
          deliveryEvent(3, 't1', 'acknowledged'),
        ]}
      />,
    );

    expect(html).not.toContain('chat-steer-state');
    expect(html).not.toContain('Sent into this turn');
  });

  it('offers an undelivered message back to the composer', () => {
    const html = renderToStaticMarkup(
      <UndeliveredCtx.Provider value={() => {}}>
        <Transcript
          events={[
            steerEvent(1, 't1', 'use the other endpoint'),
            deliveryEvent(2, 't1', 'failed', 'claude stdin is closed'),
          ]}
        />
      </UndeliveredCtx.Provider>,
    );

    expect(html).toContain('Put back in the composer');
  });

  it('offers nothing where the reader could not send it anyway', () => {
    // The shared/public page and the static export leave the context null.
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          steerEvent(1, 't1', 'use the other endpoint'),
          deliveryEvent(2, 't1', 'failed', 'claude stdin is closed'),
        ]}
      />,
    );

    expect(html).toContain('Not delivered');
    expect(html).not.toContain('Put back in the composer');
  });
});

/**
 * The same steer, delivered by codex instead of claude.
 *
 * Nothing about the bubble changes — one vocabulary, both engines (`lib/steerDelivery`) — but the
 * ORDER the events arrive in does. claude's runner opens the bubble the moment it accepts the
 * message, so it always starts at `enqueued` and walks forward. codex cannot: its steer is an RPC
 * whose answer and whose echo are read by different goroutines, and re-filing a message the
 * engine provably never read must leave no bubble behind at all (contract §4.7). So the `user`
 * event is held back until the FIRST KNOWN OUTCOME, and a codex steer's bubble is born at
 * whatever that outcome turned out to be — including, for a message that never landed, at the
 * failure itself.
 */
describe('a codex steer, whose bubble opens at whatever happened first', () => {
  const steerEvent = (seq: number, turnId: string, text: string, delivery: string): RunEvent => ({
    seq,
    type: 'user',
    turnId,
    payload: { text, delivery, steer: true },
  });
  const deliveryEvent = (seq: number, turnId: string, delivery: string, reason?: string): RunEvent => ({
    seq,
    type: 'user_delivery',
    payload: { turnId, delivery, ...(reason ? { reason, retryable: true } : {}) },
  });

  it('opens straight at delivering when codex took it before anything was said', () => {
    // `turn/steer` returned OK: codex has the message and the model has not read it yet. There
    // was never an `enqueued` event for this one, and the bubble still has to read correctly.
    const html = renderToStaticMarkup(
      <Transcript events={[steerEvent(1, 't1', 'use the other endpoint', 'written')]} />,
    );

    expect(html).toContain('Delivering…');
    expect(html).not.toContain('Sending…');
  });

  it('stays on delivering however long codex holds it before the model reads it', () => {
    // Measured at 31 seconds against codex 0.149.0 (contract §4.6): codex buffers a steer until
    // its next model request. Saying anything else for that stretch — "sent", or a failure —
    // would be reporting something that has not happened.
    const html = renderToStaticMarkup(
      <Transcript
        events={[steerEvent(1, 't1', 'use the other endpoint', 'written')]}
      />,
    );

    expect(html).toContain('Delivering…');
    expect(html).not.toContain('Sent into this turn');
    expect(html).not.toContain('Not delivered');
  });

  it('opens straight at sent when the echo beat the answer to the request', () => {
    // codex has been seen echoing a steer back before the response to it was observed, so
    // `acknowledged` can be the first word anyone says about the message.
    const html = renderToStaticMarkup(
      <Transcript events={[steerEvent(1, 't1', 'use the other endpoint', 'acknowledged')]} />,
    );

    expect(html).toContain('Sent into this turn');
    expect(html).not.toContain('Sending…');
    expect(html).not.toContain('Delivering…');
  });

  it('opens as the failure it is when codex never took it', () => {
    // The refusals that never get as far as a record on the running turn — no active turn, a
    // turn that ended under it, a runner killed while holding it (§4.8) — carry the failure on
    // the `user` event itself. Without that the sender watches a bubble wait for nothing.
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          steerEvent(1, 't1', 'use the other endpoint', 'failed'),
          deliveryEvent(2, 't1', 'failed',
            'the runner stopped while this message was on its way into the running turn'),
        ]}
      />,
    );

    expect(html).toContain('Not delivered');
    expect(html).toContain('chat-undelivered');
    expect(html).not.toContain('Sending…');
    expect(html).not.toContain('chat-steer-state');
  });

  it('shows a re-filed steer once, as the ordinary message it became', () => {
    // A steer codex provably never read is un-filed back onto the same row and runs as the next
    // ordinary message (§4.7). That path publishes NOTHING — no `user`, no `user_delivery` —
    // precisely so the delivery that eventually runs the row writes the one bubble the message
    // ever gets. Two bubbles here, one of them stuck at "Sending…" forever, is what that buys.
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          { seq: 1, type: 'user', turnId: 't1', payload: { text: 'use the other endpoint', delivery: 'enqueued' } },
          deliveryEvent(2, 't1', 'acknowledged'),
        ]}
      />,
    );

    expect(html.split('use the other endpoint').length - 1).toBe(1);
    expect(html).not.toContain('chat-steer-state');
    expect(html).not.toContain('Sending…');
  });
});

describe('engine stderr', () => {
  const stderrEvent = (seq: number, stderr: string): RunEvent => ({
    seq,
    type: 'system',
    payload: { stderr },
  });

  // Claude Code prints this whenever an auth token is in its environment — i.e. on every
  // session of every configured provider, whose API key Orbit injects that way.
  it('drops the connectors notice Orbit’s own env injection provokes', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(
            1,
            '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth ' +
              'source is set and takes precedence over your claude.ai login · Unset it to load ' +
              "your organization's connectors\n",
          ),
        ]}
      />,
    );

    expect(html).not.toContain('connectors are disabled');
    expect(html).not.toContain('chat-error');
  });

  // And this once per request it issues — the provider's model id is not in the CLI's built-in
  // table — including the internal request that names its own resume entry. Six DeepSeek sessions
  // here carry a red row per turn from it.
  it('drops the unrecognized-model notice the provider’s model id provokes', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(1, '[claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}\n'),
          stderrEvent(
            2,
            '[claude-code:unrecognized_model] ' +
              '{"model":"deepseek-v4-pro","query_source":"generate_session_title"}\n',
          ),
        ]}
      />,
    );

    expect(html).not.toContain('unrecognized_model');
    expect(html).not.toContain('chat-error');
  });

  it('still shows stderr that explains why a runtime failed', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[stderrEvent(1, 'No conversation found with session ID: abc\n')]} />,
    );

    expect(html).toContain('No conversation found with session ID: abc');
  });

  // codex colours its stderr with tracing's ANSI layer. The ESC byte is invisible in HTML, so
  // an unstripped line reads as "[2m…[0m [31mERROR[0m" — every log line wrapped in garbage.
  const codexLine = (ts: string, message: string) =>
    `\x1b[2m${ts}\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2mcodex_core::util\x1b[0m\x1b[2m:\x1b[0m ${message}\n`;
  const MISSING_OUTPUT = 'Custom tool call output is missing for call id: call_5zNG2';

  it('strips the ANSI colouring off an engine’s log line', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT))]} />,
    );

    expect(html).toContain(MISSING_OUTPUT);
    expect(html).not.toContain('[31m');
    expect(html).not.toContain('[0m');
  });

  // The stamp, level and module are ~60 characters of the engine's own bookkeeping in front of
  // the sentence a person is meant to read. The row leads with the sentence; the raw line stays
  // reachable in the tooltip, and the level it was logged at drives the row's tone instead of
  // every engine log line reading as a failed turn.
  it('leads with the message and keeps the log preamble in the tooltip', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT))]} />,
    );

    expect(html).toContain(`>${MISSING_OUTPUT}<`);
    expect(html).toContain('data-level="ERROR"');
    expect(html).toContain('title="2026-08-12T15:31:40.112363Z ERROR codex_core::util:');
  });

  it('carries a warning at its own level rather than as an error', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[stderrEvent(1, '2026-08-14T14:31:13.780609Z WARN codex_app_server: sandbox is degraded\n')]}
      />,
    );

    expect(html).toContain('data-level="WARN"');
    expect(html).toContain('sandbox is degraded');
  });

  // "See the sandbox prerequisites: https://…" is advice you are meant to follow.
  it('links a URL the engine logged', () => {
    const url = 'https://developers.openai.com/codex/concepts/sandboxing#prerequisites';
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(
            1,
            `2026-08-14T14:31:13.780609Z ERROR codex_app_server: Codex could not find bubblewrap on PATH. See ${url}. Codex will use the bundled bubblewrap in the meantime.\n`,
          ),
        ]}
      />,
    );

    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('in the meantime.');
  });

  // A line with no tracing preamble is the runner's own account of why the turn failed — it must
  // not be quietened along with the engines' log chatter.
  it('leaves an unprefixed runner line loud', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[stderrEvent(1, 'No conversation found with session ID: abc\n')]} />,
    );

    expect(html).not.toContain('data-level');
    expect(html).toContain('✖');
  });

  // The same complaint is re-logged on every request for the rest of the conversation — 217
  // times in the session this came from, one per turn, between the turns doing the work.
  it('folds a re-logged line into one row with a count', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT)),
          stderrEvent(2, codexLine('2026-08-12T15:32:38.753979Z', MISSING_OUTPUT)),
          stderrEvent(3, codexLine('2026-08-12T15:33:47.965544Z', MISSING_OUTPUT)),
        ]}
      />,
    );

    expect(html.split('chat-error"').length - 1).toBe(1);
    expect(html).toContain('×3');
  });

  it('keeps a row per distinct line, and shows no count for a line seen once', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT)),
          stderrEvent(2, codexLine('2026-08-12T15:32:38.753979Z', 'Codex could not find bubblewrap on PATH')),
        ]}
      />,
    );

    expect(html.split('chat-error"').length - 1).toBe(2);
    expect(html).toContain('bubblewrap');
    expect(html).not.toContain('chat-error-repeat');
  });

  // A retry loop prints the same refusal once per attempt — e.g. six identical
  // root/sudo refusals, one per respawn. Each attempt is its own error row: the fold is
  // per engine run, and a `resumed` event starts a new run.
  it('gives a re-logged line its own row after a resume (one error per retry)', () => {
    const resumed = (seq: number, attempt: number): RunEvent => ({
      seq,
      type: 'system',
      payload: { subtype: 'resumed', attempt },
    });
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          stderrEvent(1, codexLine('2026-08-12T15:31:40.112363Z', MISSING_OUTPUT)),
          resumed(2, 1),
          stderrEvent(3, codexLine('2026-08-12T15:32:38.753979Z', MISSING_OUTPUT)),
          resumed(4, 2),
          stderrEvent(5, codexLine('2026-08-12T15:33:47.965544Z', MISSING_OUTPUT)),
        ]}
      />,
    );

    expect(html.split('chat-error"').length - 1).toBe(3);
    expect(html).not.toContain('chat-error-repeat');
  });
});

describe('Orbit write tool cards', () => {
  // Once an approval is decided, this row is all that survives of it. A folded
  // `task_create_batch ✓` records that a decision happened and nothing about what was decided.
  const toolEvent = (name: string, input: unknown): RunEvent => ({
    seq: 1,
    type: 'tool_use',
    payload: { id: 't1', name, input },
  });

  it('says what a batch created and what shape it had', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Transcript
          events={[
            toolEvent('mcp__orbit__task_create_batch', {
              tasks: [
                { title: '准备分片清单', ref: 'r' },
                { title: '分片 A', ref: 'a', dependsOnRefs: ['r'] },
                { title: '分片 B', ref: 'b', dependsOnRefs: ['r'] },
              ],
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('Create tasks');
    expect(html).toContain('2 in parallel after 1');
    expect(html).not.toContain('mcp__orbit__task_create_batch');
    // Unfolded on sight: the shape is on the row, but the titles are the write, and a reader
    // scrolling a settled turn has no other place to find them.
    expect(html).toContain('准备分片清单');
    expect(html).toContain('batch-graph');
  });

  // The batch tool answers with every field of every row it wrote. Folded, nobody saw it; open by
  // default, it is several hundred lines of JSON restating the list right above it.
  it('does not print the batch result back as JSON', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Transcript
          events={[
            toolEvent('mcp__orbit__task_create_batch', { tasks: [{ title: '分片 A' }] }),
            {
              seq: 2,
              type: 'tool_result',
              payload: {
                toolUseId: 't1',
                content: JSON.stringify([{ id: '34BchKpoLd', title: '分片 A', ownerId: '2p7QMFOw', status: 'OPEN' }]),
              },
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('分片 A');
    expect(html).not.toContain('ownerId');
    expect(html).not.toContain('chat-result');
  });

  // Dropping the echo must not drop the one payload that says something the card cannot.
  it('still shows a failed batch what went wrong', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Transcript
          events={[
            toolEvent('mcp__orbit__task_create_batch', { tasks: [{ title: '分片 A', dependsOnRefs: ['r'] }] }),
            {
              seq: 2,
              type: 'tool_result',
              payload: { toolUseId: 't1', content: 'unknown ref "r"', isError: true },
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('unknown ref');
    expect(html).toContain('chat-result');
  });

  // SVG text neither wraps nor ellipsizes: past the box it runs on over the node beside it. The
  // label budget has to be a width, so a Chinese title gets half the characters a Latin one does.
  it('clips a wide-glyph label by width, not by character count', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Transcript
          events={[
            toolEvent('mcp__orbit__task_create_batch', {
              tasks: [
                { title: '一二三四五六七八九十壹贰叁肆伍', ref: 'r' },
                { title: 'twenty characters ok', ref: 'a', dependsOnRefs: ['r'] },
              ],
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('一二三四五六七八九…');
    expect(html).not.toContain('一二三四五六七八九十…');
    // Twenty half-ems of Latin is still the twenty characters the old count allowed.
    expect(html).toContain('>twenty characters ok<');
  });

  // Fifty is a legal batch (TASK_BATCH_CREATE_MAX) and fifty unfolded rows is a wall dropped into
  // the middle of a turn. Past the ceiling the card goes back to being a card.
  it('leaves an oversized batch folded', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Transcript
          events={[
            toolEvent('mcp__orbit__task_create_batch', {
              tasks: Array.from({ length: 13 }, (_, n) => ({ title: `分片 ${n}` })),
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('13 independent tasks');
    expect(html).not.toContain('分片 0');
  });

  it('names a restructure by its reason rather than its JSON', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Transcript
          events={[
            toolEvent('mcp__orbit__tasklist_propose_dag', {
              listId: 'l1',
              note: '把 WARC 转换拆开并行跑',
              ops: [{ op: 'remove', taskId: 'a', dependsOnTaskId: 'b' }],
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('Restructure dependencies');
    expect(html).toContain('把 WARC 转换拆开并行跑');
  });

  it('still falls back to the generic card for any other MCP tool', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Transcript events={[toolEvent('mcp__orbit__task_get', { taskId: 'x' })]} />
      </MemoryRouter>,
    );

    expect(html).toContain('orbit · task_get');
  });
});

describe('injected context in a user bubble', () => {
  // The runner echoes what it was *given*, so anything delivery appended lands inside the
  // person's own bubble looking like they typed it. Found on the deployed stack, not in a test.
  const CONDITIONS = `<list-conditions list="l1" title="FineWeb">
  配额挡住派发｜12 个就绪任务被配额挡住｜累计 47 次
</list-conditions>`;
  const userEvent = (text: string): RunEvent => ({ seq: 1, type: 'user', payload: { text } });

  it('keeps the appended block out of the bubble body', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[userEvent(`这个列表现在什么情况？\n\n${CONDITIONS}`)]} />,
    );

    // Attribute values stripped first: the block is deliberately still in the tooltip, and
    // asserting over the raw html would pass for the wrong reason either way.
    const visible = html.replace(/title="[^"]*"/g, '');

    expect(visible).toContain('这个列表现在什么情况？');
    expect(visible).not.toContain('list-conditions list=');
    expect(visible).not.toContain('累计 47 次');
  });

  it('keeps the block reachable in the tooltip, so what the model read is not lost', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[userEvent(`这个列表现在什么情况？\n\n${CONDITIONS}`)]} />,
    );

    expect(/title="[^"]*累计 47 次[^"]*"/.test(html)).toBe(true);
  });

  it('says that something was attached, so the reply is not unexplained', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[userEvent(`这个列表现在什么情况？\n\n${CONDITIONS}`)]} />,
    );

    expect(html).toContain('Orbit attached');
    expect(html).toContain('list conditions');
  });

  it('leaves a message nobody appended to completely alone', () => {
    const html = renderToStaticMarkup(<Transcript events={[userEvent('把 WARC 拆开并行跑')]} />);

    expect(html).toContain('把 WARC 拆开并行跑');
    expect(html).not.toContain('Orbit attached');
  });

  it('does not offer to copy a message whose only text was injected', () => {
    const html = renderToStaticMarkup(<Transcript events={[userEvent(`\n\n${CONDITIONS}`)]} />);

    expect(html).toContain('Orbit attached');
    expect(html).not.toContain('aria-label="Copy message"');
  });
});

describe('transcript Markdown links', () => {
  it('opens ordinary links in a new tab without exposing the opener', () => {
    const html = renderToStaticMarkup(<MD>[Orbit](https://example.com/docs)</MD>);

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps a relative app link in the same tab even without router context', () => {
    // Standalone transcript export renders outside BrowserRouter. It still needs a usable link,
    // just without making React Router context a requirement of the static render.
    const html = renderToStaticMarkup(<MD>[Task](/tasks/task-1?view=activity#latest)</MD>);

    expect(html).toContain('href="/tasks/task-1?view=activity#latest"');
    expect(html).not.toContain('target="_blank"');
  });

  it('routes a #-reference instead of leaving the blanked href react-markdown produces', () => {
    // react-markdown's urlTransform strips any scheme off its allow-list, which left href="" —
    // and an empty href in an SPA reloads the page on click.
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MD>{`[FineWeb CC-MAIN-2025-26](orbit-list:${LIST_UUID})`}</MD>
      </MemoryRouter>,
    );

    expect(html).toContain(`href="/lists/${LIST_B62}"`);
    expect(html).toContain('FineWeb CC-MAIN-2025-26');
    expect(html).not.toContain('href=""');
  });

  it('shows the title, not the id, for a task title carrying its own brackets', () => {
    // The composer escapes them; this is the other half of that contract, and the shape every
    // task title in this deployment has.
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MD>{`[\\[W 009/250\\] 000_00008.parquet](orbit-task:${LIST_UUID})`}</MD>
      </MemoryRouter>,
    );

    expect(html).toContain('[W 009/250] 000_00008.parquet');
    expect(html).not.toContain(LIST_UUID);
  });

  it('leaves an unparseable reference inert rather than throwing inside the renderer', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MD>{'[x](orbit-task:not-an-id)'}</MD>
      </MemoryRouter>,
    );

    expect(html).toContain('>x<');
    expect(html).not.toContain('/tasks/');
  });
});

// `MD breaks` is the renderer for hand-laid-out text: composer messages and the task
// panel's Description. Both used to be shown pre-wrapped, so formatting has to render
// *and* the author's own line breaks have to survive.
describe('hand-typed Markdown', () => {
  it('renders the markup while keeping single newlines as line breaks', () => {
    const html = renderToStaticMarkup(
      <MD breaks>{'## Goal\nMake `tdp-prose` render\nKeep this on its own row\n- one\n- two'}</MD>,
    );

    expect(html).toContain('<h2>Goal</h2>');
    expect(html).toContain('<code>tdp-prose</code>');
    expect(html).toContain('<li>one</li>');
    // The two adjacent prose lines are one paragraph — without hard breaks CommonMark
    // would join them with a space.
    expect(html).toContain('render<br/>');
  });
});

// Claude's Bash calls carry a prose `description` that fills the folded row; Codex's carry none
// and wrap the command in `/bin/bash -lc "…"`, so its rows used to read as a bare "Bash".
describe('Bash folded row', () => {
  const bashRow = (input: Record<string, unknown>) =>
    renderToStaticMarkup(
      <Transcript events={[{ seq: 1, type: 'tool_use', payload: { id: 't1', name: 'Bash', input } }]} />,
    );

  it('falls back to the command when the runtime sends no description', () => {
    const html = bashRow({ command: `/bin/bash -lc "orbit task get 'x' --json"` });

    expect(html).toContain('<span class="chat-tool-summary mono">orbit task get &#x27;x&#x27; --json</span>');
  });

  it('still prefers the description when there is one', () => {
    const html = bashRow({ command: 'grep -rn x src/', description: 'Find x' });

    expect(html).toContain('<span class="chat-tool-summary">Find x</span>');
  });
});

describe('foreground Shell card', () => {
  const toolUse: RunEvent = {
    seq: 1,
    type: 'tool_use',
    payload: {
      id: 'shell-turn-1',
      name: 'Bash',
      input: { command: 'npm run test:outcome-reconciler -- --verbose' },
    },
  };
  const renderShell = (events: RunEvent[], output?: string) =>
    renderToStaticMarkup(
      <LiveToolOutputsCtx.Provider
        value={
          output === undefined
            ? new Map()
            : new Map([['shell-turn-1', { content: output, snapshotSeq: 1 }]])
        }
      >
        <Transcript events={events} live />
      </LiveToolOutputsCtx.Provider>,
    );

  it('has an expandable full-command body before a result exists', () => {
    const html = renderShell([toolUse]);

    expect(html).toContain('chat-tool-card chat-tone-exec is-open');
    expect(html).toContain('class="chat-tool-row"');
    expect(html).not.toContain('chat-tool-row no-detail');
    expect(html).toContain('chat-tool-detail');
    expect(html).toContain('<span class="chat-cmd-prompt">$ </span>');
    expect(html).toContain('npm run test:outcome-reconciler -- --verbose');
  });

  it('keeps a background user shell result-only for the Background tray', () => {
    const html = renderShell([
      {
        ...toolUse,
        payload: {
          ...toolUse.payload,
          input: { command: 'npm run worker', run_in_background: true },
        },
      },
    ]);

    expect(html).toContain('chat-tool-row no-detail');
    expect(html).not.toContain('chat-tool-detail');
    expect(html).not.toContain('chat-cmd-prompt');
  });

  it('shows the current live-output snapshot while still running', () => {
    const html = renderShell([toolUse], 'suite one passed\nsuite two running');

    expect(html).toContain('suite one passed');
    expect(html).toContain('suite two running');
    expect(html).toContain('<div class="chat-result-label">output</div>');
    expect(html).toContain('chat-tool-status running');
  });

  it('lets the final tool_result supersede a stale live snapshot', () => {
    const html = renderShell(
      [
        toolUse,
        {
          seq: 2,
          type: 'tool_result',
          payload: { toolUseId: 'shell-turn-1', content: 'authoritative final output' },
        },
      ],
      'stale partial output',
    );

    expect(html).toContain('authoritative final output');
    expect(html).not.toContain('stale partial output');
    expect(html).toContain('chat-tool-status ok');
  });
});

// The folded row of a tool group has one job: decide whether the group is worth opening. A
// settled group answers that with its counts and per-kind breakdown — the last call of 31 is an
// arbitrary anchor — so only a call still in flight gets a string, and it speaks in the same
// prose the expanded rows use rather than in raw shell.
describe('tool group folded row', () => {
  const call = (seq: number, id: string, description: string, command: string) => ({
    seq,
    type: 'tool_use',
    payload: { id, name: 'Bash', input: { command, description } },
  });
  const done = (seq: number, toolUseId: string) => ({ seq, type: 'tool_result', payload: { toolUseId, content: 'ok' } });
  // Assert against the folded row alone — an expanded group legitimately shows every raw command.
  const foldedRow = (html: string) => html.split('chat-tool-group-detail')[0];

  it('names the in-flight call by purpose while the group is still running', () => {
    const html = foldedRow(renderToStaticMarkup(
      <Transcript
        live
        events={[
          call(1, 't1', 'List orbit CLI capabilities', 'orbit capabilities --json'),
          done(2, 't1'),
          call(3, 't2', 'Locate codex rollout file', 'find /root/.codex -name "*01a000ae*" 2>/dev/null | head'),
          call(4, 't3', 'Read runner logs', 'journalctl -u orbit-runner | tail -50'),
        ]}
      />,
    ));

    expect(html).toContain('· Running: ');
    expect(html).toContain('Locate codex rollout file');
    // Neither the raw command of the running call nor of the finished one.
    expect(html).not.toContain('01a000ae');
    expect(html).not.toContain('orbit capabilities');
  });

  it('leaves the row to the counts once every call has settled', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          call(1, 't1', 'List orbit CLI capabilities', 'orbit capabilities --json'),
          done(2, 't1'),
          call(3, 't2', 'Locate codex rollout file', 'find /root/.codex -name "*01a000ae*" 2>/dev/null | head'),
          done(4, 't2'),
          call(5, 't3', 'Read runner logs', 'journalctl -u orbit-runner | tail -50'),
          done(6, 't3'),
        ]}
      />,
    );

    expect(html).toContain('3 succeeded');
    expect(html).not.toContain('Running: ');
    // No call speaks for the group: neither the last command nor its description.
    expect(html).not.toContain('journalctl');
    expect(html).not.toContain('Read runner logs');
    // The per-call detail is one click away, so nothing is lost — only deferred.
    expect(html).not.toContain('chat-tool-group-detail');
  });

  // Opening a group because something is running means closing it again the moment that call
  // lands, which drops the transcript by the height of the group right where the reader is
  // looking. Only a failure — a state that cannot revert — is worth opening on.
  it('stays folded while running so settling cannot yank the layout', () => {
    const events = [
      call(1, 't1', 'List orbit CLI capabilities', 'orbit capabilities --json'),
      done(2, 't1'),
      call(3, 't2', 'Read runner logs', 'journalctl -u orbit-runner | tail -50'),
      done(4, 't2'),
      call(5, 't3', 'Build runner', 'go build ./...'),
    ];
    const runningHtml = renderToStaticMarkup(<Transcript live events={events} />);
    const settledHtml = renderToStaticMarkup(<Transcript live events={[...events, done(6, 't3')]} />);

    expect(runningHtml).not.toContain('chat-tool-group-detail');
    // Same shape before and after the last call lands: only the row's own text changes.
    expect(settledHtml).not.toContain('chat-tool-group-detail');
    expect(runningHtml).toContain('1 running · 2 succeeded');
    expect(settledHtml).toContain('3 succeeded');
  });

  // Forcing a failed group open unfolds the failed call with it (ToolView opens on error), so one
  // bad command became a screenful of clamped heredoc. Name the failure on the row instead.
  it('names the failed call on the row rather than unfolding the group', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          call(1, 't1', 'List orbit CLI capabilities', 'orbit capabilities --json'),
          done(2, 't1'),
          call(3, 't2', 'Build runner', 'go build ./...'),
          { seq: 4, type: 'tool_result', payload: { toolUseId: 't2', content: 'boom', isError: true } },
          call(5, 't3', 'Read runner logs', 'journalctl -u orbit-runner | tail -50'),
          done(6, 't3'),
        ]}
      />,
    );

    expect(html).not.toContain('chat-tool-group-detail');
    expect(html).toContain('1 failed');
    expect(html).toContain('· Failed: ');
    expect(html).toContain('Build runner');
    // The command that failed stays behind the fold, error included.
    expect(html).not.toContain('go build');
    expect(html).not.toContain('boom');
  });

  // The first failure is usually what caused the ones after it.
  it('names the first failure when several calls failed', () => {
    const bad = (seq: number, toolUseId: string) => ({
      seq,
      type: 'tool_result',
      payload: { toolUseId, content: 'boom', isError: true },
    });
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          call(1, 't1', 'Generate the client', 'prisma generate'),
          bad(2, 't1'),
          call(3, 't2', 'Build runner', 'go build ./...'),
          bad(4, 't2'),
          call(5, 't3', 'Read runner logs', 'journalctl -u orbit-runner | tail -50'),
          done(6, 't3'),
        ]}
      />,
    );

    expect(html).toContain('· Failed: ');
    expect(html).toContain('Generate the client');
    expect(html).not.toContain('Build runner');
  });

  it('reserves the caret column for a running call with no detail yet', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={'html' as never}>
        <Transcript
          live
          events={[
            { seq: 1, type: 'tool_use', payload: { id: 't1', name: 'wait', input: {} } },
            done(2, 't1'),
            { seq: 3, type: 'tool_use', payload: { id: 't2', name: 'wait', input: {} } },
            done(4, 't2'),
            { seq: 5, type: 'tool_use', payload: { id: 't3', name: 'wait', input: {} } },
            done(6, 't3'),
            { seq: 7, type: 'tool_use', payload: { id: 't4', name: 'wait', input: {} } },
            done(8, 't4'),
            { seq: 9, type: 'tool_use', payload: { id: 't5', name: 'wait', input: {} } },
          ]}
        />
      </ExportCtx.Provider>,
    );

    expect(html).toContain('1 running · 4 succeeded');
    expect(html).toContain(
      'class="chat-tool-row no-detail"><span class="chat-tool-caret"></span><span class="chat-tool-icon"',
    );
  });
});

// A failed call is opened to find out why. The input is clamped at sixteen lines, which is enough
// to push the reason off the bottom of the card — so the error goes first.
describe('failed tool call body', () => {
  const failed = [
    {
      seq: 1,
      type: 'tool_use',
      payload: { id: 't1', name: 'Bash', input: { command: 'cat >> spec.ts', description: 'Append the tests' } },
    },
    {
      seq: 2,
      type: 'tool_result',
      payload: { toolUseId: 't1', content: 'No such file or directory', isError: true },
    },
  ];

  // The red mark on the row says it failed; unfolding sixteen clamped lines of heredoc to say
  // the same thing is the disproportionate part.
  it('stays folded, like every other settled call', () => {
    const html = renderToStaticMarkup(<Transcript events={failed} />);

    expect(html).toContain('Append the tests');
    expect(html).toContain('chat-tool-status err');
    expect(html).not.toContain('chat-tool-detail');
    expect(html).not.toContain('No such file or directory');
  });

  it('puts the error above the command that produced it once opened', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={'html' as never}>
        <Transcript events={failed} />
      </ExportCtx.Provider>,
    );

    expect(html.indexOf('No such file or directory')).toBeLessThan(html.indexOf('cat &gt;&gt; spec.ts'));
  });

  // A successful call keeps the old order. Only an export opens one without a click, so that is
  // what this renders through.
  it('leaves a successful call reading input-then-output', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={'html' as never}>
        <Transcript
          events={[
            {
              seq: 1,
              type: 'tool_use',
              payload: { id: 't1', name: 'Bash', input: { command: 'go build ./...', description: 'Build runner' } },
            },
            { seq: 2, type: 'tool_result', payload: { toolUseId: 't1', content: 'compiled cleanly' } },
          ]}
        />
      </ExportCtx.Provider>,
    );

    expect(html.indexOf('go build')).toBeLessThan(html.indexOf('compiled cleanly'));
  });
});

describe('runtime authentication help', () => {
  // The relay branch renders RunnerSignIn, which reads the query cache.
  const card = (provider: string) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthErrorCtx.Provider value={{ provider, runnerId: 'runner-1', runnerName: 'box' }}>
          <Transcript events={[errorEvent(1, AUTH_FAILED)]} />
        </AuthErrorCtx.Provider>
      </QueryClientProvider>,
    );

  it("names OpenCode's command instead of a relay button that cannot drive its login", () => {
    const html = card('opencode');

    // Still a runner-local sign-in, not a Providers API key...
    expect(html).toContain('Sign-in expired');
    // ...but its login picks a provider interactively, so the relay is not offered.
    expect(html).toContain('opencode auth login');
    expect(html).not.toContain('rsi-');
  });

  it('keeps the browser relay for the runtimes that support it', () => {
    const html = card('codex');

    expect(html).toContain('Sign-in expired');
    expect(html).toContain('rsi-');
    expect(html).not.toContain('opencode auth login');
  });

  it('still routes a configured provider to its API key', () => {
    const html = card('deepseek');

    expect(html).toContain('Provider authentication failed');
    expect(html).not.toContain('opencode auth login');
  });
});

describe('shared-checkout notice', () => {
  const NOTICE =
    'This turn left 1 file modified in the shared checkout /root/orbit, outside this session’s worktree: src/a.ts.';

  it('renders a runner notice as a calm note, not an error', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[{ seq: 1, type: 'system', payload: { notice: NOTICE, noticeKind: 'shared-checkout-dirty' } }]}
      />,
    );

    expect(html).toContain('chat-notice');
    expect(html).toContain('/root/orbit');
    expect(html).not.toContain('chat-error');
  });

  // The same event type still carries engine stderr, which must keep reading as a failure.
  it('leaves stderr on the error path', () => {
    const html = renderToStaticMarkup(
      <Transcript events={[{ seq: 1, type: 'system', payload: { stderr: 'No conversation found with session ID: x' } }]} />,
    );

    expect(html).toContain('chat-error');
    expect(html).not.toContain('chat-notice');
  });
});

// A run of ordinary tool calls folds into one summary row, but a spawned child session is a
// destination the reader is meant to click — folded into "Tools × 3" it is a line item of a
// summary nobody opens.
describe('tool run folding', () => {
  let seq = 0;
  const call = (name: string, input: Record<string, unknown>): RunEvent[] => {
    const id = `t${++seq}`;
    return [{ seq, type: 'tool_use', payload: { id, name, input } }];
  };
  const callWith = (name: string, input: Record<string, unknown>, content: unknown): RunEvent[] => {
    const [use] = call(name, input);
    return [use, { seq: ++seq, type: 'tool_result', payload: { toolUseId: (use.payload as any).id, content } }];
  };
  const render = (events: RunEvent[][]) => renderToStaticMarkup(<Transcript events={events.flat()} />);

  it('keeps a spawned child session as a card of its own', () => {
    const html = render([
      callWith('Bash', { command: 'ls' }, 'a.txt'),
      callWith(
        'mcp__orbit__session_create',
        { prompt: 'go' },
        JSON.stringify({ id: 's1', title: 'Child', status: 'PENDING', provider: 'claude' }),
      ),
      callWith('Bash', { command: 'pwd' }, '/tmp'),
    ]);

    expect(html).toContain('chat-session-card');
    expect(html).toContain('Child');
    // The tone class is what carries --tone, and the card's left accent is `3px solid var(--tone)`
    // — with an unknown tone name the whole border shorthand is dropped and the stripe vanishes.
    // Only the names the stylesheet defines will do (see .chat-tone-* in index.css).
    expect(html).toContain('chat-tone-agent');
    // Splitting the run on the card leaves two singles — neither reaches the fold threshold.
    expect(html).not.toContain('chat-tool-group');
  });

  // A sub-workspace card was kept out only by its children, which arrive after the call — so it
  // spent the start of every run inside the summary and hopped out on the first child event.
  it('keeps a sub-workspace out of the fold before its first child event', () => {
    const html = render([
      callWith('Bash', { command: 'ls' }, 'a.txt'),
      call('Task', { description: 'Explore', prompt: 'look around' }),
      callWith('Bash', { command: 'pwd' }, '/tmp'),
    ]);

    expect(html).toContain('chat-tool-task');
    expect(html).not.toContain('chat-tool-group');
  });

  // Same reason as the child-session card: a batch renders its own picture and its own list of
  // titles, and a line item inside "Tools × 3" is none of that.
  it('keeps a created batch out of the fold', () => {
    const html = render([
      callWith('Bash', { command: 'ls' }, 'a.txt'),
      callWith('mcp__orbit__task_create_batch', { tasks: [{ title: '分片 A' }] }, 'ok'),
      callWith('Bash', { command: 'pwd' }, '/tmp'),
    ]);

    expect(html).toContain('Create tasks');
    expect(html).not.toContain('chat-tool-group');
  });

  // A screenshot is the one card the reader is meant to *look* at, and ToolView unfolds it for
  // exactly that reason — but it can't unfold the group around it, so a picture folded into
  // "Read × 3" reaches the reader as a counter.
  it('keeps a screenshot out of the fold, picture and all', () => {
    const data = 'iVBORw0KGgo=';
    const shot = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }];
    const html = render([
      callWith('Read', { file_path: '/tmp/s0.png' }, shot),
      callWith('Read', { file_path: '/tmp/s1.png' }, shot),
      callWith('Read', { file_path: '/tmp/s2.png' }, shot),
    ]);

    expect(html).not.toContain('chat-tool-group');
    expect(html.split(`data:image/png;base64,${data}`).length - 1).toBe(3);
  });

  // Lifting the picture out is not licence to stop folding around it: the plain calls either side
  // are still a run, and still the noise the summary row exists to swallow.
  it('still folds the plain calls a screenshot sits among', () => {
    const data = 'iVBORw0KGgo=';
    const html = render([
      callWith('Bash', { command: 'ls' }, 'a.txt'),
      callWith('Bash', { command: 'pwd' }, '/tmp'),
      callWith('Bash', { command: 'whoami' }, 'root'),
      callWith('Read', { file_path: '/tmp/s0.png' }, [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ]),
    ]);

    expect(html).toContain('Bash × 3');
    expect(html).toContain(`data:image/png;base64,${data}`);
  });

  it('still folds a run of plain calls', () => {
    const html = render([
      callWith('Bash', { command: 'ls' }, 'a.txt'),
      callWith('Bash', { command: 'pwd' }, '/tmp'),
      callWith('Bash', { command: 'whoami' }, 'root'),
    ]);

    expect(html).toContain('chat-tool-group');
    expect(html).toContain('Bash × 3');
  });
});

// A screenshot too big to ship inline reaches the transcript as an image block with no `data`
// (see the apiserver's MAX_IMAGE_PAYLOAD). What must survive that clip is the *card opening*:
// the untrimmed payload is fetched only for an open card, so a card that folds because it can't
// see an image is a card that never asks for the image — the picture would be gone, not deferred.
describe('clipped screenshot results', () => {
  const imageResult = (source: Record<string, unknown>): RunEvent[] => [
    { seq: 1, type: 'tool_use', payload: { id: 'ti', name: 'Read', input: { file_path: '/tmp/shot.png' } } },
    {
      seq: 2,
      type: 'tool_result',
      truncated: true,
      payload: { toolUseId: 'ti', content: [{ type: 'image', source }] },
    },
  ];
  const render = (events: RunEvent[]) => renderToStaticMarkup(<Transcript events={events} />);

  it('opens the card for an image whose bytes the server dropped', () => {
    const html = render(imageResult({ type: 'base64', media_type: 'image/png' }));

    expect(html).toContain('is-open');
  });

  it('still opens — and renders — a small image that arrived whole', () => {
    const data = 'iVBORw0KGgo=';
    const html = render(imageResult({ type: 'base64', media_type: 'image/png', data }));

    expect(html).toContain('is-open');
    expect(html).toContain(`data:image/png;base64,${data}`);
  });

  it('leaves a text-only result folded', () => {
    const html = renderToStaticMarkup(
      <Transcript
        events={[
          { seq: 1, type: 'tool_use', payload: { id: 't1', name: 'Read', input: { file_path: '/a.ts' } } },
          { seq: 2, type: 'tool_result', payload: { toolUseId: 't1', content: 'plain output' } },
        ]}
      />,
    );

    expect(html).not.toContain('is-open');
  });
});
