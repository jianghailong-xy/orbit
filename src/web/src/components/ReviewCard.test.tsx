// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from './ApprovalPanel';
import type { ApprovalInfo } from '../api';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.head.querySelectorAll('[data-review-test-style]').forEach((style) => style.remove());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

const approval = (toolName: string, input: unknown): ApprovalInfo => ({ id: toolName, toolName, input }) as ApprovalInfo;
const question = approval('AskUserQuestion', { questions: [{
  question: 'Which branch should receive the change?',
  options: [{ label: 'Main' }, { label: 'Release' }],
}] });
const plan = approval('ExitPlanMode', { plan: '# The plan\n\n' + 'Review this step.\n\n'.repeat(100) });
const background = approval('Bash', { command: 'pwd' });

async function render(ui: ReactNode) {
  await act(async () => root.render(ui));
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

const preview = () => host.querySelector<HTMLButtonElement>('.review-card-preview')!;
const dialog = () => document.querySelector<HTMLElement>('.review-card-dialog[data-open]');
const close = () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;

async function enter(ctrlKey = false) {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey, bubbles: true })); });
}

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('compact review dialogs', () => {
  it('keeps approval actions out of the conversation until the reader opens the plan', async () => {
    const decide = vi.fn();
    await render(<ApprovalPanel approval={plan} active onDecide={decide} />);
    expect(preview().textContent).toContain('The plan');
    expect(host.querySelector('.approval-actions')).toBeNull();
    expect(dialog()).toBeNull();
    await enter();
    await enter(true);
    expect(decide).not.toHaveBeenCalled();
    await click(preview());
    expect(dialog()!.textContent).toContain('Approve & run');
    await enter();
    expect(decide).toHaveBeenCalledWith('ExitPlanMode', 'allow');
    await click(close());
    await enter();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('keeps selected options and typed answers when a question is closed and reopened', async () => {
    const decide = vi.fn();
    await render(<ApprovalPanel approval={question} onDecide={decide} />);
    await click(preview());
    await click(dialog()!.querySelector<HTMLButtonElement>('.chat-q-opt-btn')!);
    await click(close());
    await click(preview());
    expect(dialog()!.querySelector('.chat-q-opt-btn.is-picked')!.textContent).toBe('Main');
    await type(dialog()!.querySelector<HTMLInputElement>('.chat-q-custom')!, 'Use the staging branch');
    await click(close());
    await click(preview());
    expect(dialog()!.querySelector<HTMLInputElement>('.chat-q-custom')!.value).toBe('Use the staging branch');
    const submit = dialog()!.querySelector<HTMLButtonElement>('.approval-actions button')!;
    await click(submit);
    expect(decide).toHaveBeenCalledWith('AskUserQuestion', 'allow', {
      'Which branch should receive the change?': ['Use the staging branch'],
    });
  });

  it('reflects a question becoming stale while closed without discarding the draft', async () => {
    const decide = vi.fn();
    await render(<ApprovalPanel approval={question} onDecide={decide} />);
    await click(preview());
    await type(dialog()!.querySelector<HTMLInputElement>('.chat-q-custom')!, 'Keep this note');
    await click(close());
    await render(<ApprovalPanel approval={question} onDecide={decide} answerable={false} />);
    expect(preview().textContent).toContain('No longer waiting');
    await click(preview());
    expect(dialog()!.querySelector<HTMLInputElement>('.chat-q-custom')!.value).toBe('Keep this note');
    expect([...dialog()!.querySelectorAll<HTMLButtonElement>('.approval-actions button')].every((button) => button.disabled)).toBe(true);
    await enter();
    expect(decide).not.toHaveBeenCalled();
  });

  it('suspends background hotkeys even when the open question has no shortcut', async () => {
    const decide = vi.fn();
    await render(<><ApprovalPanel approval={background} active onDecide={decide} />
      <ApprovalPanel approval={question} onDecide={decide} /></>);
    await click(preview());
    await enter();
    await enter(true);
    expect(decide).not.toHaveBeenCalled();
    await click(close());
    preview().blur();
    await enter();
    expect(decide).toHaveBeenCalledWith('Bash', 'allow');
  });

  it('gives the open plan its shortcut ahead of a background card', async () => {
    const decide = vi.fn();
    await render(<><ApprovalPanel approval={background} active onDecide={decide} />
      <ApprovalPanel approval={plan} active onDecide={decide} /></>);
    await click(preview());
    await enter();
    expect(decide.mock.calls).toEqual([['ExitPlanMode', 'allow']]);
  });

  it('closes the dialog before moving a question to the conversation composer', async () => {
    const chat = vi.fn();
    await render(<ApprovalPanel approval={question} onDecide={() => {}} onChatAbout={chat} />);
    await click(preview());
    await click(dialog()!.querySelector<HTMLButtonElement>('.approval-actions button:last-child')!);
    expect(dialog()).toBeNull();
    expect(chat).toHaveBeenCalledWith('AskUserQuestion', 'Which branch should receive the change?');
  });

  it('scrolls the details independently of the action row', async () => {
    const style = document.createElement('style');
    style.dataset.reviewTestStyle = '';
    style.textContent = readFileSync('src/components/ReviewCard.css', 'utf8');
    document.head.append(style);
    await render(<ApprovalPanel approval={plan} onDecide={() => {}} />);
    await click(preview());
    const body = dialog()!.querySelector<HTMLElement>('.approval-body')!;
    const actions = dialog()!.querySelector<HTMLElement>('.approval-actions')!;
    expect(body.contains(actions)).toBe(false);
    expect(body.parentElement).toBe(actions.parentElement);
    expect(getComputedStyle(body).overflow).toBe('auto');
    expect(parseFloat(getComputedStyle(body).minHeight)).toBe(0);
    expect(getComputedStyle(actions).flex).toBe('0 0 auto');
  });
});
