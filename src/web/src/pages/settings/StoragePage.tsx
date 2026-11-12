import { useQuery } from '@tanstack/react-query';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../../components/settings';
import { storageUsageQuery, type StorageUsage } from '../../lib/queries';
import { formatFileSize } from '../../lib/worktreeFile';
import { PERSONAL_SETTINGS as S } from './settingsIndex';

/** A week as its Monday reads, in the zone the server counted it in. */
function weekLabel(weekStart: string): string {
  return new Date(`${weekStart}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** How much a file count and a size come to, the quota beside the size where there is one. */
function storedValue({ totalBytes, fileCount, quotaBytes }: StorageUsage): string {
  const size = quotaBytes === null ? formatFileSize(totalBytes) : `${formatFileSize(totalBytes)} of ${formatFileSize(quotaBytes)}`;
  return `${size} · ${fileCount.toLocaleString('en-US')} ${fileCount === 1 ? 'file' : 'files'}`;
}

/** A section of rows, each a name and a size. Nothing at all when there are no rows. */
function UsageSection({ title, rows }: { title: string; rows: { key: string; name: string; size: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <SettingsSection title={title}>
      <SettingsCard>
        {rows.map(({ key, name, size }) => (
          <SettingsRow key={key} title={name} control={<span className="settings-storage-size">{size}</span>} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Settings → Storage: what this account keeps in Orbit Files, read when the page opens, and only here. */
export function StorageSettingsPage() {
  const { data: usage, isError } = useQuery(storageUsageQuery());
  const full = usage && usage.quotaBytes !== null && usage.totalBytes >= usage.quotaBytes;
  return (
    <div className="settings-page">
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
      {usage && (
        <>
          <UsageSection
            title="Largest projects"
            rows={usage.projects.map(({ projectId, title, bytes }) => ({ key: projectId, name: title, size: formatFileSize(bytes) }))}
          />
          <UsageSection
            title="Largest tasks"
            rows={usage.tasks.map(({ taskId, title, bytes }) => ({ key: taskId, name: title, size: formatFileSize(bytes) }))}
          />
          <UsageSection
            title="Added each week"
            rows={[...usage.weeks].reverse().map(({ weekStart, bytes }) => ({
              key: weekStart,
              name: `Week of ${weekLabel(weekStart)}`,
              size: formatFileSize(bytes),
            }))}
          />
        </>
      )}
    </div>
  );
}
