import { useQuery } from '@tanstack/react-query';
import { MACHINE_RESOURCES_CAPABILITY, type RunnerResourceSample, type RunnerResourcesAnswer } from '@orbit/shared';
import { api } from '../../api';
import { formatDiskGb, type RunnerDisk } from '../../lib/runnerAttention';
import {
  RUNNER_CPU_ONE_CORE,
  RUNNER_DISK,
  RUNNER_RESOURCES,
  RUNNER_RESOURCES_CPU,
  RUNNER_RESOURCES_DISK_ONLY,
  RUNNER_RESOURCES_LIVE,
  RUNNER_RESOURCES_MEMORY,
  RUNNER_RESOURCES_MEMORY_FULL,
  RUNNER_RESOURCES_NO_READING,
  RUNNER_RESOURCES_OFFLINE,
  RUNNER_RESOURCES_UPDATE,
  runnerCpuCores,
  runnerCpuLoad,
  runnerDiskFree,
  runnerDiskUsed,
  runnerResourcesLastReading,
  runnerResourcesPredates,
} from '../../lib/runnerCopy';
import { ago } from '../../lib/runnerEngines';
import { Badge } from '../ui/Badge';
import { SettingsSection } from './SettingsBlocks';

const HOUR = 60 * 60_000;
/** Samples further apart than this are drawn as a break: the machine was not heard in between. */
const GAP_MS = 90_000;
/** How often the section asks again while the machine is online: its heartbeat's own period. */
export const MACHINE_RESOURCES_POLL_MS = 30_000;
/** Memory and disk from here on are drawn amber. CPU is not: an agent at work fills it. */
const FULL_PERCENT = 90;
const MIB = 1024 * 1024;

/** `8 cores · load 3.0`, either part left out when the machine gave none. */
function cpuDetail(cores: number | null, load1: number | null): string {
  return [
    ...(cores ? [cores === 1 ? RUNNER_CPU_ONE_CORE : runnerCpuCores(String(cores))] : []),
    ...(load1 !== null ? [runnerCpuLoad(load1.toFixed(1))] : []),
  ].join(' · ');
}

const pct = (used: number, total: number) => Math.min(100, Math.max(0, Math.round((used / total) * 100)));

/** The last hour of one figure, as a line under its tile. Breaks where the machine went unheard. */
function Sparkline({ samples, pick, endMs }: { samples: RunnerResourceSample[]; pick: (s: RunnerResourceSample) => number | null; endMs: number }) {
  const W = 240;
  const H = 44;
  const startMs = endMs - HOUR;
  const runs: [number, number][][] = [];
  let prevAt = -Infinity;
  for (const s of samples) {
    const at = Date.parse(s.at);
    const v = pick(s);
    if (!Number.isFinite(at) || at < startMs || v === null) {
      prevAt = -Infinity;
      continue;
    }
    const point: [number, number] = [((at - startMs) / HOUR) * W, H - (Math.min(100, Math.max(0, v)) / 100) * H];
    if (at - prevAt > GAP_MS || runs.length === 0) runs.push([point]);
    else runs[runs.length - 1].push(point);
    prevAt = at;
  }
  return (
    <svg className="machine-res-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line className="machine-res-spark-top" x1="0" x2={W} y1={H * 0.1} y2={H * 0.1} />
      {runs.map((run, i) => {
        const line = run.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
        const first = run[0][0].toFixed(1);
        const last = run[run.length - 1][0].toFixed(1);
        return (
          <g key={i}>
            {run.length > 1 && <polygon className="machine-res-spark-area" points={`${first},${H} ${line} ${last},${H}`} />}
            {run.length > 1 ? (
              <polyline className="machine-res-spark-line" points={line} />
            ) : (
              <circle className="machine-res-spark-dot" cx={run[0][0]} cy={run[0][1]} r="1.5" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

interface Tile {
  key: 'cpu' | 'mem' | 'disk';
  label: string;
  percent: number | null;
  detail: string;
  warn: boolean;
  note?: string;
  /** The runner is too old to report this figure. */
  update?: string;
  pick: (s: RunnerResourceSample) => number | null;
}

/**
 * The machine's CPU, memory and disk (docs/mocks/runner-resource-monitor): the latest reading, large, and its last
 * hour under it. Read from GET /runners/:id/resources every heartbeat while the machine is online. A runner that
 * does not declare machine-resources/v1 has only the disk its workspaces' probes measured, which is `workspaceDisk`.
 */
export function MachineResources({
  runnerId,
  online,
  capabilities,
  workspaceDisk,
  reserveMb,
  nowMs,
}: {
  runnerId: string;
  online: boolean;
  capabilities: readonly string[] | null | undefined;
  workspaceDisk: RunnerDisk | null;
  reserveMb: number | null;
  nowMs: number;
}) {
  const reports = !!capabilities?.includes(MACHINE_RESOURCES_CAPABILITY);
  const answer = useQuery({
    queryKey: ['runner-resources', runnerId],
    queryFn: () => api<RunnerResourcesAnswer>(`/runners/${runnerId}/resources`),
    enabled: reports,
    refetchInterval: online ? MACHINE_RESOURCES_POLL_MS : false,
  }).data;
  const latest = reports ? answer?.latest ?? null : null;
  const samples = reports ? answer?.samples ?? [] : [];
  const at = reports ? answer?.at ?? null : null;
  const endMs = online || !at ? nowMs : Date.parse(at);

  const cpu = latest?.cpuPercent ?? null;
  const memTotal = latest?.memTotalBytes ?? null;
  const memAvail = latest?.memAvailableBytes ?? null;
  const mem = memTotal && memAvail !== null ? pct(memTotal - memAvail, memTotal) : null;

  // The machine's own reading of the disk when it gives one; the workspaces' probes otherwise.
  const disk: RunnerDisk | null =
    latest?.diskTotalBytes && latest.diskFreeBytes !== undefined
      ? {
          totalBytes: latest.diskTotalBytes,
          freeBytes: latest.diskFreeBytes,
          usedPercent: pct(latest.diskTotalBytes - latest.diskFreeBytes, latest.diskTotalBytes),
        }
      : workspaceDisk;
  const diskWarn = !!disk && (disk.usedPercent >= FULL_PERCENT || (reserveMb !== null && disk.freeBytes < reserveMb * MIB));

  const noReading = reports ? RUNNER_RESOURCES_NO_READING : '';
  const tiles: Tile[] = [
    {
      key: 'cpu',
      label: RUNNER_RESOURCES_CPU,
      percent: cpu === null ? null : Math.round(cpu),
      detail: latest ? cpuDetail(latest.cpuCores ?? null, latest.load1 ?? null) || noReading : noReading,
      warn: false,
      update: reports ? undefined : runnerResourcesPredates('CPU'),
      pick: (s) => s.cpu,
    },
    {
      key: 'mem',
      label: RUNNER_RESOURCES_MEMORY,
      percent: mem,
      detail:
        memTotal && memAvail !== null ? runnerDiskUsed(formatDiskGb(memTotal - memAvail), formatDiskGb(memTotal)) : noReading,
      warn: mem !== null && mem >= FULL_PERCENT,
      note: mem !== null && mem >= FULL_PERCENT && online ? RUNNER_RESOURCES_MEMORY_FULL : undefined,
      update: reports ? undefined : runnerResourcesPredates('memory'),
      pick: (s) => s.mem,
    },
    {
      key: 'disk',
      label: RUNNER_DISK,
      percent: disk?.usedPercent ?? null,
      detail: disk
        ? `${runnerDiskUsed(formatDiskGb(disk.totalBytes - disk.freeBytes), formatDiskGb(disk.totalBytes))} · ${runnerDiskFree(formatDiskGb(disk.freeBytes))}`
        : noReading,
      warn: diskWarn,
      pick: (s) => s.disk,
    },
  ];

  const head = !online
    ? at
      ? runnerResourcesLastReading(ago(at, nowMs))
      : RUNNER_RESOURCES_OFFLINE
    : reports
      ? RUNNER_RESOURCES_LIVE
      : RUNNER_RESOURCES_DISK_ONLY;

  return (
    <SettingsSection
      title={RUNNER_RESOURCES}
      className="machine-section-resources"
      action={
        <span className="machine-section-note">
          {(online ? reports : true) && <span className={`machine-res-dot${online ? '' : ' off'}`} />}
          {head}
        </span>
      }
    >
      <div className="machine-res-grid">
        {tiles.map((tile) => (
          <div
            key={tile.key}
            className={`machine-res-tile${online ? '' : ' off'}${tile.warn ? ' warn' : ''}`}
            data-resource={tile.key}
          >
            <div className="machine-res-label">{tile.label}</div>
            {tile.update ? (
              <>
                <div className="machine-res-update">
                  <Badge tone="orange">{RUNNER_RESOURCES_UPDATE}</Badge>
                </div>
                <div className="machine-res-detail">{tile.update}</div>
              </>
            ) : (
              <>
                <div className="machine-res-value">
                  {tile.percent === null ? '—' : tile.percent}
                  {tile.percent !== null && <span>%</span>}
                </div>
                <div className="machine-res-detail">{tile.detail}</div>
                {reports && <Sparkline samples={samples} pick={tile.pick} endMs={endMs} />}
                {tile.note && <div className="machine-res-note">{tile.note}</div>}
              </>
            )}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
