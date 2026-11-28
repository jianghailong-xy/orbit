import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { DeleteOutlined, RightOutlined, SettingOutlined } from '@ant-design/icons';
import { Menu, type MenuItem } from '../ui/Menu';
import { driveUsageQuery, storageUsageQuery } from '../../lib/queries';
import { formatSize } from '../../lib/drive';

export type DriveStorageLevel = 'ok' | 'amber' | 'red';

/** The per-account limit counts attachments only (GET /storage/usage totalBytes against quotaBytes); the drive's own
 *  limit is the server store's (storeUsedBytes of storeQuotaBytes, flagged by nearQuota). Each is read apart, and the
 *  worst of the two sets the gear's dot. */
export function driveStorageState(
  drive: { nearQuota?: boolean; storeUsedBytes?: number; storeQuotaBytes?: number } | undefined,
  attachments: { totalBytes: number; quotaBytes: number | null } | undefined,
) {
  const limit = attachments?.quotaBytes ?? null;
  const quotaPercent = attachments && limit !== null && limit > 0 ? Math.floor((attachments.totalBytes / limit) * 100) : null;
  const quotaFull = quotaPercent !== null && attachments!.totalBytes >= limit!;
  const hasStore = drive?.storeUsedBytes !== undefined && !!drive.storeQuotaBytes;
  const storeFull = hasStore && drive!.storeUsedBytes! >= drive!.storeQuotaBytes!;
  const storePercent = hasStore ? Math.floor((drive!.storeUsedBytes! / drive!.storeQuotaBytes!) * 100) : null;
  const storeNear = !!drive?.nearQuota || (storePercent !== null && storePercent >= 90);
  const quotaLevel: DriveStorageLevel = quotaFull ? 'red' : quotaPercent !== null && quotaPercent >= 90 ? 'amber' : 'ok';
  const storeLevel: DriveStorageLevel = storeFull ? 'red' : storeNear ? 'amber' : 'ok';
  const level: DriveStorageLevel = quotaLevel === 'red' || storeLevel === 'red' ? 'red' : quotaLevel === 'amber' || storeLevel === 'amber' ? 'amber' : 'ok';
  return { level, quotaLevel, storeLevel, quotaPercent, storePercent, limit };
}

function Meter() {
  const navigate = useNavigate();
  const { data: drive } = useQuery(driveUsageQuery());
  const { data: usage } = useQuery(storageUsageQuery());
  if (!drive) return <div className="drive-meter-empty">Reading storage…</div>;
  const s = driveStorageState(drive, usage);
  const base = drive.totalBytes || 1;
  const share = (bytes: number) => `${Math.min(100, (bytes / base) * 100)}%`;
  const driveOnly = Math.max(0, drive.driveBytes - drive.trashBytes);

  let quotaLine: string;
  if (s.limit === null || !usage) quotaLine = 'No limit set';
  else if (s.quotaLevel === 'red') quotaLine = `Other files ${formatSize(usage.totalBytes)} of ${formatSize(s.limit)}. New attachments are refused.`;
  else if (s.quotaLevel === 'amber') quotaLine = `Other files ${formatSize(usage.totalBytes)} of ${formatSize(s.limit)}. New attachments stop at ${formatSize(s.limit)}.`;
  else quotaLine = `Other files ${formatSize(usage.totalBytes)} of ${formatSize(s.limit)}`;

  let storeLine: string | null = null;
  if (s.storeLevel === 'red') storeLine = "The drive's storage is full. Ask the operator to raise the limit.";
  else if (s.storeLevel === 'amber') {
    storeLine = `Drive storage is ${s.storePercent ?? 90}% full. Uploads stop at 100%. Ask the operator to raise the limit.`;
  }

  return (
    <button type="button" className="drive-meter" data-level={s.level} aria-label="Storage" onClick={() => navigate('/drive/storage')}>
      <span className="drive-meter-head">
        <span>Storage</span>{' '}
        <b>{formatSize(drive.totalBytes)}</b>
      </span>{' '}
      <span className="drive-meter-bar" aria-hidden="true">
        <i className="drive-seg-drive" style={{ width: share(driveOnly) }} />
        <i className="drive-seg-trash" style={{ width: share(drive.trashBytes) }} />
        <i className="drive-seg-other" style={{ width: share(drive.otherBytes) }} />
      </span>{' '}
      <span className="drive-meter-legend">
        <span>Drive {formatSize(driveOnly)}</span>{' '}
        <span>Trash {formatSize(drive.trashBytes)}</span>{' '}
        <span>Other {formatSize(drive.otherBytes)}</span>
      </span>{' '}
      <span className="drive-meter-note" data-level={s.quotaLevel}>{quotaLine}</span>{' '}
      {storeLine && <span className="drive-meter-note" data-level={s.storeLevel}>{storeLine}</span>}{' '}
      <span className="drive-meter-note is-quiet">Open Storage <RightOutlined /></span>
    </button>
  );
}

/** The Drive header's Settings gear: its menu holds the storage meter and Trash. The gear carries an amber dot at 90% or
 *  more of the limit (or when the server's store is nearly full) and a red one when full. */
export function DriveSettingsMenu() {
  const navigate = useNavigate();
  const { data: drive } = useQuery(driveUsageQuery());
  const { data: usage } = useQuery(storageUsageQuery());
  const { level } = driveStorageState(drive, usage);
  const items: MenuItem[] = [
    {
      key: 'trash',
      label: (
        <span className="drive-menu-trash">
          <span>Trash</span>
          <span>{drive ? formatSize(drive.trashBytes) : ''}</span>
        </span>
      ),
      textValue: 'Trash',
      icon: <DeleteOutlined />,
      onSelect: () => navigate('/drive/trash'),
    },
  ];
  return (
    <Menu
      items={items}
      header={<><Meter /><div className="drive-menu-rule" role="separator" /></>}
      popupClassName="drive-settings-menu"
      trigger={
        <button type="button" className="drive-gear" aria-label="Settings">
          <SettingOutlined />
          {level !== 'ok' && <i className="drive-gear-dot" data-level={level} />}
        </button>
      }
    />
  );
}
