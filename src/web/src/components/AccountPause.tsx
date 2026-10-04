import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { Button, InputNumber, Modal, Radio, Tag } from 'antd';
import { api } from '../api';
import { accountIsPaused, pauseRemaining, pauseResumeTime, usePauseClock } from '../lib/accountPause';
import { useToast } from '../lib/toast';

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
      <Tag color={paused ? 'orange' : status.color} title={paused ? `Paused until ${pauseResumeTime(until!, now)}` : status.label}>
        {paused ? `Paused until ${pauseResumeTime(until!, now)}` : status.label}
      </Tag>
      {paused && <div className="account-pause-remaining">{pauseRemaining(until!, now)}{extra && ` · ${extra}`}</div>}
    </div>
  );
}

/** The same timed pause for a runner's account and a member of an account pool. */
export function AccountPauseActions({ name, until, endpoint, shared = false, pool = false }: {
  name: string;
  until?: string | null;
  endpoint: string;
  shared?: boolean;
  pool?: boolean;
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
  return (
    <>
      <span className="account-pause-actions">
        {paused ? (
          <>
            <Button size="small" icon={<PlayCircleOutlined />} loading={pause.isPending} onClick={() => pause.mutate(null)}>Resume Now</Button>
            <Button size="small" type="text" onClick={choose} disabled={pause.isPending}>Change Duration</Button>
          </>
        ) : (
          <Button size="small" icon={<PauseCircleOutlined />} onClick={choose}>Pause…</Button>
        )}
      </span>
      {open && (
        <Modal open width={460} title={paused ? 'Change pause duration' : 'Pause account'} onCancel={() => !pause.isPending && setOpen(false)}
          footer={<><Button disabled={pause.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button type="primary" disabled={!valid} loading={pause.isPending} onClick={() => valid && pause.mutate(minutes!)}>{paused ? 'Update Pause' : 'Pause Account'}</Button></>}>
          <div className="account-pause-name">{name}</div>
          <p className="account-pause-copy">The current turn finishes normally. {pool ? 'Future turns skip this account and use the other available accounts.' : 'Future turns skip this account. Sessions set to this account wait until it resumes, or you choose another account.'}</p>
          {shared && <div className="account-pause-scope">This pauses the account for everyone in this pool.</div>}
          <Radio.Group className="account-pause-durations" value={duration} onChange={(event) => setDuration(event.target.value)} optionType="button" buttonStyle="solid"
            options={[...[1, 2, 4, 8].map((value) => ({ label: `${value}h`, value })), { label: 'Custom', value: 'custom' }]} />
          {duration === 'custom' && <label className="account-pause-custom">Hours<InputNumber aria-label="Pause hours" min={1 / 60} max={168} step={0.5} value={custom} onChange={setCustom} /><span>Up to 168 hours</span></label>}
          <div className="account-pause-preview">{valid ? <>Automatically resumes at <b>{pauseResumeTime(new Date(startedAt + minutes! * 60_000).toISOString(), startedAt)}</b>.</> : 'Enter 1 minute to 168 hours, in whole minutes.'}</div>
        </Modal>
      )}
    </>
  );
}
