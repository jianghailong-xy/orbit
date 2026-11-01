// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { claudeRegionRefusedError, claudeRegionStoppedError, CLAUDE_REGIONS_SOURCE_URL, type RunnerRegionView } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEVER_STARTED_TITLE,
  RunNeverStartedCard,
  runNeverStarted,
  type NeverStartedFacts,
  type NeverStartedInput,
} from './RunNeverStartedCard';

/**
 * The card over a session the control plane holds for the Claude region (docs/claude-region-check-
 * contract.md §9–§11, board 02 B): the cause is read by the code its error starts with, the place by
 * `runner.region`, and the three ways out are another provider, another machine and a check now.
 */

const REFUSAL = claudeRegionRefusedError('HPC', 'mainland China');
/** Where HPC's Claude connection came out, checked two minutes before noon — local wall clock, so the
 *  card's "Checked 11:58" holds in any zone. */
const NOW = new Date(2026, 9, 31, 12, 0, 0);
const CHECKED = new Date(2026, 9, 31, 11, 58, 0);
const HHMM = '11:58';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
const BLOCKED: RunnerRegionView = {
  verdict: 'blocked',
  country: 'CN',
  regionCode: null,
  name: 'mainland China',
  viaProxy: false,
  checkedAt: CHECKED.toISOString(),
};

/** The held session of board 02 B: queued, its message waiting, the refusal in its error. */
const HELD = { status: 'QUEUED', runState: 'QUEUED', numTurns: 1, engineStartedAt: '2026-10-31T11:20:00Z', error: REFUSAL };

const input = (session: NeverStartedInput['session'], over: Partial<NeverStartedInput> = {}): NeverStartedInput => ({
  session,
  runtime: 'claude',
  runnerName: 'HPC',
  region: BLOCKED,
  ...over,
});

const facts = (session: NeverStartedInput['session'], over: Partial<NeverStartedInput> = {}): NeverStartedFacts => {
  const found = runNeverStarted(input(session, over));
  if (!found) throw new Error('expected a never-started card');
  return found;
};

describe('the region cause', () => {
  it('reads REGION_UNSUPPORTED off the code, with the place from runner.region', () => {
    expect(facts(HELD)).toEqual({
      cause: 'REGION_UNSUPPORTED',
      why: 'Claude Code can’t use Anthropic on HPC',
      body: 'HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.',
      bodyLink: { label: 'Supported regions', href: CLAUDE_REGIONS_SOURCE_URL },
      subject: 'CLAUDE_REGION_UNSUPPORTED · CN',
      detail: `Checked ${HHMM} · Claude’s connection: mainland China (no proxy)`,
      next: null,
      actions: ['other-provider', 'move-session', 'check-again'],
      foot: 'No engine ran · your message is still here',
    });
  });

  it('says a proxy when the check went through one', () => {
    expect(facts(HELD, { region: { ...BLOCKED, viaProxy: true } }).detail).toBe(
      `Checked ${HHMM} · Claude’s connection: mainland China (through a proxy)`,
    );
  });

  it('names an excluded region of a listed country by its own code', () => {
    const crimea = { ...BLOCKED, country: 'UA', regionCode: 'UA-43', name: 'Crimea' };
    const card = facts({ ...HELD, error: claudeRegionRefusedError('HPC', 'Crimea') }, { region: crimea });
    expect(card.subject).toBe('CLAUDE_REGION_UNSUPPORTED · UA-43');
    expect(card.body).toBe('HPC’s connection to Anthropic is in Crimea, where Anthropic doesn’t offer Claude.');
  });

  it('never reads the place out of the sentence: the region the runner reports is the one named', () => {
    // The sentence was written before the last check; the card says where the runner stands now.
    const card = facts({ ...HELD, error: claudeRegionRefusedError('HPC', 'Russia') });
    expect(card.body).toContain('mainland China');
    expect(card.body).not.toContain('Russia');
  });

  it('keeps the server’s own words, without the code, where the runner no longer reads blocked', () => {
    for (const region of [null, { ...BLOCKED, verdict: 'allowed' as const }]) {
      const card = facts(HELD, { region });
      expect(card.cause).toBe('REGION_UNSUPPORTED');
      expect(card.subject).toBe('CLAUDE_REGION_UNSUPPORTED');
      expect(card.detail).toBeNull();
      expect(card.body).toBe('HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.');
    }
  });

  it('outranks every cause read by pattern, whatever the machine is called', () => {
    // "offline" and "not signed in" in a machine's name would otherwise pick other causes.
    for (const machine of ['offline-box', 'not signed in', 'old runner, update this runner first']) {
      const card = facts({ ...HELD, error: claudeRegionRefusedError(machine, 'Russia') }, { runnerName: machine });
      expect(card.cause).toBe('REGION_UNSUPPORTED');
      expect(card.why).toBe(`Claude Code can’t use Anthropic on ${machine}`);
    }
  });

  it('says the run ended where a control plane that predates the hold failed it', () => {
    const failed = { status: 'FAILED', runState: 'FAILED', numTurns: 0, engineStartedAt: null, error: REFUSAL };
    expect(facts(failed).foot).toBe('Ended · no engine ran · 0 turns');
  });

  it('draws no card for a stopped turn: it ran, and its sentence stands in the transcript', () => {
    const stopped = claudeRegionStoppedError('HPC', 'mainland China');
    expect(runNeverStarted(input({ runState: 'AWAITING_INPUT', numTurns: 2, engineStartedAt: '2026-10-31T11:20:00Z', error: stopped }))).toBeNull();
    // On a control plane that predates the subtypes it is a failed run whose engine spoke.
    expect(runNeverStarted(input({ runState: 'FAILED', numTurns: 2, engineStartedAt: '2026-10-31T11:20:00Z', error: stopped }))).toBeNull();
  });
});

describe('the region card', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });
  const paint = (never: NeverStartedFacts, actions: Parameters<typeof RunNeverStartedCard>[0]['actions']) => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    container = node;
    root = createRoot(node);
    act(() => {
      root!.render(<RunNeverStartedCard never={never} actions={actions} />);
    });
    return node;
  };

  it('draws the three ways out, Use another provider first and filled, each doing its own press', () => {
    const otherProvider = vi.fn();
    const moveSession = vi.fn();
    const checkAgain = vi.fn();
    const node = paint(facts(HELD), { otherProvider, moveSession, checkAgain });
    expect(node.querySelector('[data-run-never-started]')?.getAttribute('data-run-never-started')).toBe('REGION_UNSUPPORTED');
    expect(node.textContent).toContain(NEVER_STARTED_TITLE);
    const buttons = [...node.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Use another provider', 'Move to another machine', 'Check again']);
    expect(buttons.map((b) => b.className)).toEqual(['chat-authfix-go', 'chat-authfix-retry', 'chat-authfix-retry']);
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    act(() => buttons[2].click());
    expect([otherProvider, moveSession, checkAgain].map((press) => press.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('links Supported regions after the body, and draws the machine’s words under it', () => {
    const node = paint(facts(HELD), {});
    const link = node.querySelector<HTMLAnchorElement>('.chat-authfix-desc a');
    expect(link?.textContent).toBe('Supported regions');
    expect(link?.getAttribute('href')).toBe(CLAUDE_REGIONS_SOURCE_URL);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(node.querySelector('.run-never-started-subject')?.textContent).toBe('CLAUDE_REGION_UNSUPPORTED · CN');
    expect(node.querySelector('.chat-authfix-last')?.textContent).toBe(`Checked ${HHMM} · Claude’s connection: mainland China (no proxy)`);
    expect(node.querySelector('.run-never-started-foot')?.textContent).toBe('No engine ran · your message is still here');
    // Nothing it was not handed is drawn.
    expect(node.querySelectorAll('button')).toHaveLength(0);
  });

  it('holds every press while one is in flight', () => {
    const node = paint(facts(HELD), { otherProvider: () => {}, moveSession: () => {}, checkAgain: () => {}, busy: true });
    expect([...node.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
  });
});
