import { useCallback, useState } from 'react';
import type { PickedFolder } from './machineSetup';

const key = (runnerId: string) => `orbit.machineSetup.${runnerId}`;

/** This tab's folder for one machine. */
function read(runnerId: string): PickedFolder | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key(runnerId)) ?? 'null') as { folder?: PickedFolder | null } | null;
    return stored?.folder ?? null;
  } catch {
    return null;
  }
}

function write(runnerId: string, folder: PickedFolder | null): void {
  try {
    if (folder) sessionStorage.setItem(key(runnerId), JSON.stringify({ folder }));
    else sessionStorage.removeItem(key(runnerId));
  } catch {
    // A browser may refuse the store. The answer still holds for as long as this page does.
  }
}

/**
 * The folder a machine's setup card has been given so far. The page is left and come back to on the
 * way (a key is connected on another page, a sign-in is reloaded through), and the answer should not
 * have to be given twice, so it is kept for this tab rather than with the view.
 */
export function useMachineSetup(runnerId: string) {
  const [store, setStore] = useState(() => ({ runnerId, folder: read(runnerId) }));
  // Another machine's page: its answer, in this same render, so one machine's folder is never read
  // as the other's.
  let current = store;
  if (store.runnerId !== runnerId) {
    current = { runnerId, folder: read(runnerId) };
    setStore(current);
  }
  return {
    folder: current.folder,
    pickFolder: useCallback(
      (folder: PickedFolder | null) => {
        setStore((previous) => {
          if (previous.runnerId !== runnerId) return previous;
          write(runnerId, folder);
          return { runnerId, folder };
        });
      },
      [runnerId],
    ),
    /** That machine has a workspace: nothing of its setup is left to remember. */
    finish: useCallback((machine: string) => {
      write(machine, null);
      setStore((previous) => (previous.runnerId === machine ? { runnerId: machine, folder: null } : previous));
    }, []),
  };
}
