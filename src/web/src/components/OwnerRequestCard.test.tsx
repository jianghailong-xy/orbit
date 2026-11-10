// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OwnerRequestCard,
  OwnerRequestResolved,
  WaitingOnYouTaskBadge,
  useSessionOwnerRequestInserts,
} from './OwnerRequestCard';
import {
  resetSnoozesForTest,
  snoozeRequest,
  type OwnerRequest,
  type OwnerRequestSecretGrant,
} from '../lib/ownerRequests';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const { copyText } = await import('../lib/clipboard');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TASK = '34uP5LO7TmWkkddgVZJqG';
const SESSION = '34uOqHiF7f3VmoARfQg6y';

function request(over: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    id: 'req1',
    kind: 'CONFIRM',
    state: 'PENDING',
    title: 'Ship the release',
    why: 'The tag has to be pushed before the window closes.',
    blocksTaskIds: [],
    ifUnanswered: null,
    options: null,
    recommendedOption: null,
    steps: null,
    secretSpec: null,
    secretGrant: null,
    verifyHint: null,
    expiresAt: null,
    askedBySessionId: SESSION,
    projectId: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolvedBySessionId: null,
    resolutionNote: null,
    answer: null,
    createdAt: new Date(NOW - 2 * MINUTE).toISOString(),
    ...over,
  };
}

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

let root: Root | null = null;
let host: HTMLElement;

async function mount(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
    );
  });
  await flush();
}

const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button named ${name}: ${host.textContent}`);
  return found;
};

async function press(target: HTMLElement) {
  await act(async () => { target.click(); });
  await flush();
}

async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetSnoozesForTest();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/runners') return [{ id: 'run1', name: 'hpc-01', displayName: 'HPC' }] as never;
    if (path.startsWith('/tasks/')) return { title: 'M0 follow-up experiments' } as never;
    if (path.startsWith('/owner-requests?')) return { requests: [] } as never;
    if (path === '/account-secrets') return { secrets: [] } as never;
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

describe('the pending card', () => {
  it('says who is waited on, since when, until when, why, and what it holds up', async () => {
    await mount(
      <OwnerRequestCard
        now={NOW}
        request={request({
          blocksTaskIds: [TASK],
          expiresAt: new Date(NOW + 3 * DAY).toISOString(),
          ifUnanswered: 'experiment 2 does not start',
        })}
      />,
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Waiting on you');
    expect(text).toContain('Asked 2m ago · expires in 3d');
    expect(text).toContain('Ship the release');
    expect(text).toContain('CONFIRM');
    expect(text).toContain('The tag has to be pushed');
    expect(text).toContain('If nobody answers: experiment 2 does not start');
    const chip = host.querySelector<HTMLAnchorElement>('.owner-request-chip')!;
    expect(chip.textContent).toBe('M0 follow-up experiments');
    expect(chip.getAttribute('href')).toBe(`/tasks/${TASK}`);
  });

  it('CONFIRM: the primary action ends it at the done door with nothing to say', async () => {
    apiMock.mockImplementation(async () => request({ state: 'DONE', resolvedByUserId: 'me', resolvedAt: new Date(NOW).toISOString() }) as never);
    await mount(<OwnerRequestCard now={NOW} request={request()} />);
    await press(button('Confirm'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/done', { method: 'POST', body: {} });
    expect(host.querySelector('.owner-request-resolved')?.textContent).toContain('Confirmed');
  });

  it('DECLINE needs a reason, and posts it to the decline door', async () => {
    apiMock.mockImplementation(async () => request({ state: 'DECLINED', resolutionNote: 'not now', resolvedByUserId: 'me', resolvedAt: new Date(NOW).toISOString() }) as never);
    await mount(<OwnerRequestCard now={NOW} request={request()} />);
    await press(button('Decline…'));
    expect(button('Decline').disabled).toBe(true);
    await type(host.querySelector('textarea')!, '  not now ');
    expect(button('Decline').disabled).toBe(false);
    await press(button('Decline'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/decline', { method: 'POST', body: { reason: 'not now' } });
    expect(host.textContent).toContain('Declined: “not now”');
  });

  it('a request past its deadline cannot be pressed: the door would refuse it', async () => {
    await mount(<OwnerRequestCard now={NOW} request={request({ expiresAt: new Date(NOW - MINUTE).toISOString() })} />);
    expect(host.textContent).toContain('expired');
    expect(button('Confirm').disabled).toBe(true);
    expect(button('Decline…').disabled).toBe(true);
  });

  it('shows why the door refused rather than pretending', async () => {
    apiMock.mockImplementation(async () => { throw new Error('this request is already DONE'); });
    await mount(<OwnerRequestCard now={NOW} request={request()} />);
    await press(button('Confirm'));
    expect(host.textContent).toContain('this request is already DONE');
  });
});

describe('MANUAL_STEP', () => {
  const steps = request({
    kind: 'MANUAL_STEP',
    steps: [
      { text: 'Sign in to the BMC console', link: 'https://bmc.gpu-03.lab/' },
      { text: 'Power-cycle the machine' },
      { text: 'Confirm the driver loaded', command: 'nvidia-smi --query-gpu=driver_version --format=csv' },
    ],
    verifyHint: 'runner gpu-03 reconnects',
  });

  it('numbers the steps, offers Open for a link and Copy for a command', async () => {
    await mount(<OwnerRequestCard now={NOW} request={steps} />);
    expect(host.textContent).toContain('STEPS');
    expect([...host.querySelectorAll('.owner-request-step-number')].map((n) => n.textContent)).toEqual(['1', '2', '3']);
    const open = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open')!;
    expect(open.getAttribute('href')).toBe('https://bmc.gpu-03.lab/');
    expect(open.getAttribute('rel')).toContain('noopener');
    await press(button('Copy'));
    expect(copyText).toHaveBeenCalledWith('nvidia-smi --query-gpu=driver_version --format=csv');
    expect(host.textContent).toContain('Copied');
  });

  it('draws the verify hint as the agent’s note, and Mark done ends it', async () => {
    apiMock.mockImplementation(async () => request({ kind: 'MANUAL_STEP', state: 'DONE', resolvedByUserId: 'me', resolvedAt: new Date(NOW).toISOString() }) as never);
    await mount(<OwnerRequestCard now={NOW} request={steps} />);
    expect(host.textContent).toContain('How to check: runner gpu-03 reconnects');
    expect(button('Can’t do this…')).toBeTruthy();
    await press(button('Mark done'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/done', { method: 'POST', body: {} });
  });

  it('an address that is not a web page gets no Open link', async () => {
    await mount(<OwnerRequestCard now={NOW} request={request({ kind: 'MANUAL_STEP', steps: [{ text: 'Go', link: 'javascript:alert(1)' }] })} />);
    expect([...host.querySelectorAll('a')].some((a) => a.textContent === 'Open')).toBe(false);
    expect(host.textContent).toContain('javascript:alert(1)');
  });
});

describe('DECISION', () => {
  const decision = request({
    kind: 'DECISION',
    options: [{ label: 'auth', description: 'Fewer conflicts' }, { label: 'billing' }],
    recommendedOption: 0,
  });

  it('starts on the recommendation and posts the option chosen', async () => {
    apiMock.mockImplementation(async () => ({ ...decision, state: 'DONE', answer: { option: 1 }, resolvedByUserId: 'me', resolvedAt: new Date(NOW).toISOString() }) as never);
    await mount(<OwnerRequestCard now={NOW} request={decision} />);
    expect(host.textContent).toContain('Recommended');
    const radios = host.querySelectorAll<HTMLInputElement>('input[type=radio]');
    expect(radios[0].checked).toBe(true);
    await press(radios[1]);
    await press(button('Send answer'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/done', { method: 'POST', body: { option: 1 } });
    expect(host.querySelector('.owner-request-resolved')?.textContent).toContain('billing');
  });

  it('Other with an empty box is no answer; words are', async () => {
    await mount(<OwnerRequestCard now={NOW} request={decision} />);
    const radios = host.querySelectorAll<HTMLInputElement>('input[type=radio]');
    await press(radios[2]);
    expect(button('Send answer').disabled).toBe(true);
    await type(host.querySelector('textarea')!, 'neither');
    expect(button('Send answer').disabled).toBe(false);
  });
});

describe('SECRET', () => {
  const secret = request({
    kind: 'SECRET',
    title: 'Provide a DeepSeek API key',
    expiresAt: new Date(NOW + 3 * DAY).toISOString(),
    secretSpec: { name: 'DeepSeek API key', runnerId: 'run1', envVar: 'DEEPSEEK_API_KEY' },
  });
  const KEY = 'sk-canary-0123456789abcdef';
  const keyInput = () => host.querySelector<HTMLInputElement>('.owner-request-field input')!;
  const saveBox = () => host.querySelector<HTMLElement>('.owner-request-save [role="checkbox"]')!;
  const grant = (over: Partial<OwnerRequestSecretGrant>): OwnerRequestSecretGrant => ({
    state: 'PENDING_DELIVERY',
    endReason: null,
    exposure: 'ENV',
    expiresAt: new Date(NOW + 7 * DAY).toISOString(),
    deliveredAt: null,
    removedAt: null,
    removalNote: null,
    runnerOnline: true,
    runnerLastSeenAt: null,
    ...over,
  });
  /** Answers the secret doors with the request in this state, and every read as before. */
  const answering = (view: OwnerRequest, saved: { id: string; label: string }[] = []) => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/runners') return [{ id: 'run1', name: 'hpc-01', displayName: 'HPC' }] as never;
      if (path === '/account-secrets') return { secrets: saved.map((s) => ({ ...s, createdAt: '', updatedAt: '' })) } as never;
      if (path.startsWith('/owner-requests?')) return { requests: [] } as never;
      if (path.startsWith('/owner-requests/req1/secret')) return view as never;
      throw new Error(`unexpected ${path}`);
    });
  };

  it('draws where the key goes and the design’s wording, with the key entered in a field that keeps nothing', async () => {
    await mount(<OwnerRequestCard now={NOW} request={secret} />);
    const text = host.textContent ?? '';
    expect(text).toContain('SECRET');
    expect(text).toContain('Runner HPC as DEEPSEEK_API_KEY');
    expect(text).toContain('When the task ends, or after 7 days');
    expect(text).toContain('Goes straight to HPC. Orbit keeps it out of this conversation and away from the agent; only commands the agent runs with it can use it.');
    expect(text).toContain('Use a key you can revoke.');
    expect(keyInput().disabled).toBe(false);
    expect(keyInput().type).toBe('password');
    expect(keyInput().getAttribute('autocomplete')).toBe('off');
    expect(button('Provide key').disabled).toBe(true);
    expect(button('Decline…').disabled).toBe(false);
    // Starts unchecked: the secrets design's decision 3, not the mockup.
    expect(saveBox().getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).not.toContain('Use saved');
  });

  it('a file destination says who can read it', async () => {
    await mount(<OwnerRequestCard now={NOW} request={{ ...secret, secretSpec: { name: 'Key', runnerId: 'run1', filePath: '/etc/key' } }} />);
    expect(host.textContent).toContain('Goes straight to HPC as a file. Orbit keeps it out of this conversation, but any program running as');
    expect(host.textContent).toContain('on HPC can read the file until it is removed. Use a key you can revoke.');
    expect(host.textContent).toContain('Runner HPC at /etc/key');
  });

  it('submits the key in the body only, clears the field, and keeps it nowhere', async () => {
    answering({ ...secret, secretGrant: grant({}) });
    await mount(<OwnerRequestCard now={NOW} request={secret} />);
    await type(keyInput(), KEY);
    expect(button('Provide key').disabled).toBe(false);
    await press(button('Provide key'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/secret', { method: 'POST', body: { value: KEY } });
    for (const [path] of apiMock.mock.calls) expect(path).not.toContain(KEY);
    expect(window.location.href).not.toContain(KEY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(KEY);
    expect(host.innerHTML).not.toContain(KEY);
    // Submitted, the card waits for the runner rather than claiming the key is in.
    expect(host.textContent).toContain('Key is on its way to HPC.');
    expect(host.textContent).not.toContain('Key is in');
  });

  it('the field is empty again as soon as it is submitted, and when delivery fails it comes back with the reason', async () => {
    answering({ ...secret, secretGrant: grant({ state: 'REMOVED', endReason: 'DELIVERY_FAILED', removalNote: 'PATH_TAKEN: a directory stands there' }) });
    await mount(<OwnerRequestCard now={NOW} request={secret} />);
    await type(keyInput(), KEY);
    await press(button('Provide key'));
    expect(keyInput().value).toBe('');
    expect(host.textContent).toContain('The key did not reach HPC');
    expect(host.textContent).toContain('PATH_TAKEN: a directory stands there');
    expect(button('Provide key').disabled).toBe(true);
  });

  it('saving for later is asked for, with a name to save it under', async () => {
    answering({ ...secret, secretGrant: grant({}) });
    await mount(<OwnerRequestCard now={NOW} request={secret} />);
    await type(keyInput(), KEY);
    await press(saveBox());
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Name to save it under"]')!;
    expect(name.value).toBe('DeepSeek API key');
    await type(name, '');
    expect(button('Provide key').disabled).toBe(true);
    await type(name, 'DeepSeek personal');
    await press(button('Provide key'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/secret', {
      method: 'POST',
      body: { value: KEY, saveAs: 'DeepSeek personal' },
    });
  });

  it('Use saved sends the saved secret’s id, not a value', async () => {
    answering({ ...secret, secretGrant: grant({}) }, [{ id: 'acct1', label: 'DeepSeek personal' }]);
    await mount(<OwnerRequestCard now={NOW} request={secret} />);
    expect(host.textContent).toContain('Use saved:');
    await press(button('DeepSeek personal'));
    expect(host.textContent).toContain('Using saved “DeepSeek personal”');
    await press(button('Provide key'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/secret', { method: 'POST', body: { savedSecretId: 'acct1' } });
  });

  it('on its way to an offline runner: says until when it waits, and can be cancelled', async () => {
    answering({ ...secret });
    await mount(<OwnerRequestCard now={NOW} request={{ ...secret, secretGrant: grant({ runnerOnline: false }) }} />);
    expect(host.textContent).toContain('Key is on its way to HPC.');
    expect(host.textContent).toContain('HPC is offline. Orbit will deliver this when it comes back, until ');
    expect(host.querySelector('.owner-request-field input')).toBeNull();
    await press(button('Cancel'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/secret/cancel', { method: 'POST' });
    // Back to input.
    expect(keyInput().disabled).toBe(false);
  });

  it('an earlier key the runner fetched and never confirmed: says removal is pending, and takes no new key yet', async () => {
    answering({ ...secret });
    await mount(<OwnerRequestCard now={NOW} request={{ ...secret, secretGrant: grant({ state: 'REMOVING', endReason: 'REVOKED' }) }} />);
    expect(host.textContent).toContain('Removal pending: waiting for HPC to confirm');
    expect(host.textContent).toContain('You can enter a key again once HPC confirms the earlier one is gone.');
    expect(host.querySelector('.owner-request-field input')).toBeNull();
  });
});

describe('a delivered secret', () => {
  const ended = { resolvedAt: new Date(NOW - MINUTE).toISOString(), resolvedByUserId: 'me' };
  const done = (secretGrant: Partial<OwnerRequestSecretGrant>) => request({
    ...ended,
    state: 'DONE',
    kind: 'SECRET',
    secretSpec: { name: 'k', runnerId: 'run1', envVar: 'K' },
    secretGrant: {
      state: 'ACTIVE',
      endReason: null,
      exposure: 'ENV',
      expiresAt: new Date(NOW + 7 * DAY).toISOString(),
      deliveredAt: new Date(NOW - MINUTE).toISOString(),
      removedAt: null,
      removalNote: null,
      runnerOnline: true,
      runnerLastSeenAt: null,
      ...secretGrant,
    },
  });

  it('ACTIVE: the key is in, until when, and Revoke ends it', async () => {
    const revoking = done({ state: 'REMOVING', endReason: 'REVOKED' });
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/runners') return [{ id: 'run1', name: 'hpc-01', displayName: 'HPC' }] as never;
      if (path === '/owner-requests/req1/secret/revoke') return revoking as never;
      throw new Error(`unexpected ${path}`);
    });
    await mount(<OwnerRequestResolved now={NOW} request={done({})} />);
    expect(host.textContent).toContain('Delivered to HPC as K');
    expect(host.textContent).toContain('Key is in · expires');
    await press(button('Revoke'));
    expect(apiMock).toHaveBeenCalledWith('/owner-requests/req1/secret/revoke', { method: 'POST' });
    expect(host.textContent).toContain('Removal pending: waiting for HPC to confirm');
    expect(host.querySelector('button')).toBeNull();
  });

  it('REMOVING with the runner gone quiet says since when', async () => {
    await mount(<OwnerRequestResolved now={NOW} request={done({ state: 'REMOVING', runnerOnline: false, runnerLastSeenAt: new Date(NOW - DAY).toISOString() })} />);
    expect(host.textContent).toContain('Removal pending: HPC has not been online since ');
  });

  it('an ended request whose fetched key was never confirmed still says removal is pending', async () => {
    const expired = { ...done({ state: 'REMOVING', endReason: 'EXPIRED', deliveredAt: null, runnerOnline: false, runnerLastSeenAt: new Date(NOW - DAY).toISOString() }), state: 'EXPIRED' as const };
    await mount(<OwnerRequestResolved now={NOW} request={expired} />);
    expect(host.textContent).toContain('Removal pending: HPC has not been online since ');
    expect(host.querySelector('button')).toBeNull();
  });

  it('a fetched key whose runner was deleted says removal is unconfirmed, on an ended request and on a pending one', async () => {
    const note = 'Removal unconfirmed: the runner was deleted before it could confirm.';
    const withdrawn = { ...done({ state: 'REMOVED', endReason: 'RUNNER_DELETED', removalNote: note, deliveredAt: null }), state: 'WITHDRAWN' as const };
    await mount(<OwnerRequestResolved now={NOW} request={withdrawn} />);
    expect(host.textContent).toContain(note);
    expect(host.textContent).not.toContain('removal unconfirmed. Removal unconfirmed');
    const pending = { ...done({ state: 'REMOVED', endReason: 'REVOKED', removalNote: note, deliveredAt: null }), state: 'PENDING' as const, resolvedAt: null };
    await mount(<OwnerRequestCard now={NOW} request={pending} />);
    expect(host.textContent).toContain(note);
    expect(host.querySelector('.owner-request-field input')).not.toBeNull();
  });

  it('REMOVED says why, with the runner’s note', async () => {
    await mount(<OwnerRequestResolved now={NOW} request={done({ state: 'REMOVED', endReason: 'TASK_ENDED', removalNote: 'a different file stands at /etc/key; left in place' })} />);
    expect(host.textContent).toContain('Removed when the task ended. a different file stands at /etc/key; left in place');
    expect(host.querySelector('button')).toBeNull();
  });
});

describe('the resolved summary', () => {
  const ended = { resolvedAt: new Date(NOW - MINUTE).toISOString(), resolvedByUserId: 'me' };

  it('says what came of it, who, when, and from which device', async () => {
    await mount(<OwnerRequestResolved now={NOW} request={request({ ...ended, state: 'DONE', resolvedClient: 'ios' })} />);
    const text = host.textContent ?? '';
    expect(text).toContain('Ship the release');
    expect(text).toContain('Confirmed');
    expect(text).toContain('by you');
    expect(text).toContain('via iPhone');
    expect(host.querySelector('button')).toBeNull();
  });

  it('names no device the server did not report', async () => {
    await mount(<OwnerRequestResolved now={NOW} request={request({ ...ended, state: 'DONE' })} />);
    expect(host.textContent).not.toContain('via');
  });

  it('a secret’s summary says where it went', async () => {
    await mount(<OwnerRequestResolved now={NOW} request={request({ ...ended, state: 'DONE', kind: 'SECRET', secretSpec: { name: 'k', runnerId: 'run1', envVar: 'K' } })} />);
    await flush();
    expect(host.textContent).toContain('Delivered to HPC as K');
  });

  it.each([
    [{ state: 'DECLINED', resolutionNote: 'no budget', ...ended }, 'Declined: “no budget”', 'by you'],
    [{ state: 'EXPIRED', resolvedAt: ended.resolvedAt }, 'Expired before anyone answered', null],
    [{ state: 'WITHDRAWN', resolvedAt: ended.resolvedAt, resolvedBySessionId: SESSION }, 'Withdrawn', 'by the session that asked'],
  ] as const)('%#: every ending reads as itself', async (over, outcome, by) => {
    await mount(<OwnerRequestResolved now={NOW} request={request(over as Partial<OwnerRequest>)} />);
    expect(host.textContent).toContain(outcome);
    if (by) expect(host.textContent).toContain(by);
    else expect(host.textContent).not.toContain('by ');
  });
});

describe('Remind me later', () => {
  function Inserts({ list }: { list: readonly never[] }) {
    const inserts = useSessionOwnerRequestInserts(SESSION, list);
    return <>{inserts.map((insert) => <div key={insert.key} data-anchor={insert.anchor}>{insert.element}</div>)}</>;
  }

  it('folds the card until it comes back, and Show now brings it back', async () => {
    apiMock.mockImplementation(async (path: string) =>
      (path.startsWith('/owner-requests?') ? { requests: [request({ createdAt: new Date().toISOString() })] } : []) as never);
    snoozeRequest('req1', Date.now() + 60 * MINUTE);
    await mount(<Inserts list={[]} />);
    expect(host.querySelector('.owner-request-snoozed')?.textContent).toContain('Ship the release');
    expect(host.querySelector('.owner-request-card')).toBeNull();
    await press(button('Show now'));
    expect(host.querySelector('.owner-request-card')).not.toBeNull();
  });
});

describe('where a conversation draws its requests', () => {
  function Inserts({ sessionId, events }: { sessionId: string; events: { seq: number; ts: string }[] }) {
    const inserts = useSessionOwnerRequestInserts(sessionId, events);
    return <>{inserts.map((insert) => <div key={insert.key} data-anchor={insert.anchor}>{insert.element}</div>)}</>;
  }

  it('after the event it was filed at, this session’s only, pending or ended', async () => {
    const at = new Date(NOW).toISOString();
    apiMock.mockImplementation(async (path: string) => ({
      requests: path.endsWith('state=open')
        ? [request({ id: 'open1', createdAt: at })]
        : [
            request({ id: 'ended1', state: 'DONE', resolvedByUserId: 'me', resolvedAt: at, createdAt: at }),
            request({ id: 'other', askedBySessionId: 'somebodyElse', createdAt: at }),
          ],
    }) as never);
    await mount(
      <Inserts
        sessionId={SESSION}
        events={[
          { seq: 4, ts: new Date(NOW - MINUTE).toISOString() },
          { seq: 5, ts: new Date(NOW + MINUTE).toISOString() },
        ]}
      />,
    );
    const anchors = [...host.querySelectorAll<HTMLElement>('[data-anchor]')];
    expect(anchors.map((a) => a.dataset.anchor)).toEqual(['4', '4']);
    expect(host.querySelector('#owner-request-open1.owner-request-card')).not.toBeNull();
    expect(host.querySelector('#owner-request-ended1.owner-request-resolved')).not.toBeNull();
    expect(host.querySelector('#owner-request-other')).toBeNull();
  });
});

describe('two requests filed between the same two events', () => {
  function Inserts() {
    const inserts = useSessionOwnerRequestInserts(SESSION, []);
    return <>{inserts.map((insert) => <div key={insert.key}>{insert.element}</div>)}</>;
  }

  it('read in the order they were asked, though the list is newest first', async () => {
    apiMock.mockImplementation(async (path: string) => ({
      requests: path.endsWith('state=all')
        ? [
            request({ id: 'later', title: 'Later', createdAt: new Date(NOW - MINUTE).toISOString() }),
            request({ id: 'earlier', title: 'Earlier', createdAt: new Date(NOW - 2 * MINUTE).toISOString() }),
          ]
        : [],
    }) as never);
    await mount(<Inserts />);
    expect([...host.querySelectorAll('.owner-request-title')].map((t) => t.textContent)).toEqual(['Earlier', 'Later']);
  });
});

describe('the badge on a task', () => {
  it('shows only on a task a pending request holds up', async () => {
    apiMock.mockImplementation(async () => ({ requests: [request({ blocksTaskIds: [TASK] })] }) as never);
    await mount(<><WaitingOnYouTaskBadge taskId={TASK} /><WaitingOnYouTaskBadge taskId="34uP5KJ3Xuv4BawyBjC5T" /></>);
    expect([...host.querySelectorAll('.owner-request-task-badge')].map((b) => b.textContent)).toEqual(['Waiting on you']);
  });
});
