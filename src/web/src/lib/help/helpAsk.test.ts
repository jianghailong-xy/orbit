import { describe, expect, it } from 'vitest';
import type { HelpAskChoices } from '@orbit/shared';
import { askExchanges, defaultAskPick, parseAnswer, questionFor, suggestedQuestions, toolLine } from './helpAsk';

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

describe('toolLine', () => {
  it('counts the articles read, not the index, and names the state checked', () => {
    expect(toolLine([
      { name: 'Read', about: 'help-ask/INDEX.md' },
      { name: 'Read', about: 'get-started/connect-a-model.md' },
      { name: 'help_machines', about: 'machines' },
      { name: 'help_quota', about: 'quota' },
    ])).toBe('Read 1 article · Checked machines, quota');
    expect(toolLine([{ name: 'Grep', about: 'offline' }])).toBe('Searched the articles');
  });
});

describe('askExchanges', () => {
  it('splits the conversation at each question and keeps the last answer of each', () => {
    const exchanges = askExchanges([
      { seq: 4, type: 'assistant', payload: { text: 'Second answer' } },
      { seq: 1, type: 'user', payload: { text: 'First?' } },
      { seq: 2, type: 'assistant', payload: { text: 'Let me look.' } },
      { seq: 2.5, type: 'tool_use', payload: { name: 'mcp__orbit__help_tasks', input: {} } },
      { seq: 2.7, type: 'assistant', payload: { text: 'First answer' } },
      { seq: 3, type: 'user', payload: { text: 'Second?' } },
    ]);
    expect(exchanges.map((e) => [e.question, e.answer, e.tools.map((t) => t.name)])).toEqual([
      ['First?', 'First answer', ['help_tasks']],
      ['Second?', 'Second answer', []],
    ]);
  });
});

describe('the picker and the suggestions', () => {
  const machine = (id: string, over: Partial<HelpAskChoices['machines'][number]> = {}) => ({
    id, name: id, online: true, supported: true, engines: [{ engine: 'claude', label: 'Claude Code', askable: true, model: null }], ...over,
  });

  it('starts on the remembered pick while it can answer, else the first machine that can', () => {
    const choices: HelpAskChoices = { machines: [machine('a'), machine('b')], remembered: { runnerId: 'b', engine: 'claude' } };
    expect(defaultAskPick(choices)).toEqual({ runnerId: 'b', engine: 'claude' });
    expect(defaultAskPick({ ...choices, machines: [machine('a'), machine('b', { online: false })] })).toEqual({ runnerId: 'a', engine: 'claude' });
    expect(defaultAskPick({ machines: [machine('a', { supported: false })], remembered: null })).toBeNull();
  });

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
