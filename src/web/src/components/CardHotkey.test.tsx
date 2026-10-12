// @vitest-environment jsdom
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApproveHotkey, useCardKeyClaim, useDecisionCardKeys } from './CardHotkey';

/**
 * The keyboard the cards that ask the reader share: which key confirms, whose keyboard is
 * not the cards', and — the half that is a decision rather than a binding — what happens when two
 * cards ask at once.
 *
 * The cards themselves are replaced with probes that report one thing each: where their confirmation
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

/** A confirmation card and its ordinary Chat about this button, drawn as the element its claim
 *  names — or, `anchored={false}`, as a card whose claim names no element at all. */
function Card({
  confirmEnabled = true,
  anchored = true,
  onConfirm,
  onChatAbout,
}: {
  confirmEnabled?: boolean;
  anchored?: boolean;
  onConfirm: () => void;
  onChatAbout: () => void;
}): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useDecisionCardKeys({ confirmEnabled, onConfirm, anchor: anchored ? anchor : undefined });
  return (
    <div ref={anchor} data-card data-keys={String(keys)}>
      <button type="button" onClick={onChatAbout}>Chat about this</button>
    </div>
  );
}

/** The approval card's own trigger, on the same claim — it took Enter first, and it is the reason
 *  the claim is shared rather than per-family. */
function Approve({ active, onApprove }: { active: boolean; onApprove: () => void }): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useCardKeyClaim(active, anchor);
  useApproveHotkey(keys, onApprove, { requireMod: false });
  return <div ref={anchor} data-approve data-keys={String(keys)} />;
}

/** The primary press of the two cards whose answer is hard to take back — `Merge to main` and
 *  `Approve & re-seal` — which take the chord rather than the bare key. */
function Chord({ asking = true, onPress }: { asking?: boolean; onPress: () => void }): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useCardKeyClaim(asking, anchor);
  useApproveHotkey(keys, onPress);
  return <div ref={anchor} data-chord data-keys={String(keys)} />;
}

const keysOf = (scope: ParentNode, selector: string): string[] =>
  [...scope.querySelectorAll<HTMLElement>(selector)].map((el) => el.dataset.keys ?? '');

describe('confirmation keys', () => {
  it('confirms on Enter and leaves both modifier chords unhandled', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);

    key();
    expect(confirm, 'the bare key answers the first way').toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();

    for (const mod of [HINT, CTRL]) {
      key(mod);
      expect(chat, 'Chat about this has no shortcut').not.toHaveBeenCalled();
      expect(confirm, 'the chord did not confirm').toHaveBeenCalledTimes(1);
    }
  });

  it('holds no keys when confirmation is disabled, even while Chat about this can be clicked', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    const node = await mount(<Card confirmEnabled={false} onConfirm={confirm} onChatAbout={chat} />);
    key();
    expect(confirm, 'the first way was dead').not.toHaveBeenCalled();
    key(HINT);
    expect(chat, 'a chord opened Chat about this').not.toHaveBeenCalled();
    expect(keysOf(node, '[data-card]')).toEqual(['false']);
    act(() => node.querySelector('button')?.click());
    expect(chat, 'Chat about this is still clickable').toHaveBeenCalledTimes(1);

    // When confirmation becomes available again, only Enter comes back.
    const second = vi.fn();
    await act(async () =>
      root?.render(<Card onConfirm={second} onChatAbout={chat} />),
    );
    chat.mockClear();
    key(HINT);
    expect(chat, 'Chat about this has no shortcut').not.toHaveBeenCalled();
    key();
    expect(second, 'the first way was live').toHaveBeenCalledTimes(1);
  });

  it('answers neither way when no answer could succeed, and holds no keys to show for one', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    const node = await mount(
      <Card confirmEnabled={false} onConfirm={confirm} onChatAbout={chat} />,
    );
    key();
    key(HINT);
    expect(confirm).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(keysOf(node, '[data-card]')).toEqual(['false']);
  });
});

describe('the keyboard yields to text entry', () => {
  it('answers the card when the focused field is empty', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();

    key();
    expect(confirm).toHaveBeenCalledTimes(1);
    key(HINT);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it('leaves a focused field every key it has once it contains text', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);
    const field = document.createElement('textarea');
    field.value = 'draft';
    document.body.appendChild(field);
    field.focus();

    key();
    key(HINT);
    expect(confirm).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('leaves the bare key to a focused button and does not give Chat about this the chord', async () => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    key();
    expect(confirm, 'a button’s own Enter answers it, not the card').not.toHaveBeenCalled();
    key(HINT);
    expect(chat, 'Chat about this has no shortcut').not.toHaveBeenCalled();
  });
});

describe('the keyboard yields to a focused role that answers Enter', () => {
  /** A focusable element whose `role` promises Enter — a nav row drawn as `role="link"`, a
   *  transcript row's head drawn as `role="button"` — the same case as a native button, spelled as
   *  ARIA rather than a tag. */
  function focusRole(role: string): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('role', role);
    el.tabIndex = 0;
    document.body.appendChild(el);
    el.focus();
    return el;
  }

  it.each(['link', 'button'])('leaves the bare key to a focused role="%s" element, not the card', async (role) => {
    const confirm = vi.fn();
    const chat = vi.fn();
    await mount(<Card onConfirm={confirm} onChatAbout={chat} />);
    focusRole(role);

    key();
    expect(confirm, `a role="${role}" element’s own Enter answers it, not the card`).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('still presses a chord card over a focused role element — the chord is no element’s own', async () => {
    const press = vi.fn();
    await mount(<Chord onPress={press} />);
    focusRole('link');

    key(HINT);
    key(CTRL);
    expect(press, 'the chord stays the card’s over a role element').toHaveBeenCalledTimes(2);
  });
});

describe('several cards asking at once', () => {
  it('gives the keys to the card drawn highest, and walks them down once it stops asking', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const node = await mount(
      <>
        <Card onConfirm={first} onChatAbout={first} />
        <Card onConfirm={second} onChatAbout={second} />
      </>,
    );
    expect(keysOf(node, '[data-card]'), 'one card holds the keys, and it is the top one').toEqual([
      'true',
      'false',
    ]);
    key();
    expect(first, 'the top card was not answered').toHaveBeenCalledTimes(1);
    expect(second, 'one press must not answer two questions').not.toHaveBeenCalled();

    // The first card stops asking — answered at another end, gone stale, or a press of its own in
    // flight — and the keys go to the next one down, which is the whole reason the claim is live
    // rather than settled at mount.
    await act(async () =>
      root?.render(
        <>
          <Card confirmEnabled={false} onConfirm={first} onChatAbout={first} />
          <Card onConfirm={second} onChatAbout={second} />
        </>,
      ),
    );
    expect(keysOf(node, '[data-card]')).toEqual(['false', 'true']);
    key();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ranks the cards by where they are drawn, not by which one asked first', async () => {
    const upper = vi.fn();
    const lower = vi.fn();
    const pair = (upperAsking: boolean): JSX.Element => (
      <>
        <Card confirmEnabled={upperAsking} onConfirm={upper} onChatAbout={upper} />
        <Card onConfirm={lower} onChatAbout={lower} />
      </>
    );
    const node = await mount(pair(false));
    expect(keysOf(node, '[data-card]'), 'the lower card was asking alone').toEqual(['false', 'true']);

    // The card above starts asking after it — its read came back second — and takes the keys.
    await act(async () => root?.render(pair(true)));
    expect(keysOf(node, '[data-card]')).toEqual(['true', 'false']);
    key();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });

  it('ranks a claim that names no element after every card that does', async () => {
    const unplaced = vi.fn();
    const placed = vi.fn();
    const node = await mount(
      <>
        <Card anchored={false} onConfirm={unplaced} onChatAbout={unplaced} />
        <Card onConfirm={placed} onChatAbout={placed} />
      </>,
    );
    expect(keysOf(node, '[data-card]')).toEqual(['false', 'true']);
    key();
    expect(placed).toHaveBeenCalledTimes(1);
    expect(unplaced).not.toHaveBeenCalled();
  });

  it('counts a card that cannot be answered as not asking', async () => {
    const live = vi.fn();
    const dead = vi.fn();
    const node = await mount(
      <>
        <Card confirmEnabled={false} onConfirm={dead} onChatAbout={dead} />
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
    expect(approve, 'the approval card above holds the key').toHaveBeenCalledTimes(1);
    expect(confirm, 'two cards, one key').not.toHaveBeenCalled();
    expect(keysOf(node, '[data-approve]')).toEqual(['true']);
    expect(keysOf(node, '[data-card]')).toEqual(['false']);
  });

  it('leaves the approval card its own keys when it is the only one asking', async () => {
    const approve = vi.fn();
    await mount(<Approve active onApprove={approve} />);
    key();
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe('what a card holds', () => {
  it('is the keys while it is the highest one asking — one at a time, never two', async () => {
    const node = await mount(
      <>
        <Card onConfirm={() => {}} onChatAbout={() => {}} />
        <Card onConfirm={() => {}} onChatAbout={() => {}} />
      </>,
    );
    expect(keysOf(node, '[data-card]')).toEqual(['true', 'false']);
    await act(async () => root?.render(<Card onConfirm={() => {}} onChatAbout={() => {}} />));
    expect(keysOf(node, '[data-card]')).toEqual(['true']);
  });
});

describe('the cards whose answer is hard to take back', () => {
  it('press on ⌘/Ctrl + Enter and leave the bare key alone', async () => {
    const press = vi.fn();
    await mount(<Chord onPress={press} />);
    key();
    expect(press, 'the bare key pressed it').not.toHaveBeenCalled();
    key(HINT);
    key(CTRL);
    expect(press).toHaveBeenCalledTimes(2);
  });

  it('are answered one at a time from the top: the ruler above the merge, then the merge', async () => {
    const ruler = vi.fn();
    const merge = vi.fn();
    const pair = (rulerAsking: boolean): JSX.Element => (
      <>
        <Chord asking={rulerAsking} onPress={ruler} />
        <Chord onPress={merge} />
      </>
    );
    const node = await mount(pair(true));
    expect(keysOf(node, '[data-chord]')).toEqual(['true', 'false']);
    key(HINT);
    expect(ruler).toHaveBeenCalledTimes(1);
    expect(merge, 'one chord answered two cards').not.toHaveBeenCalled();

    await act(async () => root?.render(pair(false)));
    expect(keysOf(node, '[data-chord]')).toEqual(['false', 'true']);
    key(HINT);
    expect(ruler).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledTimes(1);
  });
});

describe('a held key', () => {
  it('is one press: its repeats answer nothing, so it cannot walk on to the next card', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const pair = (firstAsking: boolean): JSX.Element => (
      <>
        <Card confirmEnabled={firstAsking} onConfirm={first} onChatAbout={first} />
        <Card onConfirm={second} onChatAbout={second} />
      </>
    );
    const node = await mount(pair(true));
    key();
    expect(first).toHaveBeenCalledTimes(1);

    // The press is in flight, so the first card stops asking and the keys walk down — under a
    // finger still on the key.
    await act(async () => root?.render(pair(false)));
    expect(keysOf(node, '[data-card]')).toEqual(['false', 'true']);
    key({ repeat: true });
    expect(second, 'a repeat answered the next card').not.toHaveBeenCalled();
    key();
    expect(second, 'a fresh press does').toHaveBeenCalledTimes(1);
  });
});
