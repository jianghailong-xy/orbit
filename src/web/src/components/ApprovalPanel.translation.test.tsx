// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalTranslation } from '@orbit/shared';
import type { ApprovalInfo } from '../api';
import { ApprovalPanel } from './ApprovalPanel';

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
