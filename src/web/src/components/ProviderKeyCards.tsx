import { Fragment } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AgentProvider, ENGINE_CLI_NAMES, keyDialect } from '@orbit/shared';
import { hasDeepSeekBalance } from '../lib/deepseekBalance';
import type { ProviderRow } from '../lib/providerAdmin';
import { ago } from '../lib/watches';
import { CursorKeyCheckLine } from './CursorKeyCheck';
import { DeepSeekBalanceLine } from './DeepSeekBalance';
import { EngineTile, ProviderTile, vendorName, vendorOf } from './ProviderGallery';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

/** The exact time behind a key's relative Used, for its tooltip. */
const stampOf = (iso: string): string =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The keys under their vendors (vendorOf): a group each, in the order of each vendor's first key, and
 *  in each its keys in the list's own order. */
function byVendor(rows: ProviderRow[]): Array<{ vendor: string; rows: ProviderRow[] }> {
  const groups = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    const vendor = vendorOf(row.presetSlug);
    groups.set(vendor, [...(groups.get(vendor) ?? []), row]);
  }
  return [...groups].map(([vendor, keys]) => ({ vendor, rows: keys }));
}

/**
 * The engines a key runs on, in the server's order (`engines`, its default first) — the engines the
 * By engine list lists it under. A Claude subscription token, which Anthropic serves to Claude Code
 * alone, says why that is the only one: an Anthropic-protocol key runs on OpenCode too otherwise.
 */
function KeyEngines({ row }: { row: ProviderRow }) {
  const subscription =
    keyDialect(row.runtime) === 'anthropic' && row.engines.length === 1 && row.engines[0] === AgentProvider.CLAUDE;
  return (
    <div className="prov-runtime prov-engines">
      {row.engines.map((engine, index) => (
        <Fragment key={engine}>
          {index > 0 && <> <span className="prov-engine-sep">·</span> </>}
          <span className="prov-engine">
            <EngineTile engine={engine} size={12} />
            {ENGINE_CLI_NAMES[engine]}
          </span>
        </Fragment>
      ))}
      {subscription && (
        <>
          {' '}
          <span className="prov-engine-sep">·</span> <span>subscription token, Claude Code only</span>
        </>
      )}
    </div>
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
 * Infrastructure's API keys (docs/mocks/infrastructure-focus): a card per vendor, drawn as a machine's and
 * an account pool's are, headed by the vendor and the way to add another of its keys — and in it a row per
 * key: its name and the engines it runs on (with a DeepSeek key's balance, a Cursor key's last check), the
 * model a session on it starts on, whether it is on and when a session last ran on it, and its Edit and
 * Delete. The dispatch slug is the server's to generate and nobody's to read, so a key goes by the name it
 * was given; its endpoint and how many models it lists are on its own page.
 */
export function ProviderKeyCards({
  rows,
  nowMs,
  onDelete,
  loading = false,
}: {
  rows: ProviderRow[];
  nowMs: number;
  /** Asks first (KeyImpact), then deletes. */
  onDelete: (row: ProviderRow) => void;
  /** While the keys are being read: one card, spinning, where theirs will be. */
  loading?: boolean;
}) {
  const navigate = useNavigate();
  if (loading) {
    return (
      <div className="vk-cards" aria-busy="true">
        <div className="re-card vk-loading">
          <Spinner />
        </div>
      </div>
    );
  }
  return (
    <div className="vk-cards">
      {byVendor(rows).map((group) => (
        <div className="re-card vk-card" key={group.vendor}>
          <div className="re-head">
            <ProviderTile slug={group.vendor} label={vendorName(group.vendor)} size={22} />
            <span className="re-runner">{vendorName(group.vendor)}</span>{' '}
            {group.rows.length > 1 && <span className="re-summary">{group.rows.length} keys</span>}{' '}
            <span className="re-head-sp" />
            <Link className="re-manage vk-add" to={`/providers/new/${group.vendor}`}>
              + Add key
            </Link>
          </div>
          {group.rows.map((row) => {
            const model = startsOn(row);
            return (
              <div className="vk-row" key={row.id}>
                <div className="vk-id">
                  <div className="vk-name">{row.label}</div>
                  <KeyEngines row={row} />
                  {/* A DeepSeek key also carries its whole account's balance (DeepSeekBalance.tsx). */}
                  {hasDeepSeekBalance(row) && <DeepSeekBalanceLine row={row} />}
                  {/* A Cursor key, what Cursor answered its last check (CursorKeyCheck.tsx). */}
                  {row.runtime === 'cursor' && <CursorKeyCheckLine row={row} />}
                </div>
                <div className="vk-model">
                  {model && (
                    <>
                      Starts on <span className="infra-model">{model}</span>
                    </>
                  )}
                </div>
                {/* Whether it is on, and when a session last ran on it: the relative answer the row is read
                    for, with the exact time on hover — and for a key nothing has spent, a state, not a date. */}
                <div className="vk-state">
                  <Badge tone={row.enabled ? 'green' : 'default'}>{row.enabled ? 'Enabled' : 'Disabled'}</Badge>{' '}
                  {row.lastUsedAt ? (
                    <span className="vk-used" title={stampOf(row.lastUsedAt)}>
                      Used {ago(row.lastUsedAt, nowMs)}
                    </span>
                  ) : (
                    <span className="vk-used never">Never used</span>
                  )}
                </div>
                {/* Named after the key as well, where a screen reader lists every Edit and Delete on the page. */}
                <span className="prov-actions vk-act">
                  <Button size="small" aria-label={`Edit ${row.label}`} onClick={() => navigate(`/providers/${row.id}`)}>
                    Edit
                  </Button>
                  <Button size="small" danger aria-label={`Delete ${row.label}`} onClick={() => onDelete(row)}>
                    Delete
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
