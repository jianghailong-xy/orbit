// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalTranslation } from '@orbit/shared';
import { ApiError, decideApproval, listApprovals, type ApprovalInfo } from '../api';
import { useApprovalDecisions } from '../lib/approvalDecisions';
import { ApprovalPanel } from './ApprovalPanel';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  decideApproval: vi.fn(),
  listApprovals: vi.fn(),
}));

/**
 * Settings › Translation (3A): the agent's question cards and options, approval descriptions and plans
 * are shown in the owner's language once the server has translated the card. An answer is sent as
 * shown; the server maps a translated question and label back to the English the engine asked in.
 */

const QUESTIONS = [
  {
    header: 'Fix',
    question: 'Which fix should I make?',
    options: [
      { label: 'Preload the script', description: 'Load it on mount, open the popup on click' },
      { label: 'Leave it', description: 'Change nothing' },
    ],
  },
];
const TRANSLATED: ApprovalTranslation = {
  lang: 'zh-Hans',
  questions: [
    {
      header: '修法',
      question: '要用哪种修法？',
      options: [{ label: '预加载脚本', description: '挂载时加载，点击时打开弹窗' }, { label: '不改', description: '什么都不动' }],
    },
  ],
};

const card = (toolName: string, input: unknown, translation?: ApprovalTranslation): ApprovalInfo =>
  ({
    id: 'ap1',
    sessionId: 's1',
    toolName,
    input,
    status: 'PENDING',
    createdAt: '2026-11-11T10:00:00Z',
    ...(translation ? { translation } : {}),
  }) as ApprovalInfo;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

describe('a translated question card', () => {
  it('shows the translated question, header and options, and answers with what it shows', async () => {
    const onDecide = vi.fn();
    await act(async () =>
      root.render(
        <ApprovalPanel
          approval={card('AskUserQuestion', { questions: QUESTIONS }, TRANSLATED)}
          onDecide={onDecide}
          answerable
        />,
      ),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('要用哪种修法？');
    expect(text).toContain('修法');
    expect(text).toContain('预加载脚本');
    expect(text).toContain('挂载时加载，点击时打开弹窗');
    expect(text).not.toContain('Which fix should I make?');
    expect(text).not.toContain('Preload the script');

    await act(async () => button('预加载脚本').click());
    await act(async () => button('Submit').click());
    expect(onDecide).toHaveBeenCalledWith('ap1', 'allow', { '要用哪种修法？': ['预加载脚本'] });
  });

  it('stays in English until it is translated, and when its translation failed', async () => {
    await act(async () =>
      root.render(<ApprovalPanel approval={card('AskUserQuestion', { questions: QUESTIONS })} onDecide={() => {}} answerable />),
    );
    expect(container.textContent).toContain('Which fix should I make?');
    await act(async () =>
      root.render(
        <ApprovalPanel
          approval={card('AskUserQuestion', { questions: QUESTIONS }, { lang: 'zh-Hans', failed: true })}
          onDecide={() => {}}
          answerable
        />,
      ),
    );
    expect(container.textContent).toContain('Preload the script');
  });
});

describe('a translated approval', () => {
  it("shows a tool card's description in the owner's language", async () => {
    await act(async () =>
      root.render(
        <ApprovalPanel
          approval={card('Bash', { command: 'npm test', description: 'Run the web tests' }, { lang: 'zh-Hans', description: '运行 web 测试' })}
          onDecide={() => {}}
          answerable
        />,
      ),
    );
    expect(container.querySelector('.approval-translated-desc')?.textContent).toBe('运行 web 测试');
  });

  it("shows a plan in the owner's language", async () => {
    await act(async () =>
      root.render(
        <ApprovalPanel
          approval={card('ExitPlanMode', { plan: 'Move the script load.' }, { lang: 'zh-Hans', plan: '把脚本加载挪到挂载时。' })}
          onDecide={() => {}}
          answerable
        />,
      ),
    );
    expect(container.textContent).toContain('把脚本加载挪到挂载时。');
    expect(container.textContent).not.toContain('Move the script load.');
  });
});

/**
 * Settings › Translation (1A, 3A): an answer whose own words the server could not translate is
 * refused 422 TRANSLATION_FAILED and nothing is recorded. The card comes back keeping the answer,
 * with the held message's foot; Retry posts the same decision, Send as written posts it with
 * sendAsWritten. The same as iOS/macOS (`untranslatedDecisions`) and Android (`card-translation-failed`).
 */
describe('an answer refused because it could not be translated', () => {
  const decideMock = vi.mocked(decideApproval);
  const listMock = vi.mocked(listApprovals);
  const QUESTION = card('AskUserQuestion', { questions: QUESTIONS }, TRANSLATED);
  const FOOT = "Couldn't translate, so it wasn't sent·Retry·Send as written";
  const untranslated = () => new ApiError("Couldn't translate the answer", 422, 'TRANSLATION_FAILED');

  function Cards({ initial }: { initial: ApprovalInfo }) {
    const [approvals, setApprovals] = useState<ApprovalInfo[]>([initial]);
    const { decide, untranslated: held } = useApprovalDecisions('s1', setApprovals);
    return (
      <>
        {approvals.map((a) => (
          <ApprovalPanel key={a.id} approval={a} onDecide={decide} untranslated={held[a.id]} answerable />
        ))}
      </>
    );
  }

  const foot = () => container.querySelector('.approval-untranslated');
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await act(async () => Promise.resolve());
  };

  beforeEach(() => {
    decideMock.mockReset();
    listMock.mockReset();
    listMock.mockResolvedValue([QUESTION]);
  });

  async function answerThenRefuse(): Promise<void> {
    decideMock.mockRejectedValueOnce(untranslated());
    await act(async () => root.render(<Cards initial={QUESTION} />));
    await act(async () => button('预加载脚本').click());
    const typed = container.querySelector('.chat-q-custom') as HTMLInputElement;
    expect(typed.value).toBe('');
    await act(async () => button('Submit').click());
    await flush();
  }

  it('keeps the answer on the card with the foot of a held message', async () => {
    await answerThenRefuse();
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(decideMock).toHaveBeenCalledWith('s1', 'ap1', 'allow', undefined, { '要用哪种修法？': ['预加载脚本'] }, undefined, undefined);
    expect(foot()?.textContent).toBe(FOOT);
    expect(button('预加载脚本').className).toContain('is-picked');
    expect(button('Submit').disabled).toBe(false);
  });

  it('keeps a typed answer too', async () => {
    decideMock.mockRejectedValueOnce(untranslated());
    await act(async () => root.render(<Cards initial={QUESTION} />));
    const typed = container.querySelector('.chat-q-custom') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(typed, '先别改，我想想');
      typed.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Submit').click());
    await flush();
    expect(foot()?.textContent).toBe(FOOT);
    expect((container.querySelector('.chat-q-custom') as HTMLInputElement).value).toBe('先别改，我想想');
  });

  // docs/ux/translation-failure-policy.html, frame 7, B column, naming "your answer" as frame 5 shows.
  const REASONS: Array<[Record<string, unknown>, string]> = [
    [{ failureReason: 'TIMEOUT' }, "The translator didn't answer in time, so your answer wasn't sent"],
    [{ failureReason: 'NETWORK' }, "The translator was unreachable, so your answer wasn't sent"],
    [{ failureReason: 'HTTP', httpStatus: 429 }, "The translator was unreachable, so your answer wasn't sent"],
    [{ failureReason: 'HTTP', httpStatus: 502 }, "The translator was unreachable, so your answer wasn't sent"],
    [{ failureReason: 'HTTP', httpStatus: 403 }, "The translator refused the message, so your answer wasn't sent"],
    [{ failureReason: 'TRUNCATED' }, "Too long to translate, so your answer wasn't sent"],
    [{ failureReason: 'MANGLED' }, "The translation came back damaged, so your answer wasn't sent"],
    [{ failureReason: 'EMPTY' }, "The translation came back damaged, so your answer wasn't sent"],
    [{ failureReason: 'UNAVAILABLE' }, "Translation is unavailable right now, so your answer wasn't sent"],
    [{ failureReason: 'NO_KEY' }, "Couldn't translate, so it wasn't sent"],
  ];
  for (const [why, sentence] of REASONS) {
    it(`refused ${String(why.failureReason)}${why.httpStatus ? ` ${String(why.httpStatus)}` : ''}: "${sentence}", then Retry and Send as written`, async () => {
      decideMock.mockRejectedValueOnce(
        new ApiError("Couldn't translate the answer", 422, 'TRANSLATION_FAILED', { code: 'TRANSLATION_FAILED', ...why }),
      );
      await act(async () => root.render(<Cards initial={QUESTION} />));
      await act(async () => button('预加载脚本').click());
      await act(async () => button('Submit').click());
      await flush();
      expect(foot()?.textContent).toBe(`${sentence}·Retry·Send as written`);
      decideMock.mockResolvedValueOnce(QUESTION);
      await act(async () => button('Send as written').click());
      await flush();
      expect(decideMock.mock.calls[1]).toEqual(['s1', 'ap1', 'allow', undefined, { '要用哪种修法？': ['预加载脚本'] }, undefined, undefined, true]);
    });
  }

  it('Retry posts the same decision again', async () => {
    await answerThenRefuse();
    decideMock.mockResolvedValueOnce(QUESTION);
    await act(async () => button('Retry').click());
    await flush();
    expect(decideMock).toHaveBeenCalledTimes(2);
    expect(decideMock.mock.calls[1]).toEqual(['s1', 'ap1', 'allow', undefined, { '要用哪种修法？': ['预加载脚本'] }, undefined, undefined]);
  });

  it('Send as written posts it again with sendAsWritten', async () => {
    await answerThenRefuse();
    decideMock.mockResolvedValueOnce(QUESTION);
    await act(async () => button('Send as written').click());
    await flush();
    expect(decideMock).toHaveBeenCalledTimes(2);
    expect(decideMock.mock.calls[1]).toEqual(['s1', 'ap1', 'allow', undefined, { '要用哪种修法？': ['预加载脚本'] }, undefined, undefined, true]);
  });

  it('a refused Retry keeps the foot; an accepted one clears it', async () => {
    await answerThenRefuse();
    decideMock.mockRejectedValueOnce(untranslated());
    await act(async () => button('Retry').click());
    await flush();
    expect(foot()?.textContent).toBe(FOOT);
    decideMock.mockResolvedValueOnce(QUESTION);
    listMock.mockResolvedValue([]);
    await act(async () => button('Retry').click());
    await flush();
    expect(foot()).toBeNull();
  });

  it("a tool card's Approve is posted again the same way", async () => {
    const tool = card('Bash', { command: 'npm test', description: 'Run the web tests' });
    listMock.mockResolvedValue([tool]);
    decideMock.mockRejectedValueOnce(untranslated());
    await act(async () => root.render(<Cards initial={tool} />));
    await act(async () => button('Approve').click());
    await flush();
    expect(foot()?.textContent).toBe(FOOT);
    decideMock.mockResolvedValueOnce(tool);
    await act(async () => button('Send as written').click());
    await flush();
    expect(decideMock.mock.calls[1]).toEqual(['s1', 'ap1', 'allow', undefined, undefined, undefined, undefined, true]);
  });

  it('any other refusal is what it was: the card comes back fresh, with no foot', async () => {
    decideMock.mockRejectedValueOnce(new ApiError('Internal server error', 500));
    await act(async () => root.render(<Cards initial={QUESTION} />));
    await act(async () => button('预加载脚本').click());
    await act(async () => button('Submit').click());
    await flush();
    expect(listMock).toHaveBeenCalledWith('s1');
    expect(container.textContent).toContain('要用哪种修法？');
    expect(foot()).toBeNull();
    expect(container.textContent).not.toContain("Couldn't translate");
    expect(button('预加载脚本').className).not.toContain('is-picked');
    expect(button('Submit').disabled).toBe(true);
  });

  it('a 422 with another code is not a translation refusal', async () => {
    decideMock.mockRejectedValueOnce(new ApiError('Unprocessable', 422, 'SOMETHING_ELSE'));
    await act(async () => root.render(<Cards initial={QUESTION} />));
    await act(async () => button('预加载脚本').click());
    await act(async () => button('Submit').click());
    await flush();
    expect(foot()).toBeNull();
  });
});
