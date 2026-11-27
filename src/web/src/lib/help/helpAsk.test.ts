import { describe, expect, it } from 'vitest';
import { askExchanges, parseAnswer, questionFor, suggestedQuestions } from './helpAsk';

describe('parseAnswer', () => {
  it('reads a source list written without a heading when it closes the answer', () => {
    const parsed = parseAnswer('It sleeps [1].\n\n[1] [A machine shows Offline](orbit:/help/machines-and-engines/a-machine-shows-offline)');
    expect(parsed.sources).toEqual([
      { n: 1, title: 'A machine shows Offline', path: '/help/machines-and-engines/a-machine-shows-offline', slug: 'a-machine-shows-offline' },
    ]);
    expect(parsed.body).toBe('It sleeps [1](cite:1).');
  });

  it('leaves a number no source names as it was, and has no sources when it cites none', () => {
    const parsed = parseAnswer("I don't know: the articles do not say [3].");
    expect(parsed.sources).toEqual([]);
    expect(parsed.body).toBe("I don't know: the articles do not say [3].");
  });

  it('collects each in-app link once as a button and keeps its words in the sentence', () => {
    const parsed = parseAnswer('Open [build-box](orbit:/settings/machines/r1), then [build-box](orbit:/settings/machines/r1) again. See https://x.test.');
    expect(parsed.buttons).toEqual([{ label: 'build-box', href: 'orbit:/settings/machines/r1' }]);
    expect(parsed.body).toBe('Open build-box, then build-box again. See https://x.test.');
  });

  it('a line of in-app links alone becomes the buttons, not text as well', () => {
    const parsed = parseAnswer('It sleeps.\n\n[Open build-box](orbit:/settings/machines/r1) · [Register a machine](orbit:/settings/machines/new)\n\nThat is all.');
    expect(parsed.buttons.map((b) => b.label)).toEqual(['Open build-box', 'Register a machine']);
    expect(parsed.body).toBe('It sleeps.\n\nThat is all.');
  });

  it('reads [1][2] as two citations', () => {
    const parsed = parseAnswer('Run orbit doctor [1][2].\n\nSources:\n[1] [A](orbit:/help/x/a)\n[2] [B](orbit:/help/x/b)');
    expect(parsed.body).toBe('Run orbit doctor [1](cite:1) [2](cite:2).');
  });

  it('takes a bold heading and a list item marker', () => {
    const parsed = parseAnswer('Yes [1].\n\n**Sources:**\n- [1] [Connect a model](orbit:/help/get-started/connect-a-model)');
    expect(parsed.sources.map((s) => s.slug)).toEqual(['connect-a-model']);
    expect(parsed.body).toBe('Yes [1](cite:1).');
  });
});

describe('askExchanges', () => {
  it('pairs each question with its answer, or with why there is none', () => {
    const at = '2026-11-26T00:00:00.000Z';
    const exchanges = askExchanges([
      { role: 'user', text: 'First?', at },
      { role: 'assistant', text: 'First answer', at },
      { role: 'user', text: 'Second?', at },
      { role: 'assistant', text: '', at, error: 'DeepSeek answered 503. Ask again in a moment.' },
      { role: 'user', text: 'Third?', at },
    ]);
    expect(exchanges).toEqual([
      { question: 'First?', index: 0, answer: 'First answer', error: null },
      { question: 'Second?', index: 2, answer: '', error: 'DeepSeek answered 503. Ask again in a moment.' },
      { question: 'Third?', index: 4, answer: '', error: null },
    ]);
  });
});

describe('the suggestions', () => {
  it('asks about an error on the page first, then the page, then what anyone asks', () => {
    expect(questionFor({ title: 'Add a second machine' })).toBe('How do I add a second machine?');
    expect(questionFor({ title: 'A machine shows Offline' })).toBeNull();
    expect(suggestedQuestions({
      errors: ['engine.signed-out'], articles: [{ title: 'Connect a model', errors: ['engine.signed-out'] } as never], pageArticles: [], offlineMachine: null,
    })[0]).toBe('What does "Connect a model" mean?');
    expect(suggestedQuestions({ errors: [], articles: [], pageArticles: [], offlineMachine: null })).toHaveLength(3);
    expect(suggestedQuestions({
      errors: ['runner.offline'], articles: [{ title: 'A machine shows Offline', errors: ['runner.offline'] } as never],
      pageArticles: [{ title: 'A machine shows Offline' } as never, { title: 'Add a second machine' } as never], offlineMachine: 'build-box',
    })).toEqual(['Why is build-box offline?', 'How do I add a second machine?', 'Which engines can run on a Linux server?']);
  });
});
