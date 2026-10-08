// @vitest-environment jsdom
import type { MouseEvent as ReactMouseEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { foldFromAnywhere } from './foldHead';

/**
 * A fold head folds from a press anywhere on it — docs/mocks/providers-group-row-click — but not
 * from its own controls, not from what it only hears through a portal, and not from a press that
 * ended a drag across its words.
 */

/** A head as the Providers page draws one: its toggle, its words, a link and a field of its own, and
 *  a panel opened under it. Heard natively, which hands the rule what React would: the press, and
 *  the head it was heard on. */
function mountHead(controls?: string) {
  const el = document.createElement('div');
  el.innerHTML =
    '<button class="toggle">HPC</button><span class="summary">1 of 4 signed in</span>' +
    '<a class="manage">Manage →</a><input><div class="panel"><span class="words">Account name</span></div>';
  document.body.appendChild(el);
  const toggle = vi.fn();
  el.addEventListener('click', (event) => foldFromAnywhere(toggle, controls)(event as unknown as ReactMouseEvent<HTMLElement>));
  const press = (selector?: string) =>
    (selector ? el.querySelector(selector)! : el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { el, toggle, press };
}

afterEach(() => {
  getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('a fold head', () => {
  it('folds from its words and from its blank, once a press', () => {
    const { toggle, press } = mountHead();
    press('.summary');
    press();
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('leaves its own controls to themselves — the toggle presses itself', () => {
    const { toggle, press } = mountHead();
    press('.toggle');
    press('.manage');
    press('input');
    expect(toggle).not.toHaveBeenCalled();
  });

  it('leaves alone whatever else its caller names, such as a panel opened under it', () => {
    const plain = mountHead();
    plain.press('.words');
    expect(plain.toggle).toHaveBeenCalledTimes(1);

    const withPanel = mountHead('button, a, input, .panel');
    withPanel.press('.words');
    expect(withPanel.toggle).not.toHaveBeenCalled();
  });

  it('does not fold for a press it only hears through a portal', () => {
    const { el } = mountHead();
    const dialog = document.body.appendChild(document.createElement('div'));
    const toggle = vi.fn();
    foldFromAnywhere(toggle)({ target: dialog, currentTarget: el } as unknown as ReactMouseEvent<HTMLElement>);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('does not fold for a press that ended a drag across its words', () => {
    const { el, toggle, press } = mountHead();
    const words = document.createRange();
    words.selectNodeContents(el.querySelector('.summary')!);
    getSelection()!.addRange(words);
    press('.summary');
    expect(toggle).not.toHaveBeenCalled();

    getSelection()!.removeAllRanges();
    press('.summary');
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
