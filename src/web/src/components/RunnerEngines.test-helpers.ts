import { act } from 'react';
import { vi } from 'vitest';

/** Open the row's real dropdown, including its portal, before choosing an action. */
export async function openRunnerMenu(row: ParentNode): Promise<HTMLElement> {
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
  if (!trigger) throw new Error('No More actions button on this row');
  await act(async () => {
    document.querySelectorAll<HTMLButtonElement>('.re-more.ant-dropdown-open').forEach((other) => other.click());
  });
  await act(async () => trigger.click());
  let menu: HTMLElement | null = null;
  await act(async () => {
    await vi.waitFor(() => {
      // jsdom cannot finish CSS leave animations. AntD disables pointer events immediately
      // on a closing portal, so ignore it instead of reading the previous account's menu.
      const popup = [...document.querySelectorAll<HTMLElement>('.re-account-menu:not(.ant-dropdown-hidden)')]
        .find((element) => element.style.pointerEvents !== 'none');
      menu = popup?.querySelector<HTMLElement>('[role="menu"]') ?? null;
      if (!menu) throw new Error('Account menu has not opened');
    }, { timeout: 20_000, interval: 20 });
  });
  return menu!;
}

export async function runnerMenuItem(row: ParentNode, label: string): Promise<HTMLElement> {
  const menu = await openRunnerMenu(row);
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === label);
  if (!item) throw new Error(`No ${label} item in ${menu.textContent}`);
  return item;
}

export async function clickRunnerMenuItem(row: ParentNode, label: string) {
  const item = await runnerMenuItem(row, label);
  await act(async () => item.click());
}
