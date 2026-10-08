import { act } from 'react';
import { vi } from 'vitest';
import { ACCOUNT_ENGINES } from '../lib/engineAccounts';

/** Open these runners' cards, and every engine's accounts on them: the page as a user who opened them
 *  sees it. Both start folded, and the section remembers the open ones in localStorage. */
export function openRunnerCards(runners: readonly { id: string }[]) {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  localStorage.setItem(
    'orbit:providers-open-accounts',
    JSON.stringify(runners.flatMap((r) => ACCOUNT_ENGINES.map((engine) => `${r.id}/${engine}`))),
  );
}

/** Open the row's real menu, including its portal, before choosing an action. */
export async function openRunnerMenu(row: ParentNode): Promise<HTMLElement> {
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
  if (!trigger) throw new Error('No More actions button on this row');
  // Another account's menu still open closes first, as a click on this row's button would close it.
  await act(async () => {
    document.querySelectorAll<HTMLButtonElement>('button[aria-label="More actions"][aria-expanded="true"]').forEach((other) => {
      if (other !== trigger) other.click();
    });
  });
  if (trigger.getAttribute('aria-expanded') !== 'true') await act(async () => trigger.click());
  let menu: HTMLElement | null = null;
  await act(async () => {
    await vi.waitFor(() => {
      // The menu this button opened: the one open menu, named by its button.
      menu = document.querySelector<HTMLElement>(`[role="menu"][aria-labelledby="${trigger.id}"]`);
      if (!menu || trigger.getAttribute('aria-expanded') !== 'true') throw new Error('Account menu has not opened');
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

/** A dialog's name and description, as assistive technology reads them: a confirmation's popup is a
 *  dialog named by its question. */
export const dialogName = (dialog: Element) =>
  document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent ?? undefined;
export const dialogDescription = (dialog: Element) =>
  document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent ?? undefined;

/** The open dialog named `name`, once it is drawn (a portal, a few frames late on a slow host). */
export async function openDialog(name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await act(async () => {
    await vi.waitFor(() => {
      found = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
        .find((dialog) => dialogName(dialog) === name);
      if (!found) throw new Error(`No "${name}" dialog is open`);
    }, { timeout: 20_000, interval: 20 });
  });
  return found!;
}
