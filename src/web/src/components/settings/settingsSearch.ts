import { PERSONAL_PAGES, PERSONAL_SETTINGS } from '../../pages/settings/settingsIndex';
import { vendorName, vendorOf } from '../ProviderGallery';

/**
 * Settings' search box (docs/mocks/settings-redesign, board-2 note 2): one query over all four groups —
 * Personal pages and the title and description of each setting on them, machine names and hostnames,
 * vendor names and key labels, workspace names and working directories. Each hit opens a page, and
 * names the row on it to flash (SettingsRow's `anchor`) when the match was a row's.
 */
export type SettingsHit = {
  key: string;
  label: string;
  /** A second line: where the match is, or what the row is. */
  detail?: string;
  to: string;
  anchor?: string;
};

export type SettingsHitGroup = {
  title: 'Personal' | 'Machines' | 'Providers' | 'Workspaces';
  hits: SettingsHit[];
};

export type SettingsSearchSources = {
  runners: ReadonlyArray<{
    id: string;
    name: string;
    displayName?: string | null;
    hostname?: string | null;
  }>;
  keys: ReadonlyArray<{ id: string; label: string; presetSlug: string | null }>;
  workspaces: ReadonlyArray<{
    id: string;
    name: string;
    workDir?: string | null;
    machine?: string | null;
  }>;
};

const has = (text: string | null | undefined, needle: string): boolean => !!text && text.toLowerCase().includes(needle);

/** A long line cut so the match shows: from a little before it, when it is far in. */
export function around(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  return at > 40 ? `…${text.slice(at - 24)}` : text;
}

export function searchSettings(query: string, sources: SettingsSearchSources): SettingsHitGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pageLabel = new Map<string, string>(PERSONAL_PAGES.map((page) => [page.path, page.label]));

  const personal: SettingsHit[] = PERSONAL_PAGES.filter((page) => has(page.label, q)).map((page) => ({
    key: page.path,
    label: page.label,
    to: page.path,
  }));
  for (const s of Object.values(PERSONAL_SETTINGS)) {
    const description = 'description' in s ? s.description : undefined;
    if (!has(s.title, q) && !has(description, q)) continue;
    personal.push({
      key: `${s.path}#${s.anchor}`,
      label: s.title,
      detail: description && has(description, q) ? around(description, q) : pageLabel.get(s.path),
      to: s.path,
      anchor: s.anchor,
    });
  }

  const machines: SettingsHit[] = [];
  for (const runner of sources.runners) {
    const name = runner.displayName?.trim() || runner.name;
    const byName = has(name, q) || has(runner.name, q);
    if (!byName && !has(runner.hostname, q)) continue;
    machines.push({
      key: runner.id,
      label: name,
      detail: runner.hostname || undefined,
      to: `/settings/machines/${runner.id}`,
      anchor: byName ? 'name' : 'hostname',
    });
  }

  const providers: SettingsHit[] = [];
  const vendors = new Map<string, number>();
  for (const key of sources.keys) {
    const vendor = vendorOf(key.presetSlug);
    vendors.set(vendor, (vendors.get(vendor) ?? 0) + 1);
  }
  for (const [vendor, count] of vendors) {
    if (!has(vendorName(vendor), q)) continue;
    providers.push({
      key: `vendor:${vendor}`,
      label: vendorName(vendor),
      detail: count === 1 ? '1 key' : `${count} keys`,
      to: `/settings/providers/${vendor}`,
    });
  }
  for (const key of sources.keys) {
    if (!has(key.label, q)) continue;
    const vendor = vendorOf(key.presetSlug);
    providers.push({
      key: `key:${key.id}`,
      label: key.label,
      detail: `${vendorName(vendor)} key`,
      to: `/settings/providers/${vendor}`,
      anchor: `key:${key.id}`,
    });
  }
  if (has('Account pools', q))
    providers.push({
      key: 'pools',
      label: 'Account pools',
      to: '/settings/providers/pools',
    });

  const workspaces: SettingsHit[] = [];
  for (const workspace of sources.workspaces) {
    const byName = has(workspace.name, q);
    if (!byName && !has(workspace.workDir, q)) continue;
    workspaces.push({
      key: workspace.id,
      label: workspace.name,
      detail: byName ? workspace.machine || undefined : workspace.workDir || undefined,
      to: `/settings/workspaces/${workspace.id}`,
      anchor: byName ? 'name' : 'workDir',
    });
  }

  const groups: SettingsHitGroup[] = [
    { title: 'Personal', hits: personal },
    { title: 'Machines', hits: machines },
    { title: 'Providers', hits: providers },
    { title: 'Workspaces', hits: workspaces },
  ];
  return groups.filter((group) => group.hits.length > 0);
}
