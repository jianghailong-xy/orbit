export type ComposerSlashItemType = 'command' | 'skill' | 'local';

export interface ComposerSlashItem {
  name: string;
  description?: string | null;
  type?: ComposerSlashItemType;
  agentId?: string | null;
}

export interface LocalStatusSnapshot {
  surface: string;
  runnerName?: string | null;
  runnerOnline?: boolean;
  activeSessions?: number | null;
  maxConcurrent?: number | null;
  sessionTitle?: string | null;
  sessionStatus?: string | null;
  agentName?: string | null;
  provider?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
  planUsageLabel?: string | null;
  planUsagePercent?: number | null;
}

export interface LocalStatusRow {
  label: string;
  value: string;
}

export const LOCAL_SLASH_ITEMS: ComposerSlashItem[] = [
  {
    name: 'status',
    description: 'Show local session and runner status',
    type: 'local',
  },
];

export function slashToken(text: string): string | null {
  return /(?:^|\s)\/(\S*)$/.exec(text)?.[1] ?? null;
}

export function slashCommandName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const first = trimmed.split(/\s+/, 1)[0] ?? '/';
  return first.slice(1);
}

export function isLocalSlashCommand(name: string): boolean {
  return LOCAL_SLASH_ITEMS.some((it) => it.name.toLowerCase() === name.toLowerCase());
}

export function slashMatches(
  items: ComposerSlashItem[],
  token: string | null,
  scope: 'command' | 'skill' | null,
): ComposerSlashItem[] {
  if (token === null) return [];
  const q = token.toLowerCase();
  return items
    .filter((it) => {
      if (scope !== null && it.type !== scope) return false;
      return q === '' || it.name.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    })
    .slice(0, 50);
}

export function pickSlash(text: string, name: string): string {
  return text.replace(/(^|\s)\/\S*$/, `$1/${name} `);
}

export function openSlash(text: string): string {
  return text === '' || /\s$/.test(text) ? `${text}/` : `${text} /`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

export function localStatusRows(s: LocalStatusSnapshot): LocalStatusRow[] {
  const rows: LocalStatusRow[] = [{ label: 'Surface', value: s.surface }];
  if (s.runnerName) {
    const status = s.runnerOnline === false ? 'offline' : 'online';
    const slots =
      typeof s.activeSessions === 'number' && typeof s.maxConcurrent === 'number'
        ? `, ${s.activeSessions}/${s.maxConcurrent} slots`
        : '';
    rows.push({ label: 'Runner', value: `${s.runnerName} (${status}${slots})` });
  }
  rows.push({
    label: 'Session',
    value: s.sessionTitle
      ? `${s.sessionTitle}${s.sessionStatus ? ` (${s.sessionStatus})` : ''}`
      : 'New session draft',
  });
  if (s.agentName) rows.push({ label: 'Agent', value: s.agentName });
  if (s.provider) rows.push({ label: 'Provider', value: s.provider });
  if (s.model) rows.push({ label: 'Model', value: s.model });
  if (s.permissionMode) rows.push({ label: 'Permission', value: s.permissionMode });
  rows.push({ label: 'Reasoning', value: s.effort || 'Default' });

  const contextTokens = Math.max(0, s.contextTokens ?? 0);
  const contextWindow = Math.max(0, s.contextWindow ?? 0);
  if (contextTokens > 0 && contextWindow > 0) {
    const pct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
    rows.push({
      label: 'Context',
      value: `${pct}% (${fmtTokens(contextTokens)} / ${fmtTokens(contextWindow)} tokens)`,
    });
  } else {
    rows.push({ label: 'Context', value: 'not reported yet' });
  }

  if (typeof s.planUsagePercent === 'number') {
    rows.push({
      label: 'Plan usage',
      value: `${s.planUsageLabel || 'Primary limit'} ${Math.round(s.planUsagePercent)}%`,
    });
  } else {
    rows.push({ label: 'Plan usage', value: 'not reported' });
  }
  return rows;
}
