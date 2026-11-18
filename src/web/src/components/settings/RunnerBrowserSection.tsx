import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RUNNER_BROWSER_COPY as COPY, clearRunnerBrowser, runnerBrowserQuery } from '../../lib/runnerBrowser';
import { useToast } from '../../lib/toast';
import { RunnerBrowserDrawer } from '../RunnerBrowserDrawer';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsBlocks';

/**
 * Settings → Orbit Cloud runner → Browser (docs/runner-browser-design.md §5, board frames 8–9): Open browser, which
 * opens the drawer already in control (opening the viewer's stream is what starts Chrome on the runner), the
 * saved-logins line beside where the owner signs in, and Clear saved logins after a confirmation. Nothing at all
 * while the server reports the browser off (GET /runners/:id/browser answers 404).
 */
export function RunnerBrowserSection({ runnerId }: { runnerId: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, confirmation] = useConfirm();
  const message = useToast();
  const qc = useQueryClient();
  const { data: state } = useQuery(runnerBrowserQuery(runnerId));
  const clear = useMutation({
    mutationFn: () => clearRunnerBrowser(runnerId),
    onSuccess: () => {
      message.success(COPY.clearAsked);
      void qc.invalidateQueries({ queryKey: runnerBrowserQuery(runnerId).queryKey });
    },
    onError: () => message.error(COPY.clearFailed),
  });
  if (!state) return null;

  const status = open
    ? COPY.runningInControl
    : state.state === 'RUNNING'
      ? state.holderTitle
        ? COPY.runningHeldBy(state.holderTitle)
        : COPY.running
      : state.state === 'IDLE'
        ? COPY.idle
        : COPY.unknown;

  return (
    <SettingsSection title={COPY.section} className="machine-section-browser">
      <SettingsCard>
        <SettingsRow
          title={COPY.rowTitle}
          description={status}
          control={
            !open && (
              <Button variant="primary" onClick={() => setOpen(true)}>
                {COPY.openBrowser}
              </Button>
            )
          }
        />
        <SettingsRow title={COPY.savedLogins} description={COPY.savedLoginsLine} />
        <SettingsRow
          title={
            <Button
              variant="link"
              danger
              className="rb-clear"
              loading={clear.isPending}
              onClick={() =>
                void confirm({
                  title: COPY.clearTitle,
                  description: COPY.clearBody,
                  confirmText: COPY.clearConfirm,
                  cancelText: 'Cancel',
                  danger: true,
                  onConfirm: () => clear.mutateAsync().catch(() => {}),
                })
              }
            >
              {COPY.clear}
            </Button>
          }
          description={state.clearRequestedAt ? COPY.clearPending : undefined}
        />
      </SettingsCard>
      {confirmation}
      <RunnerBrowserDrawer
        runnerId={runnerId}
        open={open}
        onClose={() => {
          setOpen(false);
          void qc.invalidateQueries({ queryKey: runnerBrowserQuery(runnerId).queryKey });
        }}
        from="settings"
        state={state}
      />
    </SettingsSection>
  );
}
