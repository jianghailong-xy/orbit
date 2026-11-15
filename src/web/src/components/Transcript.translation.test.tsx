// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnTranslation } from '@orbit/shared';

/**
 * Settings › Translation in a conversation (docs/mocks/session-translation/01-board.png, frames 4–6):
 * the owner's message shows what they wrote, the agent's reply its translation, each with a per-message
 * flip to the English; a held message says it is being translated or that it failed (1A), a reply
 * still in English says it will be translated (2A) or that it could not be. Copy copies what is shown.
 */

const copied: string[] = [];
vi.mock('../lib/clipboard', () => ({
  copyText: vi.fn(async (text: string) => {
    copied.push(text);
    return true;
  }),
}));
const { Transcript, QueuedUserTurn, StreamingDraftsCtx } = await import('./Transcript');
const { TranslationCtx } = await import('./TranslationParts');
type RunEvent = import('./Transcript').RunEvent;

const TS = '2026-11-11T10:00:00.000Z';
const ORIGINAL = '登录页在 Safari 上点 Google 登录没反应，帮我查一下原因并修好';
const ENGLISH = 'The Google sign-in button on the login page does nothing in Safari. Find out why and fix it.';
const REPLY_EN = "Found it: Safari blocks popups that aren't opened directly by a click.";
const REPLY_ZH = '原因找到了：Safari 会拦截不是由点击直接触发的弹窗。';

const user = (seq: number, translation?: TurnTranslation, text = ENGLISH): RunEvent => ({
  seq,
  type: 'user',
  turnId: `turn-${seq}`,
  payload: { text, ...(translation ? { translation } : {}) },
  ts: TS,
});
const reply = (seq: number, translation?: unknown): RunEvent => ({
  seq,
  type: 'assistant',
  payload: { text: REPLY_EN, ...(translation ? { translation } : {}) },
  ts: TS,
});
const ended = (seq: number): RunEvent => ({ seq, type: 'turn_end', payload: { subtype: 'success' }, ts: TS });
const done: TurnTranslation = { state: 'DONE', from: 'zh-Hans', original: ORIGINAL };

const actions = {
  on: true,
  retryTurn: vi.fn(async () => undefined),
  sendAsWritten: vi.fn(async () => undefined),
  retryReply: vi.fn(async () => undefined),
};

let container: HTMLDivElement;
let root: Root;

async function draw(node: ReactNode, on = true): Promise<void> {
  await act(async () => {
    root.render(<TranslationCtx.Provider value={{ ...actions, on }}>{node}</TranslationCtx.Provider>);
  });
}

const text = () => container.textContent ?? '';
const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button in: ${text()}`);
  return found;
};
const press = async (label: string) => {
  await act(async () => button(label).click());
};
/** A button in the reply's own foot, not the message's above it. */
const pressReply = async (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('.chat-translate-foot.is-reply button')].find(
    (b) => b.textContent === label,
  )!;
  await act(async () => found.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  copied.length = 0;
  actions.retryTurn.mockClear();
  actions.sendAsWritten.mockClear();
  actions.retryReply.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the owner's message", () => {
  it('shows what they wrote, "Translated · Show original", and flips to the English the agent got', async () => {
    await draw(<Transcript events={[user(1, done)]} />);
    const bubble = container.querySelector('.chat-user')!;
    expect(bubble.textContent).toContain(ORIGINAL);
    expect(bubble.textContent).not.toContain(ENGLISH);
    expect(container.querySelector('.chat-translate-foot')?.textContent).toBe('Translated·Show original');

    await press('Show original');
    expect(container.querySelector('.chat-user')!.textContent).toContain(ENGLISH);
    expect(container.querySelector('.chat-translate-foot')?.textContent).toBe(
      'Sent to the agent in English·Show translation',
    );

    await press('Show translation');
    expect(container.querySelector('.chat-user')!.textContent).toContain(ORIGINAL);
  });

  it('copies the version on screen', async () => {
    await draw(<Transcript events={[user(1, done)]} />);
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-user-meta .chat-copy')!.click());
    expect(copied.at(-1)).toBe(ORIGINAL);
    await press('Show original');
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-user-meta .chat-copy')!.click());
    expect(copied.at(-1)).toBe(ENGLISH);
  });

  it('flips one message, not the others', async () => {
    const other: TurnTranslation = { state: 'DONE', from: 'zh-Hans', original: '再跑一遍全部测试' };
    await draw(<Transcript events={[user(1, done), ended(2), user(3, other, 'Run all the tests again.')]} />);
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.chat-translate-action')[0].click());
    const bubbles = [...container.querySelectorAll('.chat-user')].map((b) => b.textContent);
    expect(bubbles[0]).toContain(ENGLISH);
    expect(bubbles[1]).toContain('再跑一遍全部测试');
  });

  it('a message sent as written, or never translated, has no foot', async () => {
    await draw(
      <Transcript
        events={[user(1, { state: 'SENT_AS_WRITTEN', from: 'zh-Hans', original: ORIGINAL }, ORIGINAL), ended(2), user(3)]}
      />,
    );
    expect(container.querySelector('.chat-translate-foot')).toBeNull();
  });
});

describe("another session's message", () => {
  it('is drawn on its left bubble in the translated words', async () => {
    const card = { fromSessionId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60', fromTitle: 'Worker', fromAgentName: 'orbit' };
    const event = user(1, done);
    await draw(<Transcript events={[{ ...event, payload: { ...event.payload, sessionMessage: card } }]} />);
    const bubble = container.querySelector('.smc-bubble')!;
    expect(bubble.textContent).toContain(ORIGINAL);
    expect(bubble.textContent).not.toContain(ENGLISH);
  });
});

describe('a message held for its translation (queued row)', () => {
  const held = (state: TurnTranslation['state']): RunEvent => ({
    seq: 0,
    type: 'user',
    turnId: 'turn-held',
    payload: { text: '好的，改吧，顺便加个测试', translation: { state, from: 'zh-Hans', original: '好的，改吧，顺便加个测试' } },
    ts: TS,
  });

  it('shows the "Translating…" chip while it is translated', async () => {
    await draw(<QueuedUserTurn event={held('TRANSLATING')} queued={<span />} />);
    expect(container.querySelector('.chat-user')!.textContent).toContain('好的，改吧，顺便加个测试');
    expect(container.querySelector('.chat-translate-chip')?.textContent).toBe('Translating…');
  });

  it("failed: \"Couldn't translate, so it wasn't sent · Retry · Send as written\", each calling its door", async () => {
    await draw(<QueuedUserTurn event={held('FAILED')} queued={<span />} />);
    const foot = container.querySelector('.chat-translate-foot.is-error')!;
    expect(foot.textContent).toBe("Couldn't translate, so it wasn't sent·Retry·Send as written");
    await press('Retry');
    expect(actions.retryTurn).toHaveBeenCalledWith('turn-held');
    await press('Send as written');
    expect(actions.sendAsWritten).toHaveBeenCalledWith('turn-held');
  });
});

describe("the agent's reply", () => {
  it('shows the translation, "Translated · Show original", and flips to the English', async () => {
    await draw(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: REPLY_ZH })]} />);
    expect(container.querySelector('.chat-assistant')!.textContent).toContain(REPLY_ZH);
    const foot = () => container.querySelector('.chat-translate-foot.is-reply')!.textContent;
    expect(foot()).toBe('Translated·Show original');
    await pressReply('Show original');
    expect(container.querySelector('.chat-assistant')!.textContent).toContain(REPLY_EN);
    expect(foot()).toBe('Original·Show translation');
    await pressReply('Show translation');
    expect(container.querySelector('.chat-assistant')!.textContent).toContain(REPLY_ZH);
  });

  it("the turn's copy button copies the reply as shown", async () => {
    await draw(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: REPLY_ZH }), ended(3)]} />);
    const copy = () => container.querySelector<HTMLButtonElement>('.chat-turn-foot .chat-copy')!;
    await act(async () => copy().click());
    expect(copied.at(-1)).toBe(REPLY_ZH);
    await pressReply('Show original');
    await act(async () => copy().click());
    expect(copied.at(-1)).toBe(REPLY_EN);
  });

  it('failed: "Couldn\'t translate this reply · Retry", which retries that reply', async () => {
    await draw(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', failed: true })]} />);
    expect(container.querySelector('.chat-assistant')!.textContent).toContain(REPLY_EN);
    expect(container.querySelector('.chat-translate-foot.is-error')!.textContent).toBe("Couldn't translate this reply·Retry");
    await press('Retry');
    expect(actions.retryReply).toHaveBeenCalledWith(2);
  });

  it('settled but not translated yet, in a translated turn: greyed, "Translates when the reply is done"', async () => {
    await draw(<Transcript events={[user(1, done), reply(2)]} />);
    expect(container.querySelector('.chat-translated-reply.is-pending .chat-assistant')!.textContent).toContain(REPLY_EN);
    expect(container.querySelector('.chat-translate-chip')?.textContent).toBe('Translates when the reply is done');
  });

  it('a turn translation was not involved in is drawn as it always was', async () => {
    await draw(<Transcript events={[user(1), reply(2), ended(3)]} />);
    expect(container.querySelector('.chat-translate-foot')).toBeNull();
    expect(container.querySelector('.chat-translated-reply')).toBeNull();
  });

  it("a sub-agent's report is never translated", async () => {
    const sub: RunEvent = {
      seq: 3,
      type: 'assistant',
      payload: { text: 'sub report', parentToolUseId: 'tool-1', translation: { lang: 'zh-Hans', text: '子报告' } },
      ts: TS,
    };
    await draw(
      <Transcript
        events={[
          user(1, done),
          { seq: 2, type: 'tool_use', payload: { id: 'tool-1', name: 'Task', input: { description: 'x' } }, ts: TS },
          sub,
        ]}
      />,
    );
    expect(text()).not.toContain('子报告');
  });
});

describe('the reply streaming', () => {
  const streaming = (on: boolean) =>
    draw(
      <StreamingDraftsCtx.Provider value={{ text: "I'll move the script load into a useEffect", think: '' }}>
        <Transcript events={[user(1, done)]} />
      </StreamingDraftsCtx.Provider>,
      on,
    );

  it('with translation on: greyed with the chip "Translates when the reply is done"', async () => {
    await streaming(true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
    const pending = container.querySelector('.chat-translated-reply.is-pending')!;
    expect(pending.querySelector('.chat-streaming-md')).not.toBeNull();
    expect(pending.querySelector('.chat-translate-chip')?.textContent).toBe('Translates when the reply is done');
  });

  it('with translation off: the ordinary draft', async () => {
    await streaming(false);
    expect(container.querySelector('.chat-streaming-md')).not.toBeNull();
    expect(container.querySelector('.chat-translated-reply')).toBeNull();
  });
});
