import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runnersQuery } from '../lib/queries';
import { MachineEngines, accountsGroup, useOpenAccounts } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * Every runner's engine rows (MachineEngines), each in the card a machine's page draws them in: what
 * the engine-row specs render now that no page lists every machine's rows at once. Each machine keeps
 * its own open sign-in panel, as its page does, and the open groups of accounts are the shared ones
 * (useOpenAccounts).
 */
export function EngineRows() {
  const runners = (useQuery(runnersQuery()).data ?? []) as Runner[];
  const [openAccounts, foldAccounts] = useOpenAccounts();
  const [signIn, setSignIn] = useState<Record<string, string | null>>({});
  return (
    <>
      {runners.map((runner) => (
        <div key={runner.id} className={`re-card re-runner-card machine-engines${runner.online ? '' : ' offline'}`}>
          <MachineEngines
            runner={runner}
            signIn={signIn[runner.id] ?? null}
            onSignIn={(panel) => setSignIn((prev) => ({ ...prev, [runner.id]: panel }))}
            openAccounts={openAccounts}
            onFoldAccounts={(engine, open) => foldAccounts(accountsGroup(runner.id, engine), open)}
            fleet={runners}
          />
        </div>
      ))}
    </>
  );
}
