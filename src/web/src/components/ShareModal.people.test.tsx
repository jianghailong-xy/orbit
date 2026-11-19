// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGuestPerson, SessionGuestSuggestion } from '@orbit/shared';

/**
 * People who can reply, the Share dialog's section on a session (docs/session-guests-design.md §3; board
 * docs/mocks/share-links/10-session-guests-2), in a real document: inviting by email, the answer when no account uses
 * it, Remove, the consequence line, and — in a mode that does not ask — the amber line and the tick the first invite
 * needs; and the people invited before, suggested under the email field (board share-links/14). The server's side is
 * session-guests.pg.spec.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getShareLink: vi.fn(),
  getSessionGuests: vi.fn(),
  getSessionGuestSuggestions: vi.fn(),
  inviteSessionGuest: vi.fn(),
  removeSessionGuest: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { ApiError, getShareLink, getSessionGuests, getSessionGuestSuggestions, inviteSessionGuest, removeSessionGuest } =
  await import('../api');
const { ShareModal } = await import('./ShareModal');

const SESSION = '34ToZJmiOG8Ym1MR6ingQ';
const ALICE: SessionGuestPerson = {
  userId: 'u-alice', name: 'Alice Chen', email: 'alice@example.com', addedAt: '2026-11-12T01:00:00.000Z', messagesToday: 12, opened: true, emailSentAt: '2026-11-12T01:00:05.000Z',
};
const RAVI: SessionGuestPerson = {
  userId: 'u-ravi', name: 'Ravi Kumar', email: 'ravi@example.com', addedAt: '2026-11-12T02:00:00.000Z', messagesToday: 0, opened: false, emailSentAt: null,
};

const invitedBefore = (name: string, email: string, lastInvitedAt: string): SessionGuestSuggestion => ({ name, email, lastInvitedAt });
const PAULA = invitedBefore('Paula Ortiz', 'paula.ortiz@example.com', '2026-11-13T02:00:00.000Z');
const PAT = invitedBefore('Pat Lee', 'patlee@example.net', '2026-10-30T02:00:00.000Z');
const SAM = invitedBefore('Sam Wu', 'sam@example.org', '2026-11-09T02:00:00.000Z');

/** The owner's guest routes, as far as the section reaches them: one session's people, by email. */
let people: SessionGuestPerson[];
function serve(initial: SessionGuestPerson[], before: SessionGuestSuggestion[] = []): void {
  people = [...initial];
  vi.mocked(getSessionGuestSuggestions).mockImplementation(async () => ({
    people: before.filter((b) => !people.some((p) => p.email === b.email)),
  }));
  vi.mocked(getShareLink).mockResolvedValue({ link: null, counts: { messages: 3, toolCalls: 1 } });
  vi.mocked(getSessionGuests).mockImplementation(async () => ({ guests: structuredClone(people) }));
  vi.mocked(inviteSessionGuest).mockImplementation(async (_id, email) => {
    const paula = { ...RAVI, userId: 'u-paula', name: PAULA.name, email: PAULA.email };
    const known = [ALICE, RAVI, paula].find((p) => p.email === email);
    if (!known) throw new ApiError('No Orbit account uses this email.', 404);
    if (!people.some((p) => p.userId === known.userId)) people.push(known);
    return { guests: structuredClone(people) };
  });
  vi.mocked(removeSessionGuest).mockImplementation(async (_id, userId) => {
    people = people.filter((p) => p.userId !== userId);
    return { guests: structuredClone(people) };
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(permissionMode: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ShareModal
            open
            onClose={() => {}}
            kind="SESSION"
            rootId={SESSION}
            guests={{ runnerName: 'build-box', permissionMode }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(section()).not.toBeNull(), { timeout: 10_000 });
  await settle();
}

const section = () => document.body.querySelector<HTMLElement>('section.share-people');
const rows = () =>
  [...section()!.querySelectorAll<HTMLElement>('.share-person')].map((row) => ({
    name: row.querySelector('.share-person-name')?.textContent,
    email: row.querySelector('.share-person-email')?.textContent,
    today: row.querySelector('.share-person-today')?.textContent,
  }));
const inviteButton = () =>
  [...section()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Invite')!;
const consequence = () => section()!.querySelector<HTMLElement>('.share-people-consequence')!;
const acknowledge = () => section()!.querySelector<HTMLElement>('.share-people-ack [role="checkbox"]');

async function type(value: string): Promise<void> {
  const input = section()!.querySelector<HTMLInputElement>('input[type="email"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const emailField = () => section()!.querySelector<HTMLInputElement>('input[type="email"]')!;
const suggestions = () =>
  [...document.body.querySelectorAll<HTMLElement>('.share-suggestion')].map((row) => ({
    name: row.querySelector('.share-suggestion-name')?.innerHTML,
    email: row.querySelector('.share-suggestion-email')?.innerHTML,
    when: row.querySelector('.share-suggestion-when')?.textContent,
  }));
/** A mouse press as a browser delivers it (as MainBranchSelect.test): what opens the list and picks from it. */
async function press(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    element!.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
    element!.dispatchEvent(new MouseEvent('mousedown', init));
    (element as HTMLElement).focus?.();
    element!.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse', isPrimary: true }));
    element!.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    element!.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
}
async function key(name: string): Promise<void> {
  await act(async () => {
    emailField().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  for (const fn of [getShareLink, getSessionGuests, getSessionGuestSuggestions, inviteSessionGuest, removeSessionGuest]) {
    vi.mocked(fn).mockReset();
  }
  for (const fn of Object.values(toast)) fn.mockReset();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('People who can reply', { timeout: 60_000 }, () => {
  it('lists each guest with today’s messages, or that they have not opened it yet', async () => {
    serve([ALICE, RAVI]);
    await open('acceptEdits');
    expect(section()!.querySelector('.share-dialog-label')?.textContent).toBe('People who can reply');
    expect(rows()).toEqual([
      { name: 'Alice Chen', email: 'alice@example.com', today: '12 messages today' },
      { name: 'Ravi Kumar', email: 'ravi@example.com', today: 'Not opened yet' },
    ]);
    // Copy link hands out the one address the session has, which opens for the people listed too (board 11, D8).
    expect(document.body.querySelector('.share-dialog-foot')?.textContent).toContain(
      'Copy link — works for you and the people you invite',
    );
    // With no public link, the Access line says the people below can still open and reply.
    expect(document.body.querySelector('.share-access-detail')?.textContent).toBe(
      'No public link. People you invite below can still open and reply.',
    );
  });

  it('a guest who has not opened it yet, emailed the invitation, reads when the email went out (board 11, D7)', async () => {
    const at = '2026-11-12T02:00:05.000Z';
    serve([{ ...RAVI, emailSentAt: at }]);
    await open('acceptEdits');
    const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    expect(rows()).toEqual([{ name: 'Ravi Kumar', email: 'ravi@example.com', today: `Invited by email · ${clock}` }]);
  });

  it('invites by email: the person joins the list and the field empties', async () => {
    serve([ALICE]);
    await open('acceptEdits');
    expect(inviteButton().disabled).toBe(true);
    await type('ravi@example.com');
    await click(inviteButton(), 'Invite');
    expect(vi.mocked(inviteSessionGuest)).toHaveBeenCalledWith(SESSION, 'ravi@example.com');
    expect(rows().map((r) => r.name)).toEqual(['Alice Chen', 'Ravi Kumar']);
    expect(section()!.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe('');
    expect(section()!.querySelector('[role="alert"]')).toBeNull();
  });

  it('says so when no Orbit account uses the email, and adds nobody', async () => {
    serve([]);
    await open('acceptEdits');
    await type('bob@example.com');
    await click(inviteButton(), 'Invite');
    expect(section()!.querySelector('[role="alert"]')?.textContent).toBe('No Orbit account uses this email.');
    expect(rows()).toEqual([]);
    // Editing the address clears the answer.
    await type('bob@example.co');
    expect(section()!.querySelector('[role="alert"]')).toBeNull();
  });

  it('removes a guest at once', async () => {
    serve([ALICE, RAVI]);
    await open('acceptEdits');
    await click(section()!.querySelector('button[aria-label="Remove Alice Chen"]'), 'Remove Alice Chen');
    expect(vi.mocked(removeSessionGuest)).toHaveBeenCalledWith(SESSION, 'u-alice');
    expect(rows().map((r) => r.name)).toEqual(['Ravi Kumar']);
  });

  it('says where their messages run, in grey, when the session asks before acting', async () => {
    serve([]);
    await open('acceptEdits');
    expect(consequence().textContent).toBe(
      'They can send messages to this session. The agent runs them on build-box as Accept edits, using your accounts. '
        + 'Approvals and the agent’s questions still come only to you.',
    );
    expect(consequence().classList.contains('is-warn')).toBe(false);
    expect(acknowledge()).toBeNull();
  });

  it('in Bypass: the line turns amber, and the first invite needs the tick', async () => {
    serve([]);
    await open('bypassPermissions');
    expect(consequence().classList.contains('is-warn')).toBe(true);
    expect(consequence().textContent).toBe(
      'They can send messages to this session. The agent runs them on build-box as Bypass permissions, using your accounts '
        + '— it won’t ask before acting.',
    );
    expect(section()!.querySelector('.share-people-ack')?.textContent).toBe(
      'I understand the agent won’t ask before acting on their messages',
    );
    await type('alice@example.com');
    expect(inviteButton().disabled).toBe(true);
    await click(acknowledge(), 'the tick');
    expect(acknowledge()!.getAttribute('aria-checked')).toBe('true');
    expect(inviteButton().disabled).toBe(false);
    await click(inviteButton(), 'Invite');
    expect(vi.mocked(inviteSessionGuest)).toHaveBeenCalledWith(SESSION, 'alice@example.com');
    // Once someone is invited, the next invite asks no more; the line stays amber.
    expect(acknowledge()).toBeNull();
    expect(consequence().classList.contains('is-warn')).toBe(true);
  });

  it.each(['auto', 'dontAsk'])('in %s the line is amber too', async (mode) => {
    serve([ALICE]);
    await open(mode);
    expect(consequence().classList.contains('is-warn')).toBe(true);
    // Alice is already invited: no tick to ask for.
    expect(acknowledge()).toBeNull();
  });

  describe('people invited before (board share-links/14)', () => {
    it('clicking the empty field lists them, newest first, with when they were last invited', async () => {
      serve([RAVI], [PAULA, SAM, PAT]);
      await open('auto');
      expect(suggestions()).toEqual([]);
      await press(emailField(), 'the email field');
      expect(document.body.querySelector('.share-suggestion-head')?.textContent).toBe('People you’ve invited before');
      expect(suggestions()).toEqual([
        { name: 'Paula Ortiz', email: 'paula.ortiz@example.com', when: 'Nov 13' },
        { name: 'Sam Wu', email: 'sam@example.org', when: 'Nov 9' },
        { name: 'Pat Lee', email: 'patlee@example.net', when: 'Oct 30' },
      ]);
    });

    it('typing narrows them, in bold; picking one fills the email and invites nobody', async () => {
      serve([], [PAULA, SAM, PAT]);
      await open('auto');
      await press(emailField(), 'the email field');
      await type('pa');
      await settle();
      expect(document.body.querySelector('.share-suggestion-head')).toBeNull();
      expect(suggestions().map((r) => [r.name, r.email])).toEqual([
        ['<b>Pa</b>ula Ortiz', '<b>pa</b>ula.ortiz@example.com'],
        ['<b>Pa</b>t Lee', '<b>pa</b>tlee@example.net'],
      ]);
      await press(document.body.querySelector('.share-suggestion')?.closest('[role="option"]'), 'Paula');
      expect(emailField().value).toBe('paula.ortiz@example.com');
      expect(suggestions()).toEqual([]);
      expect(vi.mocked(inviteSessionGuest)).not.toHaveBeenCalled();
      // In Auto the first invite still needs the tick.
      expect(inviteButton().disabled).toBe(true);
    });

    it('↓ and Enter pick one; with the list closed, Enter invites as before', async () => {
      serve([], [PAULA, SAM]);
      await open('acceptEdits');
      await press(emailField(), 'the email field');
      await type('s');
      await settle();
      expect(suggestions().map((r) => r.when)).toEqual(['Nov 9']);
      await key('ArrowDown');
      await key('Enter');
      expect(emailField().value).toBe('sam@example.org');
      expect(vi.mocked(inviteSessionGuest)).not.toHaveBeenCalled();
      await act(async () => {
        emailField().form!.requestSubmit();
      });
      await settle();
      expect(vi.mocked(inviteSessionGuest)).toHaveBeenCalledWith(SESSION, 'sam@example.org');
    });

    it('someone invited here leaves the suggestions', async () => {
      serve([], [PAULA, SAM]);
      await open('acceptEdits');
      await type('paula.ortiz@example.com');
      await click(inviteButton(), 'Invite');
      expect(rows().map((r) => r.name)).toEqual(['Paula Ortiz']);
      await press(emailField(), 'the email field');
      expect(suggestions().map((r) => r.name)).toEqual(['Sam Wu']);
    });
  });
});
