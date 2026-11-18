import { DownOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  RUNNER_UPDATE_CHANGE,
  RUNNER_UPDATE_LATER,
  RUNNER_UPDATE_POSTPONE_FAILED,
  runnerUpdatePostponedToast,
} from '../lib/runnerCopy';
import { runnerUpdateClock } from '../lib/runnerUpdateCard';
import { postponeRunnerUpdate, runnerUpdateLaterOptions } from '../lib/runnerUpdateLater';
import { useToast } from '../lib/toast';
import { Button } from './ui/Button';
import { Menu } from './ui/Menu';

/**
 * Later ▾ (board 3 ⑦): put the update a runner drains for off for an hour, until tonight 02:00 or
 * until tomorrow 09:00. The runner ends its drain at once; the lists refetch so what waited starts.
 * `change` draws it as the postponed card's Change ▾.
 */
export function RunnerUpdateLaterMenu({ runnerId, change = false }: { runnerId: string; change?: boolean }) {
  const qc = useQueryClient();
  const message = useToast();
  // The times are read when the menu opens, so `until 12:57` is an hour from that press.
  const [now, setNow] = useState(() => new Date());
  const postpone = useMutation({
    mutationFn: (until: Date) => postponeRunnerUpdate(runnerId, until),
    onSuccess: (answer) => {
      message.success(runnerUpdatePostponedToast(runnerUpdateClock(answer.until)));
      void qc.invalidateQueries({ queryKey: ['runners'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(RUNNER_UPDATE_POSTPONE_FAILED, e.message),
  });
  const items = runnerUpdateLaterOptions(now).map((option) => ({
    key: option.key,
    textValue: option.label,
    label: (
      <span className="runner-update-later-item">
        <span>{option.label}</span>
        <span className="runner-update-later-time">{option.detail}</span>
      </span>
    ),
    onSelect: () => postpone.mutate(option.until),
  }));
  return (
    <Menu
      align="start"
      items={items}
      onOpenChange={(open: boolean) => open && setNow(new Date())}
      trigger={
        <Button className="runner-update-later" loading={postpone.isPending}>
          {change ? RUNNER_UPDATE_CHANGE : RUNNER_UPDATE_LATER} <DownOutlined aria-hidden="true" />
        </Button>
      }
    />
  );
}
