// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPaneSlideOnPopState, navigateWithPaneSlide } from './paneTransition';
import { MOBILE_QUERY } from './useMediaQuery';

/**
 * Which navigations get the push/pop slide, and what the stylesheet is handed to aim it with.
 * The keyframes themselves live in index.css; this pins that the direction reaches them, that
 * the route actually changes inside the transition's callback (an "after" snapshot of the old
 * route would animate one screen to itself), and that every unsupported case still navigates.
 */

/** A phone, unless `reducedMotion` — the two queries paneTransition asks about. */
const stubMedia = (opts: { phone: boolean; reducedMotion?: boolean }): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      query === MOBILE_QUERY
        ? opts.phone
        : query === '(prefers-reduced-motion: reduce)'
          ? !!opts.reducedMotion
          : false,
    media: query,
  }));
};

/** Stands in for the real API: runs the callback, and lets the test settle `finished` by hand. */
const stubViewTransitions = (): { calls: number; finish: () => void } => {
  const state = { calls: 0, finish: () => {} };
  const finished = new Promise<void>((resolve) => {
    state.finish = resolve;
  });
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    writable: true,
    value: (callback: () => void) => {
      state.calls += 1;
      callback();
      return { finished } as ViewTransition;
    },
  });
  return state;
};

beforeEach(() => {
  delete document.documentElement.dataset.paneNav;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.paneNav;
});

describe('navigateWithPaneSlide', () => {
  it('marks the direction while the transition runs, and clears it once it finishes', async () => {
    stubMedia({ phone: true });
    const transition = stubViewTransitions();
    const navigate = vi.fn(() => {
      expect(
        document.documentElement.dataset.paneNav,
        'the stylesheet needs the direction before the "after" snapshot is taken',
      ).toBe('push');
    });

    navigateWithPaneSlide('push', navigate);

    expect(transition.calls).toBe(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.paneNav).toBe('push');

    transition.finish();
    await vi.waitFor(() => expect(document.documentElement.dataset.paneNav).toBeUndefined());
  });

  it('puts the destination pane on screen before the snapshot, in both directions', () => {
    stubMedia({ phone: true });
    stubViewTransitions();
    const split = document.createElement('div');
    split.className = 'workspace-split show-conversation';
    document.body.append(split);
    try {
      // Which pane shows is one class, and the browser photographs the "after" state from this
      // DOM. The router's own commit lands later — rendering is suspended inside the callback —
      // so without this, going back animated the conversation sliding off a copy of itself.
      navigateWithPaneSlide('pop', () => {
        expect(split.className, 'the list must be showing when the snapshot is taken').toBe(
          'workspace-split',
        );
      });
      expect(split.className).toBe('workspace-split');

      navigateWithPaneSlide('push', () => {
        expect(split.className, 'the conversation must be showing by then').toBe(
          'workspace-split show-conversation',
        );
      });
      expect(split.className).toBe('workspace-split show-conversation');
    } finally {
      split.remove();
    }
  });

  it('going back runs the same machinery in the pop direction', () => {
    stubMedia({ phone: true });
    stubViewTransitions();
    navigateWithPaneSlide('pop', vi.fn());
    expect(document.documentElement.dataset.paneNav).toBe('pop');
  });

  it.each([
    ['on desktop, where both panes are on screen at once', { phone: false }],
    ['when the reader asked for reduced motion', { phone: true, reducedMotion: true }],
  ])('navigates without a transition %s', (_case, media) => {
    stubMedia(media);
    const transition = stubViewTransitions();
    const navigate = vi.fn();

    navigateWithPaneSlide('push', navigate);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(transition.calls, 'nothing should animate here').toBe(0);
    expect(document.documentElement.dataset.paneNav).toBeUndefined();
  });

  it('still navigates in a browser without the View Transition API', () => {
    stubMedia({ phone: true });
    const navigate = vi.fn();

    navigateWithPaneSlide('push', navigate);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.paneNav).toBeUndefined();
  });
});

/**
 * The backs the app never issues: browser Back, Android's system back, the edge swipe. They change
 * the URL themselves, so the only thing left to decide is which pane the URL just landed on.
 */
describe('installPaneSlideOnPopState', () => {
  // One listener for the file — installing per test would stack them, and every copy would start
  // its own transition on the same pop.
  beforeAll(() => installPaneSlideOnPopState());

  /** The split as the page has it, showing one pane or the other. */
  const mountSplit = (showing: 'list' | 'conversation'): HTMLDivElement => {
    const split = document.createElement('div');
    split.className = `workspace-split${showing === 'conversation' ? ' show-conversation' : ''}`;
    document.body.append(split);
    return split;
  };

  /**
   * A history move the app didn't make: the URL is already the new one when popstate lands.
   * `uaAnimated` is the flag iOS puts on the pop an edge swipe commits, having drawn the swap
   * itself — jsdom parses the init dict but has no such member, so it is written on by hand.
   */
  const popTo = (path: string, opts: { uaAnimated?: boolean } = {}): void => {
    window.history.pushState({}, '', path);
    const event = new PopStateEvent('popstate');
    if (opts.uaAnimated) Object.defineProperty(event, 'hasUAVisualTransition', { value: true });
    window.dispatchEvent(event);
  };

  it("the browser's own back off a conversation runs the ← button's pop slide", () => {
    stubMedia({ phone: true });
    const transition = stubViewTransitions();
    const split = mountSplit('conversation');
    try {
      popTo('/workspaces/w1');

      expect(transition.calls, 'a back gesture animates like the button does').toBe(1);
      expect(document.documentElement.dataset.paneNav).toBe('pop');
      expect(split.className, 'the list must be showing when the "after" snapshot is taken').toBe(
        'workspace-split',
      );
    } finally {
      split.remove();
    }
  });

  it('a swipe that drew its own swap is not slid a second time', () => {
    stubMedia({ phone: true });
    const transition = stubViewTransitions();
    const split = mountSplit('conversation');
    try {
      popTo('/workspaces/w1', { uaAnimated: true });

      expect(transition.calls, 'the browser has already animated this one').toBe(0);
      expect(document.documentElement.dataset.paneNav).toBeUndefined();
      expect(split.className, 'the live page is the list the swipe was revealing').toBe(
        'workspace-split',
      );
    } finally {
      split.remove();
    }
  });

  it('a swipe the browser animated forward is showing the conversation it revealed', () => {
    stubMedia({ phone: true });
    const transition = stubViewTransitions();
    const split = mountSplit('list');
    try {
      popTo('/sessions/s1', { uaAnimated: true });

      expect(transition.calls).toBe(0);
      expect(split.className).toBe('workspace-split show-conversation');
    } finally {
      split.remove();
    }
  });

  it.each([
    ['a conversation', '/sessions/s1'],
    ['the new-session draft', '/workspaces/w1/new'],
  ])('going forward into %s slides the other way', (_case, path) => {
    stubMedia({ phone: true });
    stubViewTransitions();
    const split = mountSplit('list');
    try {
      popTo(path);

      expect(document.documentElement.dataset.paneNav).toBe('push');
      expect(split.className).toBe('workspace-split show-conversation');
    } finally {
      split.remove();
    }
  });

  it('a pop between two conversations swaps no pane, so nothing animates', () => {
    stubMedia({ phone: true });
    const transition = stubViewTransitions();
    const split = mountSplit('conversation');
    try {
      popTo('/sessions/s2');

      expect(transition.calls).toBe(0);
      expect(document.documentElement.dataset.paneNav).toBeUndefined();
      expect(split.className).toBe('workspace-split show-conversation');
    } finally {
      split.remove();
    }
  });

  it('a pop on a page that has no split at all animates nothing', () => {
    stubMedia({ phone: true });
    const transition = stubViewTransitions();

    popTo('/tasks');

    expect(transition.calls).toBe(0);
    expect(document.documentElement.dataset.paneNav).toBeUndefined();
  });
});
