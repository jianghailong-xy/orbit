import { useCallback, useState } from 'react';
import type { PickedFolder } from './machineSetup';

/** A first message waiting for a machine's two steps (board rule 6). What a send needs and nothing
 *  that dies with the page: files are on the control plane already, so they wait as their ids. */
export interface HeldMessage {
  content: string;
  shell?: boolean;
  attachments?: { id: string; mime: string; name?: string }[];
  /** Why the last send of it was refused: it waits for the person, not for another try by itself. */
  error?: string;
}

export interface MachineSetupState {
  folder: PickedFolder | null;
  held: HeldMessage | null;
}

const EMPTY: MachineSetupState = { folder: null, held: null };
const key = (runnerId: string) => `orbit.machineSetup.${runnerId}`;

/** This tab's answers for one machine. Tab-scoped on purpose: a message waiting in two tabs would be
 *  sent by both, and each send makes a workspace. */
function read(runnerId: string): MachineSetupState {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key(runnerId)) ?? 'null') as Partial<MachineSetupState> | null;
    return stored ? { folder: stored.folder ?? null, held: stored.held ?? null } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function write(runnerId: string, state: MachineSetupState): void {
  try {
    if (state.folder || state.held) sessionStorage.setItem(key(runnerId), JSON.stringify(state));
    else sessionStorage.removeItem(key(runnerId));
  } catch {
    // A browser may refuse the store. The answers still hold for as long as this page does.
  }
}

/**
 * What a machine's new session page has been told so far: the folder and the message waiting on it.
 * The page is left and come back to on the way (a key is connected on another page, a sign-in is
 * reloaded through), and neither answer should have to be given twice, so they are kept for this tab
 * rather than with the view.
 */
export function useMachineSetup(runnerId: string) {
  const [store, setStore] = useState(() => ({ runnerId, state: read(runnerId) }));
  // Another machine's page: its answers, in this same render, so one machine's message is never read
  // against the other's folder.
  let current = store;
  if (store.runnerId !== runnerId) {
    current = { runnerId, state: read(runnerId) };
    setStore(current);
  }
  const update = useCallback(
    (change: (state: MachineSetupState) => MachineSetupState) => {
      setStore((previous) => {
        if (previous.runnerId !== runnerId) return previous;
        const state = change(previous.state);
        write(runnerId, state);
        return { runnerId, state };
      });
    },
    [runnerId],
  );
  return {
    folder: current.state.folder,
    held: current.state.held,
    pickFolder: useCallback((folder: PickedFolder | null) => update((s) => ({ ...s, folder })), [update]),
    hold: useCallback((held: HeldMessage) => update((s) => ({ ...s, held })), [update]),
    /** The send of what is waiting was refused: say why, and send nothing more until asked. */
    failHeld: useCallback(
      (error: string) => update((s) => (s.held ? { ...s, held: { ...s.held, error } } : s)),
      [update],
    ),
    retryHeld: useCallback(
      () => update((s) => (s.held ? { ...s, held: { ...s.held, error: undefined } } : s)),
      [update],
    ),
    withdraw: useCallback(() => update((s) => ({ ...s, held: null })), [update]),
    /** That machine has a workspace: nothing of its setup is left to remember. Named, because a send
     *  can come back to a page that has moved on to another machine, and it is the sender's setup that
     *  ended. */
    finish: useCallback((machine: string) => {
      write(machine, EMPTY);
      setStore((previous) => (previous.runnerId === machine ? { runnerId: machine, state: EMPTY } : previous));
    }, []),
  };
}
