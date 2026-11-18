import { useNavigate } from 'react-router-dom';
import { EllipsisOutlined, RightOutlined } from '@ant-design/icons';
import { AgentProvider, ENGINE_CLI_NAMES, keyDialect } from '@orbit/shared';
import { hasDeepSeekBalance } from '../lib/deepseekBalance';
import type { ProviderRow } from '../lib/providerAdmin';
import { foldFromAnywhere } from '../lib/foldHead';
import { ago } from '../lib/watches';
import { CursorKeyCheckLine } from './CursorKeyCheck';
import { DeepSeekBalanceLine, useBalance } from './DeepSeekBalance';
import { EngineTile } from './ProviderGallery';
import { SettingsCard, SettingsRow } from './settings/SettingsBlocks';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Menu, type MenuItem } from './ui/Menu';

/** The exact time behind a key's relative Used, for its tooltip. */
const stampOf = (iso: string): string =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The engines a key runs on, in the server's order (`engines`, its default first). A Claude subscription
 * token, which Anthropic serves to Claude Code alone, says why that is the only one: an
 * Anthropic-protocol key runs on OpenCode too otherwise.
 */
function KeyEngines({ row }: { row: ProviderRow }) {
  const subscription =
    keyDialect(row.runtime) === 'anthropic' && row.engines.length === 1 && row.engines[0] === AgentProvider.CLAUDE;
  return (
    <span className="prov-engines">
      Runs on{' '}
      {row.engines.map((engine, index) => (
        // The separator rides with the engine after it, so a wrapped line never ends on one.
        <span className="prov-engine" key={engine}>
          {index > 0 && <>{' '}<span className="prov-engine-sep">·</span>{' '}</>}
          <EngineTile engine={engine} size={12} />
          {ENGINE_CLI_NAMES[engine]}
        </span>
      ))}
      {subscription && (
        <span>
          {' '}<span className="prov-engine-sep">·</span> subscription token, Claude Code only
        </span>
      )}
    </span>
  );
}

/**
 * The model a session on this key starts on, by the name the key's own list gives it — and for a Cursor
 * key, Cursor's own default, which its catalogue on each machine calls Auto (docs/cursor-runtime-contract.md
 * §10). Null for a key that names no model.
 */
function startsOn(row: ProviderRow): string | null {
  const model = row.defaultModel || row.models[0]?.value;
  if (row.runtime === 'cursor' && (!model || model === 'default')) return 'Auto';
  if (!model) return null;
  return row.models.find((option) => option.value === model)?.label || model;
}

/**
 * One vendor's API keys on its Settings page (docs/mocks/settings-redesign, board-4): a row per key, its
 * name and on the line under it the engines it runs on, the model a session on it starts on, the account
 * pools it is in and when a session last ran on it (with a DeepSeek key's balance, a Cursor key's last
 * check). A press on the row opens the key's own page in Settings' right-hand column (docs/mocks/settings-buttons,
 * board 01); its borderless ⋯ holds Edit, the same page for the keyboard, and Delete, which asks first (KeyImpact). The dispatch slug is the server's to generate and nobody's to read, so a key goes by
 * the name it was given; its endpoint and how many models it lists are on its own page.
 */
export function ProviderKeyRows({
  rows,
  nowMs,
  poolsOf,
  onDelete,
}: {
  rows: ProviderRow[];
  nowMs: number;
  /** The account pools each key is in, by name. */
  poolsOf: (row: ProviderRow) => string[];
  /** Asks first (KeyImpact), then deletes. */
  onDelete: (row: ProviderRow) => void;
}) {
  const navigate = useNavigate();
  return (
    <SettingsCard>
      {rows.map((row) => {
        const model = startsOn(row);
        const edit = () => navigate(`/settings/providers/keys/${row.id}`);
        return (
          <SettingsRow
            key={row.id}
            anchor={`key:${row.id}`}
            title={
              <span className="vk-name">
                {row.label}
                {!row.enabled && (
                  <>
                    {' '}
                    <Badge>Disabled</Badge>
                  </>
                )}
              </span>
            }
            description={
              <>
                <span className="vk-line">
                  <KeyEngines row={row} />
                  {model && (
                    <span className="vk-model">
                      <span className="prov-engine-sep">·</span> Starts on <span className="infra-model">{model}</span>
                    </span>
                  )}
                  {poolsOf(row).map((pool) => (
                    <span className="vk-pool" key={pool}>
                      <span className="prov-engine-sep">·</span> in pool “{pool}”
                    </span>
                  ))}
                  {/* When a session last ran on it: the relative answer the row is read for, with the exact
                      time on hover — and for a key nothing has spent, a state, not a date. */}
                  {/* Its separator rides with it, so a wrapped line never ends on one. */}
                  <span className="vk-used-item">
                    {' '}<span className="prov-engine-sep">·</span>{' '}
                    {row.lastUsedAt ? (
                      <span className="vk-used" title={stampOf(row.lastUsedAt)}>
                        last used {ago(row.lastUsedAt, nowMs)}
                      </span>
                    ) : (
                      <span className="vk-used never">never used</span>
                    )}
                  </span>
                </span>
                {/* A DeepSeek key also carries its whole account's balance (DeepSeekBalance.tsx). */}
                {hasDeepSeekBalance(row) && <DeepSeekBalanceLine row={row} />}
                {/* A Cursor key, what Cursor answered its last check (CursorKeyCheck.tsx). */}
                {row.runtime === 'cursor' && <CursorKeyCheckLine row={row} />}
              </>
            }
            // A press anywhere on the row opens the key's page, but not one on a control of its own (the
            // balance's refresh, a top-up link, the ⋯) nor one that ended a drag across the words.
            onClick={foldFromAnywhere(edit, 'button, a, input, [role="menu"]')}
            control={
              <span className="vk-act">
                {hasDeepSeekBalance(row) ? (
                  <DeepSeekKeyMenu row={row} edit={edit} onDelete={() => onDelete(row)} />
                ) : (
                  <KeyMenu row={row} items={keyMenuItems(edit, () => onDelete(row))} />
                )}
                <RightOutlined className="vk-chev" aria-hidden />
              </span>
            }
          />
        );
      })}
    </SettingsCard>
  );
}

/** Edit first, Delete last behind a line: what every key's ⋯ holds. */
const keyMenuItems = (edit: () => void, remove: () => void, extra: MenuItem[] = []): MenuItem[] => [
  { key: 'edit', label: 'Edit', onSelect: edit },
  ...extra,
  { type: 'separator', key: 'sep' },
  { key: 'delete', label: 'Delete', danger: true, onSelect: remove },
];

/** A key's ⋯, borderless; named after the key, where a screen reader lists every ⋯ on the page. */
function KeyMenu({ row, items }: { row: ProviderRow; items: MenuItem[] }) {
  return (
    <Menu
      align="end"
      items={items}
      trigger={<Button size="small" variant="text" icon={<EllipsisOutlined />} aria-label={`More for ${row.label}`} />}
    />
  );
}

/** A DeepSeek key's ⋯ also refreshes its account balance, the same ask as the ↻ on its balance line. */
function DeepSeekKeyMenu({ row, edit, onDelete }: { row: ProviderRow; edit: () => void; onDelete: () => void }) {
  const { ask, asking } = useBalance(row);
  return (
    <KeyMenu
      row={row}
      items={keyMenuItems(edit, onDelete, [{ key: 'refresh', label: 'Refresh balance', disabled: asking, onSelect: ask }])}
    />
  );
}
