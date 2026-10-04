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

async function focusSettlesOn(element: HTMLElement) {
  // Base UI moves initial focus on the next animation frame, across the portal boundary.
  await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(element)); });
}

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('compact review dialogs', () => {
  it.each(['Escape', 'Close button'])('returns focus to the preview after %s without resetting the question', async (dismissal) => {
    const decide = vi.fn();
    await render(<ApprovalPanel approval={question} onDecide={decide} />);
    const trigger = preview();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger.focus());
    await click(trigger);
    const popup = dialog()!;
    expect(host.contains(popup)).toBe(false);
    expect(popup.getAttribute('role')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await focusSettlesOn(popup);
    const field = popup.querySelector<HTMLInputElement>('.chat-q-custom')!;
    await act(async () => field.focus());
    await type(field, 'Keep this draft after dismissal');
    if (dismissal === 'Escape') {
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
    } else {
      await click(close());
    }
    expect(dialog()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await focusSettlesOn(trigger);
    expect(decide).not.toHaveBeenCalled();
    await click(trigger);
    await focusSettlesOn(dialog()!);
    expect(dialog()!.querySelector<HTMLInputElement>('.chat-q-custom')).toBe(field);
    expect(field.value).toBe('Keep this draft after dismissal');
  });

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

  it('leaves Enter to a focused action and ignores repeated or composing shortcuts inside the dialog', async () => {
    const decide = vi.fn();
    await render(<><ApprovalPanel approval={background} active onDecide={decide} />
      <ApprovalPanel approval={plan} active onDecide={decide} /></>);
    await click(preview());
    const popup = dialog()!;
    await focusSettlesOn(popup);
    const reject = popup.querySelector<HTMLButtonElement>('.approval-actions button:last-child')!;
    await act(async () => reject.focus());
    await enter();
    expect(decide).not.toHaveBeenCalled();
    await act(async () => popup.focus());
    for (const state of [{ repeat: true }, { isComposing: true }]) {
      await act(async () => {
        popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...state }));
      });
    }
    expect(decide).not.toHaveBeenCalled();
    await enter();
    expect(decide.mock.calls).toEqual([['ExitPlanMode', 'allow']]);
  });

  it('keeps a plan that becomes stale open while suspending both its keys and background keys', async () => {
    const decide = vi.fn();
    const cards = (answerable: boolean) => <><ApprovalPanel approval={background} active onDecide={decide} />
      <ApprovalPanel approval={plan} active answerable={answerable} onDecide={decide} /></>;
    await render(cards(true));
    await click(preview());
    const popup = dialog()!;
    await render(cards(false));
    expect(dialog()).toBe(popup);
    expect(preview().textContent).toContain('No longer waiting');
    expect(popup.querySelector('.approval-stale')).not.toBeNull();
    expect(popup.querySelector('.approval-kbd')).toBeNull();
    expect([...popup.querySelectorAll<HTMLButtonElement>('.approval-actions button')].every((button) => button.disabled)).toBe(true);
    await enter();
    await enter(true);
    expect(decide).not.toHaveBeenCalled();
    await click(close());
    await act(async () => preview().blur());
    await enter();
    expect(decide.mock.calls).toEqual([['Bash', 'allow']]);
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
