// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryReplyTranslation, retryTurnTranslation, sendTurnAsWritten } from '../api';
import { currentPromptSuggestion } from './promptSuggestion';
import { queuedTurnEvent } from './acceptedUserTurn';
import {
  foldTranslationEvent,
  heldForTranslation,
  shownQuestions,
  translationOn,
  translationTag,
  turnTranslationOf,
} from './translation';

describe('the composer tag (6A)', () => {
  it('reads "<Language> → English", the language without its parenthesis', () => {
    expect(translationTag('zh-Hans')).toBe('Chinese → English');
    expect(translationTag('zh-Hant')).toBe('Chinese → English');
    expect(translationTag('ja')).toBe('Japanese → English');
    expect(translationTag('de')).toBe('German → English');
  });
});

describe('whether the account translates now', () => {
  const me = (translationEnabled: boolean | undefined, translationAvailable: boolean | undefined) => ({
    id: 'u',
    email: 'e',
    name: 'n',
    createdAt: '',
    preferences: translationEnabled === undefined ? {} : { translationEnabled },
    translationAvailable,
  });
  it('needs the switch on and the server able to', () => {
    expect(translationOn(me(true, true))).toBe(true);
    expect(translationOn(me(undefined, true))).toBe(false);
    expect(translationOn(me(false, true))).toBe(false);
    expect(translationOn(me(true, false))).toBe(false);
    expect(translationOn(me(true, undefined))).toBe(false);
  });
});

describe('a live translation event', () => {
  const events = [
    { seq: 4, type: 'user', payload: { text: 'go' } },
    { seq: 5, type: 'assistant', payload: { text: 'Done.' } },
  ];
  it('is folded into the event it translates, as a replay carries it', () => {
    const next = foldTranslationEvent(events, { of: 5, lang: 'zh-Hans', text: '完成。' })!;
    expect(next[1].payload).toEqual({ text: 'Done.', translation: { lang: 'zh-Hans', text: '完成。' } });
    expect(events[1].payload).toEqual({ text: 'Done.' });
    const failed = foldTranslationEvent(next, { of: 5, lang: 'zh-Hans', failed: true })!;
    expect(failed[1].payload.translation).toEqual({ lang: 'zh-Hans', failed: true });
  });
  it('changes nothing for an event outside the window or a payload it cannot read', () => {
    expect(foldTranslationEvent(events, { of: 9, lang: 'zh-Hans', text: 'x' })).toBeNull();
    expect(foldTranslationEvent(events, { of: 5, lang: 'xx', text: 'x' })).toBeNull();
    expect(foldTranslationEvent(events, null)).toBeNull();
  });
});

describe("a turn's translation", () => {
  it('reads the wire shape and nothing else', () => {
    expect(turnTranslationOf({ state: 'DONE', from: 'ja', original: 'こんにちは' })).toEqual({
      state: 'DONE',
      from: 'ja',
      original: 'こんにちは',
    });
    expect(turnTranslationOf({ state: 'WHAT', from: 'ja', original: 'x' })).toBeUndefined();
    expect(turnTranslationOf(undefined)).toBeUndefined();
  });
  it('holds the message while TRANSLATING or FAILED only', () => {
    expect(heldForTranslation({ state: 'TRANSLATING', from: 'ja', original: 'x' })).toBe(true);
    expect(heldForTranslation({ state: 'FAILED', from: 'ja', original: 'x' })).toBe(true);
    expect(heldForTranslation({ state: 'DONE', from: 'ja', original: 'x' })).toBe(false);
    expect(heldForTranslation(undefined)).toBe(false);
  });
  it('rides a queued row onto the event its bubble is drawn from', () => {
    const translation = { state: 'FAILED' as const, from: 'zh-Hans' as const, original: '再跑一遍' };
    const event = queuedTurnEvent({ turnId: 't', content: '再跑一遍', translation });
    expect((event.payload as { translation?: unknown }).translation).toEqual(translation);
  });
});

describe('question cards (3A)', () => {
  const questions = [
    {
      question: 'Which fix?',
      header: 'Fix',
      options: [{ label: 'Preload', description: 'Load on mount' }, { label: 'Leave it' }],
      multiSelect: false,
    },
  ];
  it('show the translated question, header, labels and descriptions, index for index', () => {
    const shown = shownQuestions(questions, {
      lang: 'zh-Hans',
      questions: [{ question: '用哪种修法？', header: '修法', options: [{ label: '预加载', description: '挂载时加载' }, { label: '不改' }] }],
    });
    expect(shown).toEqual([
      {
        question: '用哪种修法？',
        header: '修法',
        options: [{ label: '预加载', description: '挂载时加载' }, { label: '不改' }],
        multiSelect: false,
      },
    ]);
  });
  it('stay in English when the card was not, or could not be, translated', () => {
    expect(shownQuestions(questions, undefined)).toEqual(questions);
    expect(shownQuestions(questions, { lang: 'zh-Hans', failed: true })).toEqual(questions);
  });
});

describe('Suggested replies (3A)', () => {
  it('offer the translation once there is one', () => {
    expect(
      currentPromptSuggestion([
        { type: 'turn_end', payload: {} },
        { type: 'prompt_suggestion', payload: { text: 'Run the tests', translation: { lang: 'zh-Hans', text: '跑一下测试' } } },
      ]),
    ).toBe('跑一下测试');
    expect(currentPromptSuggestion([{ type: 'prompt_suggestion', payload: { text: 'Run the tests' } }])).toBe(
      'Run the tests',
    );
  });
});

describe('the translation doors (A1, A2)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const calls = () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const requested = (fetchMock: ReturnType<typeof calls>) =>
    fetchMock.mock.calls.map((call) => {
      const [url, init] = call as unknown as [string, RequestInit | undefined];
      return [String(url), init?.method];
    });

  it('Retry and Send as written post to the held turn', async () => {
    const fetchMock = calls();
    await retryTurnTranslation('s1', 't1');
    await sendTurnAsWritten('s1', 't1');
    expect(requested(fetchMock)).toEqual([
      ['/api/sessions/s1/turns/t1/translation/retry', 'POST'],
      ['/api/sessions/s1/turns/t1/translation/send-as-written', 'POST'],
    ]);
  });

  it("a reply's Retry posts to its event", async () => {
    const fetchMock = calls();
    await retryReplyTranslation('s1', 42);
    expect(requested(fetchMock)).toEqual([['/api/sessions/s1/events/42/translation/retry', 'POST']]);
  });
});
