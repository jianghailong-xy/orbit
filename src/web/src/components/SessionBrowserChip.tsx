import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RUNNER_BROWSER_COPY as COPY, runnerBrowserQuery } from '../lib/runnerBrowser';
import { RunnerBrowserDrawer } from './RunnerBrowserDrawer';

/**
 * The session's Browser chip, in the outputs above the composer (docs/runner-browser-design.md §5, board frame 4):
 * shown only when the server has the browser switch on, the session runs on the account's managed runner, and the
 * runner reports its browser running. The red dot says the picture is live. It opens the drawer view only, a quick
 * look whose Open in new tab and Take control open the browser's own tab.
 */
export function SessionBrowserChip({
  managedRunnerId,
  sessionId,
}: {
  /** The session's runner when it is the account's managed runner, else null: nothing is read or drawn. */
  managedRunnerId: string | null;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: state } = useQuery({ ...runnerBrowserQuery(managedRunnerId ?? ''), enabled: !!managedRunnerId });
  // Off (404) is null; a stopped browser is IDLE; neither draws a chip. An open drawer stays until it is closed.
  if (!managedRunnerId || (state?.state !== 'RUNNING' && !open)) return null;
  return (
    <div className="rb-chip-row">
      <button type="button" className="rb-chip" onClick={() => setOpen(true)}>
        <span className="rb-chip-dot" aria-hidden />
        {COPY.chip}
      </button>
      <RunnerBrowserDrawer
        runnerId={managedRunnerId}
        open={open}
        onClose={() => setOpen(false)}
        sessionId={sessionId}
        state={state}
      />
    </div>
  );
}
