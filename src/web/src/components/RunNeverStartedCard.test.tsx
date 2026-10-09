// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { dispatchRefusalNextStep } from '@orbit/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NEVER_STARTED_TITLE,
  RunNeverStartedCard,
  runNeverStarted,
  type NeverStartedFacts,
  type NeverStartedInput,
} from './RunNeverStartedCard';

/**
 * The card over a conversation whose run never became one, and the two cause sets behind it.
 *
 * Both halves of the discrimination are held here. A session with a SOURCE reads its refusal off
 * its own columns and must give the SAME next step the task's timeline and the coordinator's
 * message carry (`dispatchRefusalNextStep`), never a second phrasing of it. A session without one
 * reads `session.error` against the vocabulary the transcript's repair cards already speak — and
 * only for a run whose engine never spoke, which is what keeps a failure the engine itself reported
 * on the card it already has.
 */

const REF = 'refs/heads/project/34bZ3i4AvgJaaoaw5E9tH';
const TASK = '34bhbVgdYajslnz4aXvVA';

/** The refused run of 2026-10-07, as `GET /sessions/:id` carries it. */
const REFUSED = {
  id: '2PLgNAQaH00wZ56CN8J03M',
  taskId: TASK,
  status: 'FAILED',
  numTurns: 0,
  engineStartedAt: null,
  sourceState: 'REFUSED',
  sourceRef: REF,
  sourceRefusalCode: 'BASE_REF_NOT_FOUND',
  sourceRefusalDetail: {
    ref: REF,
    refAuthority: 'REMOTE',
    remoteName: 'origin',
    stderr: `git: fatal: couldn't find remote ref ${REF}`,
    fixAction: 'FIX_REF',
  },
};

const input = (session: NeverStartedInput['session'], over: Partial<NeverStartedInput> = {}): NeverStartedInput => ({
  session,
  runtime: 'claude',
  runnerName: 'longdeMac-mini.local',
  ...over,
});

const facts = (session: NeverStartedInput['session'], over: Partial<NeverStartedInput> = {}) => {
  const found = runNeverStarted(input(session, over));
  if (!found) throw new Error('expected a never-started card');
  return found;
};

describe('a refused SOURCE', () => {
  it('names the code, the ref and the machine’s own words, off the session’s own columns', () => {
    const card = facts(REFUSED);
    expect(card.cause).toBe('SOURCE_REFUSED');
    expect(card.subject).toBe(`BASE_REF_NOT_FOUND · ${REF}`);
    expect(card.detail).toBe(`git: fatal: couldn't find remote ref ${REF}`);
    expect(card.why).toContain('branch that doesn’t exist yet');
    expect(card.actions).toEqual(['start-again', 'chat-about']);
  });

  it('gives the next step the task’s timeline gives, verbatim', () => {
    // The one sentence, from the one function the apiserver writes its comment and the
    // coordinator's message with — a second phrasing here is what this asserts against.
    expect(facts(REFUSED).next).toBe(
      dispatchRefusalNextStep({ fixAction: 'FIX_REF', ref: REF }),
    );
    expect(facts(REFUSED).next).toContain(REF);
  });

  it('gives the same card to a refusal the checkout met — the code in the run’s last words', () => {
    // A DEPENDENCY_BASE_NOT_LANDED refuses AFTER the pin froze, so the session's SOURCE state
    // cannot carry it (§6.1's freeze guard); the runner's error line is where it exists.
    const card = facts({
      ...REFUSED,
      sourceState: 'PINNED',
      sourceRefusalCode: null,
      sourceRefusalDetail: null,
      sourceRef: REF,
      error: 'DEPENDENCY_BASE_NOT_LANDED: commit decda058 is not in the pinned commit',
    });
    expect(card.cause).toBe('SOURCE_REFUSED');
    expect(card.subject).toBe(`DEPENDENCY_BASE_NOT_LANDED · ${REF}`);
    expect(card.why).toContain('has not absorbed it yet');
    expect(card.detail).toBe('commit decda058 is not in the pinned commit');
  });

  it('reads no refusal into a Legacy session whose error merely looks like a code', () => {
    const card = facts({
      ...REFUSED,
      sourceState: 'UNBOUND',
      sourceRefusalCode: null,
      sourceRefusalDetail: null,
      error: 'BASE_REF_NOT_FOUND: some engine error that begins with a code',
    });
    expect(card.cause).not.toBe('SOURCE_REFUSED');
  });
});

describe('a session with no SOURCE refusal', () => {
  it('names an engine this runner cannot run, with the one press that fixes it', () => {
    const card = facts(
      { status: 'QUEUED', numTurns: 0, engineStartedAt: null, error: 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first' },
      { runtime: 'opencode' },
    );
    expect(card.cause).toBe('RUNNER_UPGRADE');
    expect(card.why).toBe('Waiting for a newer runner');
    expect(card.body).toContain('OpenCode requires Orbit runner 0.1.82 or newer; update this runner first');
    expect(card.body).toContain('The runner updates itself when no session is running on it');
    expect(card.actions).toEqual(['open-runner']);
  });

  it('names an engine that is not installed, with Install', () => {
    const card = facts(
      { status: 'QUEUED', numTurns: 0, engineStartedAt: null, error: 'DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner' },
      { runtime: 'dsh' },
    );
    expect(card.cause).toBe('ENGINE_NOT_INSTALLED');
    expect(card.why).toBe('DeepSeek Harness isn’t installed on longdeMac-mini.local');
    expect(card.body).toBe('Install it from Infrastructure, then send your message again.');
    expect(card.actions).toEqual(['install', 'open-runner']);
  });

  it('names a key problem and sends the reader to the page that holds it', () => {
    const card = facts(
      { status: 'RUNNING', numTurns: 0, engineStartedAt: null, error: 'DSH_CREDENTIAL_INVALID: DeepSeek rejected the key' },
      { runtime: 'dsh', keyName: 'the DeepSeek key “DeepSeek 2”' },
    );
    expect(card.cause).toBe('ENGINE_SIGNED_OUT');
    expect(card.why).toBe('DeepSeek rejected this API key');
    // Which of the DeepSeek keys, by its own name (board 8).
    expect(card.body).toBe('Update the DeepSeek key “DeepSeek 2” in Infrastructure, then send your message again.');
    expect(card.actions).toEqual(['open-providers', 'send-again']);
  });

  it('calls the missing credential a DeepSeek key, not a key of the engine', () => {
    const card = facts(
      { status: 'QUEUED', numTurns: 0, engineStartedAt: null, error: 'DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key for this session' },
      { runtime: 'dsh' },
    );
    expect(card.why).toBe('DeepSeek Harness needs a DeepSeek key');
    expect(card.body).toBe(
      'This session has no DeepSeek key to run on. Add or re-enable a DeepSeek key in Infrastructure, then send your message again.',
    );
  });

  it('reads a vanished runner off the reaper’s own sentence', () => {
    const card = facts({ status: 'FAILED', numTurns: 0, engineStartedAt: null, error: 'runner offline' });
    expect(card.cause).toBe('RUNNER_OFFLINE');
    expect(card.why).toBe('The runner holding this session went offline');
    expect(card.body).toContain('longdeMac-mini.local stopped reporting while this run was starting');
    expect(card.foot).toBe('Disconnected — runner went offline');
    expect(card.actions).toEqual(['send-again', 'open-runner']);
  });

  it('claims an engine that died on startup only for a run that produced no turn', () => {
    expect(facts({ status: 'FAILED', numTurns: 0, engineStartedAt: null, error: '' }).cause).toBe('ENGINE_DIED');
    // A failed run with turns behind it is a conversation that broke, not a run that never started.
    expect(runNeverStarted(input({ status: 'FAILED', numTurns: 4, engineStartedAt: null, error: '' }))).toBeNull();
  });

  it('leaves a run whose engine spoke to the cards that already cover it', () => {
    // The engine said something (engineStartedAt stamps its first event), so whatever ended this
    // run is the transcript's story — never "this run never started".
    expect(
      runNeverStarted(
        input({
          status: 'FAILED',
          numTurns: 0,
          engineStartedAt: '2026-10-07T07:45:43.000Z',
          error: 'API Error: Request rejected (429)',
        }),
      ),
    ).toBeNull();
  });

  it('leaves a failure the server is about to re-send to the auto-retry card', () => {
    expect(
      runNeverStarted(
        input({
          status: 'FAILED',
          numTurns: 0,
          engineStartedAt: null,
          error: 'runner offline',
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    ).toBeNull();
  });

  it('says nothing at all about a session that is merely waiting to be claimed', () => {
    expect(runNeverStarted(input({ status: 'QUEUED', numTurns: 0, engineStartedAt: null }))).toBeNull();
  });
});

describe('the card as it is drawn', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(async () => {
    const mounted = root;
    root = null;
    if (mounted) await act(async () => mounted.unmount());
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  const paint = (facts: NeverStartedFacts, onClick = (): void => {}): HTMLElement => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    container = node;
    root = createRoot(node);
    act(() => {
      root!.render(
        <RunNeverStartedCard
          never={facts}
          actions={{ startAgain: onClick, chatAbout: () => {}, openRunner: () => {} }}
        />,
      );
    });
    return node;
  };

  it('draws the title, the ref, the shared next step and only the presses it was handed', () => {
    const node = paint(facts(REFUSED));
    const html = node.innerHTML;
    expect(html).toContain(NEVER_STARTED_TITLE);
    expect(html).toContain(REF);
    expect(html).toContain(dispatchRefusalNextStep({ fixAction: 'FIX_REF', ref: REF }));
    expect(html).toContain('FROM ORBIT');
    const buttons = [...node.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Start it again', 'Chat about this']);
    expect(node.querySelector('.chat-authfix')?.getAttribute('data-run-never-started')).toBe(
      'SOURCE_REFUSED',
    );
  });

  it('draws no press the host cannot make', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    container = node;
    root = createRoot(node);
    act(() => {
      root!.render(<RunNeverStartedCard never={facts(REFUSED)} actions={{}} />);
    });
    expect(node.querySelectorAll('button')).toHaveLength(0);
    expect(node.textContent).toContain(NEVER_STARTED_TITLE);
  });

  it('renders a static card for the machine half too', () => {
    const machine = facts({ status: 'FAILED', numTurns: 0, engineStartedAt: null, error: 'runner offline' });
    const html = renderToStaticMarkup(
      <RunNeverStartedCard never={machine} actions={{ sendAgain: () => {}, openRunner: () => {} }} />,
    );
    expect(html).toContain('The runner holding this session went offline');
    expect(html).toContain('Disconnected — runner went offline');
    expect(html).toContain('Send it again');
  });
});
