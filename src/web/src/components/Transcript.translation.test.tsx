// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BilingualPair, TurnTranslation } from '@orbit/shared';

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
/** The shared pairing cases (@orbit/shared bilingual-pairs.fixture.json). */
const bilingualFixture = (
  JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/bilingual-pairs.fixture.json'), 'utf8')) as {
    cases: Array<{ name: string; translation: string; original: string; pairs: BilingualPair[] | null }>;
  }
).cases;
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
  it('shows what they wrote, "Show original", and flips to the English the agent got', async () => {
    await draw(<Transcript events={[user(1, done)]} />);
    const bubble = container.querySelector('.chat-user')!;
    expect(bubble.textContent).toContain(ORIGINAL);
    expect(bubble.textContent).not.toContain(ENGLISH);
    expect(container.querySelector('.chat-translate-foot')?.textContent).toBe('Show original');

    await press('Show original');
    expect(container.querySelector('.chat-user')!.textContent).toContain(ENGLISH);
    expect(container.querySelector('.chat-translate-foot')?.textContent).toBe('Show translation');

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

  it('puts the flip at the end of the last line, hidden until hovered unless the original shows', async () => {
    await draw(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: REPLY_ZH })]} />);
    const tail = () => container.querySelector('.chat-assistant p .chat-translate-foot.is-tail')!;
    expect(tail().closest('p')!.textContent).toBe(`${REPLY_ZH}Translated·Show original`);
    expect(tail().classList.contains('is-flipped')).toBe(false);
    await pressReply('Show original');
    expect(tail().closest('p')!.textContent).toBe(`${REPLY_EN}Original·Show translation`);
    expect(tail().classList.contains('is-flipped')).toBe(true);
  });

  it('ends a closing list item; after a code block, a line of its own', async () => {
    await draw(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: '步骤：\n\n- 构建\n- 测试' })]} />);
    expect(container.querySelector('.chat-assistant li:last-child .chat-translate-foot.is-tail')!.closest('li')!.textContent)
      .toBe('测试Translated·Show original');
    await act(async () => root.unmount());
    root = createRoot(container);
    await draw(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: '如下：\n\n```\nfail\n```' })]} />);
    expect(container.querySelector('.chat-assistant .md-tail-block > .chat-translate-foot.is-tail')).not.toBeNull();
    expect(container.querySelector('.chat-assistant p .chat-translate-foot')).toBeNull();
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

  it('already in the owner\'s language: the reply alone, no foot and no "Translates when the reply is done"', async () => {
    // The translator hands back the reply itself, spaces aside.
    await draw(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: `${REPLY_EN}\n` }), ended(3)]} />);
    expect(container.querySelector('.chat-assistant')!.textContent).toContain(REPLY_EN);
    expect(container.querySelector('.chat-translate-foot')?.classList.contains('is-reply') ?? false).toBe(false);
    expect(container.querySelector('.chat-translated-reply')).toBeNull();
    expect(container.querySelector('.chat-translate-chip')).toBeNull();
    expect(text().split(REPLY_EN).length - 1).toBe(1);
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

/**
 * "Show both languages" (docs/mocks/session-translation/02-bilingual.png, 03-interleaved.png): your
 * language on top, the English the agent read or wrote under it. A reply whose blocks pair is drawn
 * block by block, each original right under its translation and never collapsed; one that does not
 * pair is drawn whole under a dashed divider as before, its English over six lines collapsing to a
 * two-line preview with "Show English · N lines". Off, everything above holds unchanged.
 */
describe('Show both languages', () => {
  const both = async (node: ReactNode, bilingual = true) => {
    await act(async () => {
      root.render(<TranslationCtx.Provider value={{ ...actions, on: true, bilingual }}>{node}</TranslationCtx.Provider>);
    });
  };
  // Nine source lines of English prose, and a code block that is drawn once, above.
  const LONG_EN = [
    'Done. The popup now opens synchronously on click:',
    '1. The script preloads on page load in a useEffect;',
    '2. The click handler no longer awaits before signInWithPopup;',
    '```ts',
    'useEffect(() => { void loadGoogleScript(); }, []);',
    '```',
    '3. A new LoginPage.safari.test.tsx covers this case.',
    'All tests pass.',
    'The fix is on the branch.',
    'Safari keeps blocking popups that are opened after an await.',
    'Chrome and Firefox were never affected.',
    'Want me to open a pull request?',
  ].join('\n');
  const LONG_ZH = '改好了。现在弹窗在点击时同步打开。';
  const longReply = (seq: number): RunEvent => ({
    seq,
    type: 'assistant',
    payload: { text: LONG_EN, translation: { lang: 'zh-Hans', text: LONG_ZH } },
    ts: TS,
  });

  it("the owner's message: what they wrote on top, the English under it, \"Sent to the agent in English\"", async () => {
    await both(<Transcript events={[user(1, done)]} />);
    const bubble = container.querySelector('.chat-user')!;
    expect(bubble.firstElementChild?.textContent ?? bubble.textContent).toContain(ORIGINAL);
    expect(bubble.querySelector('.chat-bilingual')?.textContent).toContain(ENGLISH);
    expect(bubble.textContent!.indexOf(ORIGINAL)).toBeLessThan(bubble.textContent!.indexOf(ENGLISH));
    expect(container.querySelector('.chat-translate-foot')?.textContent).toBe('Sent to the agent in English·Hide original');
    // Shown on hover with copy and time, it ends the row, flush with the bubble.
    expect(container.querySelector('.chat-user-meta')!.lastElementChild?.className).toBe('chat-translate-foot is-hover');
    // Copy still copies their language.
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-user-meta .chat-copy')!.click());
    expect(copied.at(-1)).toBe(ORIGINAL);
  });

  it('your message\'s "Hide original" leaves what you wrote alone, and "Show both" brings the English back', async () => {
    await both(<Transcript events={[user(1, done)]} />);
    const press = () => container.querySelector<HTMLButtonElement>('.chat-user-meta .chat-translate-action')!;
    expect(press().textContent).toBe('Hide original');
    await act(async () => press().click());
    const bubble = container.querySelector('.chat-user')!;
    expect(bubble.textContent).toContain(ORIGINAL);
    expect(bubble.querySelector('.chat-bilingual')).toBeNull();
    expect(container.querySelector('.chat-translate-foot')?.textContent).toBe('Sent to the agent in English·Show both');
    await act(async () => press().click());
    expect(container.querySelector('.chat-user .chat-bilingual')?.textContent).toContain(ENGLISH);
  });

  it('a reply already in the owner\'s language is drawn once, with no "Hide original"', async () => {
    await both(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: REPLY_EN }), ended(3)]} />);
    expect(container.querySelector('.chat-bilingual-original')).toBeNull();
    expect(container.querySelector('.chat-translate-foot.is-reply')).toBeNull();
    expect(text().split(REPLY_EN).length - 1).toBe(1);
  });

  it('a short reply: the translation, its English right under it, "Translated" and no flip', async () => {
    await both(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: REPLY_ZH }), ended(3)]} />);
    const pair = container.querySelector('.chat-interleaved .chat-interleaved-pair')!;
    expect(pair.textContent).toContain(REPLY_ZH);
    expect(pair.querySelector('.chat-bilingual-original')!.textContent).toBe(REPLY_EN);
    expect(pair.textContent!.indexOf(REPLY_ZH)).toBeLessThan(pair.textContent!.indexOf(REPLY_EN));
    expect(container.querySelector('.chat-bilingual-reply')).toBeNull();
    expect(container.querySelector('.chat-translate-foot.is-reply')!.textContent).toBe('Translated·Hide original');
    expect(text()).not.toContain('Show English');
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-turn-foot .chat-copy')!.click());
    expect(copied.at(-1)).toBe(REPLY_ZH);
  });

  it('a reply\'s "Hide original" leaves the translation alone, and "Show both" brings it back', async () => {
    await both(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', text: REPLY_ZH }), ended(3)]} />);
    const press = () => container.querySelector<HTMLButtonElement>('.chat-translate-foot.is-reply .chat-translate-action')!;
    expect(press().textContent).toBe('Hide original');
    await act(async () => press().click());
    const shown = container.querySelector('.chat-translated-reply')!;
    expect(shown.textContent).toContain(REPLY_ZH);
    expect(shown.textContent).not.toContain(REPLY_EN);
    expect(container.querySelector('.chat-bilingual-original')).toBeNull();
    expect(container.querySelector('.chat-translate-foot.is-reply')!.textContent).toBe('Translated·Show both');
    await act(async () => press().click());
    expect(container.querySelector('.chat-bilingual-original')!.textContent).toBe(REPLY_EN);
  });

  // The reply on the board (03-interleaved.png, frames 2 and 3).
  const BOARD = bilingualFixture.find((c) => c.name.startsWith('headings and bullet lists'))!;
  const MERGED = bilingualFixture.find((c) => c.name.includes('merged two paragraphs'))!;
  const CODE = bilingualFixture.find((c) => c.name.startsWith('code blocks'))!;
  const fixtureReply = (seq: number, c: (typeof bilingualFixture)[number]): RunEvent => ({
    seq,
    type: 'assistant',
    payload: { text: c.original, translation: { lang: 'zh-Hans', text: c.translation } },
    ts: TS,
  });

  it('a reply that pairs is drawn block by block: each item, heading and paragraph with its original under it, never collapsed', async () => {
    await both(<Transcript events={[user(1, done), fixtureReply(2, BOARD)]} />);
    const pairs = [...container.querySelectorAll('.chat-interleaved-pair')];
    expect(pairs.map((p) => p.className.replace('chat-interleaved-pair is-', ''))).toEqual(BOARD.pairs!.map((p) => p.kind));
    pairs.forEach((p, i) => {
      expect(p.querySelector('.chat-bilingual-original')!.textContent).toBe(
        BOARD.pairs![i].original!.replace(/\*\*|`/g, ''),
      );
    });
    // An item's original sits inside its own list item, under its words.
    const item = pairs[2].querySelector('li')!;
    expect(item.firstElementChild!.textContent).toContain('main 尚未更新');
    expect(item.lastElementChild!.className).toBe('chat-bilingual-original');
    // A heading's original is drawn under it, lighter.
    expect(pairs[5].querySelector('h2')!.textContent).toBe('升级');
    expect(pairs[5].querySelector('.chat-bilingual-original')!.className).toBe('chat-bilingual-original is-heading');
    // Inline code stays code, in both languages.
    expect(pairs[2].querySelectorAll('code')).toHaveLength(2);
    // No divider, no collapse, the one foot.
    expect(container.querySelector('.chat-translated-reply .chat-bilingual')).toBeNull();
    expect(text()).not.toContain('Show English');
    expect(container.querySelector('.chat-translate-foot.is-reply')!.textContent).toBe('Translated·Hide original');
  });

  it('code blocks and tables are drawn once, from the translation, between the pairs', async () => {
    await both(<Transcript events={[user(1, done), fixtureReply(2, CODE)]} />);
    expect(container.querySelectorAll('.chat-interleaved pre')).toHaveLength(2);
    expect(container.querySelectorAll('.chat-interleaved table')).toHaveLength(1);
    expect(text()).not.toContain('Platform');
    expect(container.querySelector('.chat-interleaved-pair.is-quote blockquote .chat-bilingual-original')!.textContent).toBe(
      'Note: it needs a restart.',
    );
  });

  it('a reply whose blocks do not pair is drawn whole, translation over the English under the divider (frame 4)', async () => {
    await both(<Transcript events={[user(1, done), fixtureReply(2, MERGED)]} />);
    expect(container.querySelector('.chat-interleaved')).toBeNull();
    const english = container.querySelector('.chat-bilingual-reply .chat-bilingual')!;
    expect(english.textContent).toContain('The original has three paragraphs.');
    expect(english.textContent).toContain("So this message falls back to today's layout.");
    expect(container.querySelector('.chat-assistant')!.textContent).toContain('所以这一条按今天的方式显示。');
    expect(container.querySelector('.chat-translate-foot.is-reply')!.textContent).toBe('Translated·Hide original');
  });

  it('a long reply that does not pair still collapses to "Show English · N lines", which opens it in place; code is not repeated', async () => {
    await both(<Transcript events={[user(1, done), longReply(2)]} />);
    const english = () => container.querySelector('.chat-bilingual-reply .chat-bilingual')!;
    expect(english().classList.contains('is-collapsed')).toBe(true);
    expect(english().textContent).not.toContain('loadGoogleScript(); }');
    const more = button('Show English · 10 lines');
    await act(async () => more.click());
    expect(english().classList.contains('is-collapsed')).toBe(false);
    expect(english().textContent).toContain('Want me to open a pull request?');
    expect(text()).not.toContain('Show English');
  });

  it('names the agent language when agents work in another one ("Agents work in")', async () => {
    await act(async () => {
      root.render(
        <TranslationCtx.Provider value={{ ...actions, on: true, bilingual: true, agentLanguage: 'ja' }}>
          <Transcript events={[user(1, done), longReply(2)]} />
        </TranslationCtx.Provider>,
      );
    });
    expect(container.querySelector('.chat-user .chat-translate-foot, .chat-user-meta .chat-translate-foot')?.textContent).toBe('Sent to the agent in Japanese·Hide original');
    expect(container.querySelector('.chat-bilingual-reply .chat-bilingual')!.getAttribute('lang')).toBe('ja');
    button('Show Japanese · 10 lines');
    expect(text()).not.toContain('Show English');
  });

  it('held, failed and pending states draw as before, with no English block', async () => {
    await both(<Transcript events={[user(1, done), reply(2, { lang: 'zh-Hans', failed: true }), ended(3), user(4, done), reply(5)]} />);
    expect(container.querySelector('.chat-translate-foot.is-error')!.textContent).toBe("Couldn't translate this reply·Retry");
    expect(container.querySelector('.chat-translate-chip')?.textContent).toBe('Translates when the reply is done');
    expect(container.querySelectorAll('.chat-bilingual-reply')).toHaveLength(0);
    await both(<QueuedUserTurn event={{ seq: 0, type: 'user', turnId: 't', payload: { text: 'x', translation: { state: 'TRANSLATING', from: 'zh-Hans', original: 'x' } }, ts: TS }} queued={<span />} />);
    expect(container.querySelector('.chat-bilingual')).toBeNull();
    expect(container.querySelector('.chat-translate-chip')?.textContent).toBe('Translating…');
  });

  it('off: one language and the Show original flips, exactly as before', async () => {
    await both(<Transcript events={[user(1, done), longReply(2)]} />, false);
    expect(container.querySelector('.chat-bilingual')).toBeNull();
    expect(container.querySelector('.chat-user .chat-translate-foot, .chat-user-meta .chat-translate-foot')?.textContent).toBe('Show original');
    expect(container.querySelector('.chat-translate-foot.is-reply')!.textContent).toBe('Translated·Show original');
    expect(text()).not.toContain(LONG_EN.split('\n')[0]);
  });
});
