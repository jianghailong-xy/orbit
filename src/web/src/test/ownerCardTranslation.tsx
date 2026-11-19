// Shared harness for the owner cards' translation tests (board docs/mocks/session-translation/04-owner-cards.html).
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRANSLATION_FAILED_CODE } from '@orbit/shared';
import { ApiError } from '../api';
import { meQuery, type Me } from '../lib/queries';

/** The owner reads French with translation on. */
export const OWNER_LANG = 'fr' as const;

export function ownerMe(over: Partial<NonNullable<Me['preferences']>> = {}): Me {
  return {
    preferences: { translationEnabled: true, translationLanguage: OWNER_LANG, ...over },
    translationAvailable: true,
  } as Me;
}

/** A client whose account cache holds `me`, as the app shell leaves it. */
export function clientWithMe(me: Me | null = ownerMe()): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (me) client.setQueryData(meQuery().queryKey, me);
  return client;
}

/** The refusal an answer door sends when the owner's words could not be translated; `why` is the
 *  TranslationFailedBody's failureReason (and httpStatus), absent for a server that sends none. */
export function translationRefused(why?: { failureReason: string; httpStatus?: number }): ApiError {
  return new ApiError(
    "Couldn't translate",
    422,
    TRANSLATION_FAILED_CODE,
    why ? { code: TRANSLATION_FAILED_CODE, message: "Couldn't translate", ...why } : undefined,
  );
}

/** A jsdom host a card is drawn into, with the presses the tests make. */
export function cardHost() {
  let host: HTMLDivElement;
  let root: Root;
  const h = {
    mount() {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    },
    unmount() {
      act(() => root.unmount());
      host.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    },
    async draw(ui: JSX.Element, client: QueryClient = clientWithMe()) {
      await act(async () => {
        root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
      });
    },
    text(): string {
      return document.body.textContent ?? '';
    },
    el(): HTMLDivElement {
      return host;
    },
    button(label: string): HTMLButtonElement {
      const found = [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
      const button = found[found.length - 1] ?? [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
      if (!button) throw new Error(`no ${label} button in: ${h.text()}`);
      return button as HTMLButtonElement;
    },
    async press(label: string) {
      await act(async () => {
        h.button(label).click();
      });
    },
    async type(value: string, selector = 'textarea') {
      const field = document.body.querySelector(selector) as HTMLTextAreaElement | HTMLInputElement | null;
      if (!field) throw new Error(`no ${selector}`);
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    async until(held: () => boolean, what: string) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (held()) return;
        if (Date.now() >= deadline) throw new Error(`never became true: ${what}; text: ${h.text()}`);
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    },
  };
  return h;
}
