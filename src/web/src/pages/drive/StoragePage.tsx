import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../../components/settings';
import { driveUsageQuery, storageUsageQuery, type StorageUsage } from '../../lib/queries';
import { formatFileSize } from '../../lib/worktreeFile';
import { encodeId } from '../../lib/idCodec';
import { PERSONAL_SETTINGS as S } from '../settings/settingsIndex';

/** A week as its Monday reads, in the zone the server counted it in. */
export function weekLabel(weekStart: string): string {
  return new Date(`${weekStart}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** How much a file count and a size come to, the quota beside the size where there is one. */
function storedValue({ totalBytes, fileCount, quotaBytes }: StorageUsage): string {
  const size = quotaBytes === null ? formatFileSize(totalBytes) : `${formatFileSize(totalBytes)} of ${formatFileSize(quotaBytes)}`;
  return `${size} · ${fileCount.toLocaleString('en-US')} ${fileCount === 1 ? 'file' : 'files'}`;
}

/** A section of rows, each a name and a size. Nothing at all when there are no rows. */
function UsageSection({ title, rows }: { title: string; rows: { key: string; name: string; size: string; to: string }[] }) {
  const navigate = useNavigate();
  if (rows.length === 0) return null;
  return (
    <SettingsSection title={title}>
      <SettingsCard>
        {rows.map(({ key, name, size, to }) => (
          <button key={key} type="button" className="workspace-machine-choice storage-usage-choice" onClick={() => navigate(to)}>
            <SettingsRow
              title={name}
              control={<><span className="settings-storage-size">{size}</span><RightOutlined className="storage-usage-chevron" /></>}
            />
          </button>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Files → Storage: what this account keeps in Drive, the drive and everything else, each byte once. Read when the page opens. */
export function StorageSettingsPage() {
  const { data: usage, isError } = useQuery(storageUsageQuery());
  const { data: drive } = useQuery(driveUsageQuery());
  const navigate = useNavigate();
  const full = usage && usage.quotaBytes !== null && usage.totalBytes >= usage.quotaBytes;
  return (
    <div className="settings-page">
      <button type="button" className="settings-back storage-files-back" onClick={() => navigate('/drive')}>
        <LeftOutlined />
        <span>Drive</span>
      </button>
      <SettingsHeader title="Storage" />
      <SettingsCard>
        <SettingsRow
          anchor={S.storedFiles.anchor}
          title={S.storedFiles.title}
          description={
            <>
              {S.storedFiles.description}
              {full && (
                <div className="settings-storage-full" style={{ marginTop: 4, color: 'var(--warning)' }}>
                  Your storage is full, so new uploads are refused. Older uploads free up room as they expire.
                </div>
              )}
            </>
          }
          control={
            <div className="settings-storage-value" style={{ color: 'var(--text-2)' }}>
              {usage ? storedValue(usage) : isError ? 'Could not read this' : '…'}
            </div>
          }
        />
      </SettingsCard>
      {drive && (
        <SettingsCard>
          <SettingsRow title="Total" control={<span className="settings-storage-size">{formatFileSize(drive.totalBytes)}</span>} />
          {drive.nearQuota && drive.storeUsedBytes !== undefined && drive.storeQuotaBytes !== undefined && (
            <SettingsRow
              title="Drive storage"
              description={
                <span className="settings-storage-full" style={{ color: 'var(--warning)' }}>
                  {drive.storeUsedBytes >= drive.storeQuotaBytes
                    ? "The drive's storage is full. Ask the operator to raise the limit."
                    : `Drive storage is ${Math.floor((drive.storeUsedBytes / drive.storeQuotaBytes) * 100)}% full. Uploads stop at 100%. Ask the operator to raise the limit.`}
                </span>
              }
            />
          )}
          <SettingsRow
            title="Drive"
            description={`Including ${formatFileSize(drive.trashBytes)} in Trash`}
            control={<span className="settings-storage-size">{formatFileSize(drive.driveBytes)}</span>}
          />
          <SettingsRow
            title="Everything else"
            description="Conversation pictures, attachments, evidence files and earlier file uploads"
            control={<span className="settings-storage-size">{formatFileSize(drive.otherBytes)}</span>}
          />
        </SettingsCard>
      )}
      {usage && (
        <>
          <UsageSection
            title="Largest projects"
            rows={usage.projects.map(({ projectId, title, bytes }) => ({ key: projectId, name: title, size: formatFileSize(bytes), to: `/drive/storage/projects/${encodeId(projectId)}` }))}
          />
          <UsageSection
            title="Largest tasks"
            rows={usage.tasks.map(({ taskId, title, bytes }) => ({ key: taskId, name: title, size: formatFileSize(bytes), to: `/drive/storage/tasks/${encodeId(taskId)}` }))}
          />
          <UsageSection
            title="Added each week"
            rows={[...usage.weeks].reverse().map(({ weekStart, bytes }) => ({
              key: weekStart,
              name: `Week of ${weekLabel(weekStart)}`,
              size: formatFileSize(bytes),
              to: `/drive/storage/weeks/${weekStart}`,
            }))}
          />
        </>
      )}
    </div>
  );
}
