// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApproveHotkey, useCardKeyClaim, useDecisionCardKeys } from './CardHotkey';

/**
 * The keyboard the cards that ask the reader share: which key answers which way, whose keyboard is
 * not the cards', and — the half that is a decision rather than a binding — what happens when two
 * cards ask at once.
 *
 * The cards themselves are replaced with probes that report one thing each: where their two answers
 * would go, and whether they hold the keys. The probes read `data-keys` (the same fact the hint is
 * drawn from) rather than the hint, because what the card LOOKS like with the keys is each card's
 * own file's business; what is asserted here is who has them.
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(ui: JSX.Element): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.appendChild(node);
  const nextRoot = createRoot(node);
  container = node;
  root = nextRoot;
  await act(async () => nextRoot.render(ui));
  return node;
}

/** One keypress, as the browser delivers it: on the window, with whatever focus is standing. */
function key(init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
    );
  });
}

const HINT = { metaKey: true };
const CTRL = { ctrlKey: true };

/** A card of the four: two answers, two counters, and what it holds. */
function Card({
  confirmEnabled = true,
  chatEnabled = true,
  onConfirm,
  onChatAbout,
}: {
  confirmEnabled?: boolean;
  chatEnabled?: boolean;
  onConfirm: () => void;
  onChatAbout: () => void;
}): JSX.Element {
  const keys = useDecisionCardKeys({ confirmEnabled, chatEnabled, onConfirm, onChatAbout });
  return <div data-card data-keys={String(keys)} />;
}

/** The approval card's own trigger, on the same claim — it took Enter first, and it is the reason
 *  the claim is shared rather than per-family. */
function Approve({ active, onApprove }: { active: boolean; onApprove: () => void }): JSX.Element {
  const keys = useCardKeyClaim(active);
  useApproveHotkey(keys, onApprove, { requireMod: false });
  return <div data-approve data-keys={String(keys)} />;
}

const keysOf = (scope: ParentNode, selector: string): string[] =>
  [...scope.querySelectorAll<HTMLElement>(selector)].map((el) => el.dataset.keys ?? '');

describe('one card, two answers', () => {
  it('answers the first way on the bare key and the second on the chord, and never both', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);

    key();
    expect(confirm, 'the bare key answers the first way').toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();

    // ⌘ on macOS and Ctrl elsewhere are one chord (`CardHotkey.IS_MAC` spends the difference on the
    // label alone), so both spellings are asserted where both can be sent.
    for (const mod of [HINT, CTRL]) {
      key(mod);
      expect(chat, 'the chord answers the second way').toHaveBeenCalledTimes(1);
      expect(confirm, 'the chord did not also answer the first way').toHaveBeenCalledTimes(1);
      chat.mockClear();
    }
  });

  it('does nothing for an answer whose own button is dead, and still answers the other way', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card confirmEnabled={false} onConfirm={confirm} onChatAbout={chat} />);
    key();
    expect(confirm, 'the first way was dead').not.toHaveBeenCalled();
    key(HINT);
    expect(chat, 'the second way was live').toHaveBeenCalledTimes(1);

    // The other way round, on the same card: the two answers of one card are not dead together.
    const second = vi.fn();
    await act(async () =>
      root?.render(<Card chatEnabled={false} onConfirm={second} onChatAbout={chat} />),
    );
    chat.mockClear();
    key(HINT);
    expect(chat, 'the second way was dead').not.toHaveBeenCalled();
    key();
    expect(second, 'the first way was live').toHaveBeenCalledTimes(1);
  });

  it('answers neither way when no answer could succeed, and holds no keys to show for one', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    const node = await mount(
      <Card confirmEnabled={false} chatEnabled={false} onConfirm={confirm} onChatAbout={chat} />,
    );
    key();
    key(HINT);
    expect(confirm).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(keysOf(node, '[data-card]')).toEqual(['false']);
  });
});

describe('the keyboard is not the card’s while the reader is typing', () => {
  it('leaves a focused field every key it has', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();

    key();
    key(HINT);
    expect(confirm).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('leaves the bare key to a focused button, whose own Enter is the same press, but not the chord', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    key();
    expect(confirm, 'a button’s own Enter answers it, not the card').not.toHaveBeenCalled();
    key(HINT);
    expect(chat, 'no button answers the chord, so it is the card’s').toHaveBeenCalledTimes(1);
  });
});

describe('two cards asking at once', () => {
  it('answers neither, and the survivor once one of them stands down', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const node = await mount(
      <>
        <Card onConfirm={first} onChatAbout={first} />
        <Card onConfirm={second} onChatAbout={second} />
      </>,
    );
    key();
    key(HINT);
    expect(first, 'one press must not answer two questions').not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(keysOf(node, '[data-card]'), 'neither card shows a key it cannot honour').toEqual([
      'false',
      'false',
    ]);

    // The first card stops asking — answered at another end, gone stale, or a press of its own in
    // flight — and the keys go to the one still asking, which is the whole reason the claim is
    // live rather than settled at mount.
    await act(async () =>
      root?.render(
        <>
          <Card confirmEnabled={false} chatEnabled={false} onConfirm={first} onChatAbout={first} />
          <Card onConfirm={second} onChatAbout={second} />
        </>,
      ),
    );
    key();
    expect(second).toHaveBeenCalledTimes(1);
    expect(keysOf(node, '[data-card]')).toEqual(['false', 'true']);
  });

  it('counts a card that cannot be answered as not asking', async () => {
    const live = vi.fn();
    const dead = vi.fn();
    const node = await mount(
      <>
        <Card confirmEnabled={false} chatEnabled={false} onConfirm={dead} onChatAbout={dead} />
        <Card onConfirm={live} onChatAbout={live} />
      </>,
    );
    key();
    expect(live, 'a card with nothing left to press holds nothing back').toHaveBeenCalledTimes(1);
    expect(keysOf(node, '[data-card]')).toEqual(['false', 'true']);
  });

  it('shares the claim with the approval card, which took Enter first', async () => {
    const approve = vi.fn();
    const confirm = vi.fn();
    const node = await mount(
      <>
        <Approve active onApprove={approve} />
        <Card onConfirm={confirm} onChatAbout={confirm} />
      </>,
    );
    key();
    expect(approve, 'two cards, one key').not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(keysOf(node, '[data-approve]')).toEqual(['false']);
  });

  it('leaves the approval card its own keys when it is the only one asking', async () => {
    const approve = vi.fn();
    await mount(<Approve active onApprove={approve} />);
    key();
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe('what a card holds', () => {
  it('is the keys while it is the only one asking — one at a time, never two', async () => {
    const node = await mount(
      <>
        <Card onConfirm={() => {}} onChatAbout={() => {}} />
        <Card onConfirm={() => {}} onChatAbout={() => {}} />
      </>,
    );
    expect(keysOf(node, '[data-card]')).toEqual(['false', 'false']);
    await act(async () => root?.render(<Card onConfirm={() => {}} onChatAbout={() => {}} />));
    expect(keysOf(node, '[data-card]')).toEqual(['true']);
  });
});
