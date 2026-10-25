import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { api } from '../api';
import { accountIsPaused, pauseRemaining, pauseResumeTime, usePauseClock } from '../lib/accountPause';
import { useToast } from '../lib/toast';
import { Badge, type BadgeProps } from './ui/Badge';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { NumberInput } from './ui/NumberInput';
import { Radio, RadioGroup } from './ui/Radio';

// A status colour as the status helpers name it (lib/providerPools memberStatus, RunnerEngines), as a
// badge tone: the preset colours draw as themselves, `processing` in the primary colour.
const TONES: Record<string, BadgeProps['tone']> = {
  green: 'green', orange: 'orange', red: 'red', gold: 'gold', blue: 'blue', processing: 'info', default: 'default',
};
export const statusTone = (color: string): BadgeProps['tone'] => TONES[color] ?? 'default';

const DURATIONS = [1, 2, 4, 8] as const;

export function AccountPauseStatus({ until, now, status, detail, className = '' }: {
  until?: string | null;
  className?: string;
  detail?: string;
  now: number;
  status: { label: string; color: string };
}) {
  const paused = accountIsPaused(until, now);
  const extra = detail ?? (status.label === 'Available' ? null : status.label);
  return (
    <div className={`re-status ${className}`.trim()}>
      <Badge tone={statusTone(paused ? 'orange' : status.color)} title={paused ? `Paused until ${pauseResumeTime(until!, now)}` : status.label}>
        {paused ? `Paused until ${pauseResumeTime(until!, now)}` : status.label}
      </Badge>
      {paused && <div className="account-pause-remaining">{pauseRemaining(until!, now)}{extra && ` · ${extra}`}</div>}
    </div>
  );
}

export interface AccountPauseControls {
  paused: boolean;
  pending: boolean;
  choose: () => void;
  resume: () => void;
}

/** The same timed pause for a runner's account and a member of an account pool. */
export function AccountPauseActions({ name, until, endpoint, shared = false, pool = false, children }: {
  name: string;
  until?: string | null;
  endpoint: string;
  shared?: boolean;
  pool?: boolean;
  children?: (controls: AccountPauseControls) => ReactNode;
}) {
  const now = usePauseClock(until);
  const paused = accountIsPaused(until, now);
  const [open, setOpen] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now);
  const [duration, setDuration] = useState<number | 'custom'>(2);
  const [custom, setCustom] = useState<number | null>(3);
  const qc = useQueryClient();
  const message = useToast();
  const hours = duration === 'custom' ? custom : duration;
  const minutes = hours === null ? null : Math.round(hours * 60);
  const valid = hours !== null && Number.isFinite(hours) && minutes !== null &&
    Math.abs(hours * 60 - minutes) < 0.00001 && minutes >= 1 && minutes <= 10_080;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setStartedAt(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);
  const pause = useMutation({
    mutationFn: (durationMinutes: number | null) => api(endpoint, { method: 'POST', body: { durationMinutes } }),
    onSuccess: (_, durationMinutes) => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: [pool ? 'providers' : 'runners'] });
      message.success(durationMinutes === null ? `${name} resumed` : `${name} paused`);
    },
    onError: (error: Error) => { message.error("Couldn't update the account pause", error.message); },
  });
  const choose = () => { setStartedAt(Date.now()); setDuration(2); setCustom(3); setOpen(true); };
  const resume = () => pause.mutate(null);
  return (
    <>
      {children ? children({ paused, pending: pause.isPending, choose, resume }) : <span className="account-pause-actions">
        {paused ? (
          <>
            <Button size="small" icon={<PlayCircleOutlined />} loading={pause.isPending} onClick={resume}>Resume Now</Button>
            <Button size="small" variant="text" onClick={choose} disabled={pause.isPending}>Change Duration</Button>
          </>
        ) : (
          <Button size="small" icon={<PauseCircleOutlined />} onClick={choose}>Pause…</Button>
        )}
      </span>}
      {open && (
        <Dialog open width={460} className="account-pause-dialog" title={paused ? 'Change pause duration' : 'Pause account'} onClose={() => !pause.isPending && setOpen(false)}
          footer={<><Button disabled={pause.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!valid} loading={pause.isPending} onClick={() => valid && pause.mutate(minutes!)}>{paused ? 'Update Pause' : 'Pause Account'}</Button></>}>
          <div className="account-pause-name">{name}</div>
          <p className="account-pause-copy">The current turn finishes normally. {pool ? 'Future turns skip this account and use the other available accounts.' : 'Future turns skip this account. Sessions set to this account wait until it resumes, or you choose another account.'}</p>
          {shared && <div className="account-pause-scope">This pauses the account for everyone in this pool.</div>}
          <RadioGroup<number | 'custom'> className="account-pause-durations" aria-label="Pause for" variant="button" buttonStyle="solid" value={duration} onValueChange={setDuration}>
            {DURATIONS.map((value) => <Radio key={value} value={value}>{`${value}h`}</Radio>)}
            <Radio value="custom">Custom</Radio>
          </RadioGroup>
          {duration === 'custom' && <label className="account-pause-custom">Hours<NumberInput aria-label="Pause hours" min={1 / 60} max={168} step={0.5} value={custom} onValueChange={setCustom} /><span>Up to 168 hours</span></label>}
          <div className="account-pause-preview">{valid ? <>Automatically resumes at <b>{pauseResumeTime(new Date(startedAt + minutes! * 60_000).toISOString(), startedAt)}</b>.</> : 'Enter 1 minute to 168 hours, in whole minutes.'}</div>
        </Dialog>
      )}
    </>
  );
}
