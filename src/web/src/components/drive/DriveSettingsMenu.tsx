import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { DeleteOutlined, RightOutlined, SettingOutlined } from '@ant-design/icons';
import { Menu, type MenuItem } from '../ui/Menu';
import { driveUsageQuery, storageUsageQuery } from '../../lib/queries';
import { formatSize } from '../../lib/drive';

export type DriveStorageLevel = 'ok' | 'amber' | 'red';

/** What the meter and the gear's dot say, read from the two answers: the account's limit against what it keeps, and
 *  the server store's own nearQuota flag. */
export function driveStorageState(
  drive: { totalBytes: number; nearQuota?: boolean } | undefined,
  quotaBytes: number | null | undefined,
): { level: DriveStorageLevel; percent: number | null } {
  const limit = quotaBytes ?? null;
  if (!drive || limit === null || limit <= 0) return { level: drive?.nearQuota ? 'amber' : 'ok', percent: null };
  const percent = Math.floor((drive.totalBytes / limit) * 100);
  if (drive.totalBytes >= limit) return { level: 'red', percent };
  return { level: percent >= 90 || drive.nearQuota ? 'amber' : 'ok', percent };
}

function Meter() {
  const navigate = useNavigate();
  const { data: drive } = useQuery(driveUsageQuery());
  const { data: usage } = useQuery(storageUsageQuery());
  if (!drive) return <div className="drive-meter-empty">Reading storage…</div>;
  const limit = usage?.quotaBytes ?? null;
  const { level, percent } = driveStorageState(drive, limit);
  const limited = limit !== null && limit > 0;
  const full = level === 'red';
  const storeFull = drive.storeUsedBytes !== undefined && drive.storeQuotaBytes !== undefined && drive.storeUsedBytes >= drive.storeQuotaBytes;
  const storePercent =
    drive.storeUsedBytes !== undefined && drive.storeQuotaBytes
      ? Math.floor((drive.storeUsedBytes / drive.storeQuotaBytes) * 100)
      : null;
  // Shares of the bar: of the limit when there is one (the rest is the grey track), of the total when there is not.
  const base = limited ? limit : drive.totalBytes || 1;
  const share = (bytes: number) => `${Math.min(100, (bytes / base) * 100)}%`;
  const driveOnly = Math.max(0, drive.driveBytes - drive.trashBytes);

  let note: string | null = null;
  if (limited && full) note = `Uploads are refused. Empty Trash or open Storage.`;
  else if (limited && level === 'amber' && (percent ?? 0) >= 90) {
    note = `Uploads stop at ${formatSize(limit)}. Empty Trash to free ${formatSize(drive.trashBytes)}.`;
  } else if (drive.nearQuota) {
    note = storeFull || storePercent === null
      ? "Orbit's storage is full. Ask the operator to raise the limit."
      : `Orbit's storage is ${storePercent}% full. Ask the operator to raise the limit.`;
  }

  return (
    <button type="button" className="drive-meter" data-level={level} aria-label="Storage" onClick={() => navigate('/drive/storage')}>
      <span className="drive-meter-head">
        <span>{limited ? `${formatSize(drive.totalBytes)} of ${formatSize(limit)}` : 'Storage'}</span>{' '}
        <b>{limited ? (full ? 'Full' : `${percent}%`) : formatSize(drive.totalBytes)}</b>
      </span>{' '}
      <span className={`drive-meter-bar${limited ? ' has-track' : ''}`} aria-hidden="true">
        <i className="drive-seg-drive" style={{ width: share(driveOnly) }} />
        <i className="drive-seg-trash" style={{ width: share(drive.trashBytes) }} />
        <i className="drive-seg-other" style={{ width: share(drive.otherBytes) }} />
      </span>{' '}
      <span className="drive-meter-legend">
        <span>Drive {formatSize(driveOnly)}</span>{' '}
        <span>Trash {formatSize(drive.trashBytes)}</span>{' '}
        <span>Other {formatSize(drive.otherBytes)}</span>
      </span>{' '}
      {note ? (
        <span className="drive-meter-note">{note}</span>
      ) : (
        !limited && <span className="drive-meter-note is-quiet">No limit set · Open Storage <RightOutlined /></span>
      )}
    </button>
  );
}

/** The Drive header's Settings gear: its menu holds the storage meter and Trash. The gear carries an amber dot at 90% or
 *  more of the limit (or when the server's store is nearly full) and a red one when full. */
export function DriveSettingsMenu() {
  const navigate = useNavigate();
  const { data: drive } = useQuery(driveUsageQuery());
  const { data: usage } = useQuery(storageUsageQuery());
  const { level } = driveStorageState(drive, usage?.quotaBytes);
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
