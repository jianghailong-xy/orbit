import { createContext, useContext } from 'react';

/**
 * What the Scheduled page gives its chat: opening a schedule's row in the inspector (a change line's name, its Open),
 * which also closes the slide-over where the page is narrow. Absent outside the Scheduled page's chat, where a
 * change line navigates to the page as before.
 */
export interface ScheduleChatHost {
  openSchedule: (scheduleId: string) => void;
  /** One of this account's schedules in the page's current list, by id; null for any other id. */
  find: (scheduleId: string) => { id: string; title: string; state: string } | null;
}
export const ScheduleChatHostContext = createContext<ScheduleChatHost | null>(null);
export const useScheduleChatHost = (): ScheduleChatHost | null => useContext(ScheduleChatHostContext);
