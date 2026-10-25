import { Link, useNavigate } from 'react-router-dom';
import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AgentProvider, ENGINE_CLI_NAMES, keyDialect, PROVIDER_PRESETS } from '@orbit/shared';
import type { ProviderRow } from '../lib/providerAdmin';
import { DSH_PRESET_SLUG } from '../lib/dshRuntime';
import { hasDeepSeekBalance } from '../lib/deepseekBalance';
import { runnersQuery } from '../lib/queries';
import { webShowsEngine } from '../lib/runnerEngines';
import { ago } from '../lib/watches';
import { DeepSeekBalanceLine } from './DeepSeekBalance';
import { CursorKeyCheckLine } from './CursorKeyCheck';
import { EngineTile, ProviderTile, newKeyEngines, vendorName, vendorOf } from './ProviderGallery';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

/** PROTOTYPE for docs/mocks/infra-focus — the keys as one card per vendor, each key a row. Not shipped. */

function byVendor(rows: ProviderRow[]): Array<{ vendor: string; rows: ProviderRow[] }> {
  const groups = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    const vendor = vendorOf(row.presetSlug);
    groups.set(vendor, [...(groups.get(vendor) ?? []), row]);
  }
  return [...groups].map(([vendor, keys]) => ({ vendor, rows: keys }));
}

export function KeyEngines({ row }: { row: ProviderRow }) {
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

function defaultModelOf(key: ProviderRow): string | null {
  const model = key.defaultModel || key.models[0]?.value;
  if (!model) return null;
  return key.models.find((option) => option.value === model)?.label || model;
}

export function ProviderKeyCards({ rows, nowMs, onDelete }: { rows: ProviderRow[]; nowMs: number; onDelete: (row: ProviderRow) => void }) {
  const navigate = useNavigate();
  return (
    <div className="vk-cards">
      {byVendor(rows).map((group) => (
        <div className="re-card vk-card" key={group.vendor}>
          <div className="re-head vk-head">
            <ProviderTile slug={group.vendor} label={vendorName(group.vendor)} size={22} />
            <span className="re-runner">{vendorName(group.vendor)}</span>
            {group.rows.length > 1 && <span className="re-summary">{group.rows.length} keys</span>}
            <span className="re-head-sp" />
            <Link className="re-manage" to={`/providers/new/${group.vendor}`}>+ Add key</Link>
          </div>
          {group.rows.map((row) => {
            const model = defaultModelOf(row);
            return (
              <div className="vk-row" key={row.id}>
                <div className="vk-id">
                  <div className="re-name">{row.label}</div>
                  <KeyEngines row={row} />
                  {hasDeepSeekBalance(row) && <DeepSeekBalanceLine row={row} />}
                  {row.runtime === 'cursor' && <CursorKeyCheckLine row={row} />}
                </div>
                <div className="vk-model" title="The model a session on this key starts on">
                  {model ? (
                    <>
                      <span className="vk-model-l">Starts on</span>
                      <span className="infra-model">{model}</span>
                    </>
                  ) : (
                    <span className="prov-never">No model</span>
                  )}
                </div>
                <div className="vk-state">
                  <Badge tone={row.enabled ? 'green' : 'default'}>{row.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  <span className="vk-last">{row.lastUsedAt ? `Used ${ago(row.lastUsedAt, nowMs)}` : 'Never used'}</span>
                </div>
                <span className="prov-actions vk-act">
                  <Button size="small" onClick={() => navigate(`/providers/${row.id}`)}>Edit</Button>
                  <Button size="small" danger onClick={() => onDelete(row)}>Delete</Button>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The vendors not yet connected, one row of links into the connect page. */
export function ConnectMore({ rows }: { rows: ProviderRow[] }) {
  const runners = useQuery(runnersQuery());
  const connected = new Set(rows.map((row) => vendorOf(row.presetSlug)));
  const list = PROVIDER_PRESETS.filter(
    (p) =>
      p.slug !== DSH_PRESET_SLUG &&
      !connected.has(p.slug) &&
      newKeyEngines({ runtime: p.runtime, presetSlug: p.slug, baseUrl: p.baseUrl }).some((engine) => webShowsEngine(engine, runners.data ?? [])),
  );
  return (
    <div className="pv-more">
      <span className="pv-more-l">Connect another provider</span>
      {list.map((p) => (
        <Link key={p.slug} to={`/providers/new/${p.slug}`} className="pv-pill">
          <ProviderTile slug={p.slug} label={vendorName(p.slug)} size={18} />
          {vendorName(p.slug)}
        </Link>
      ))}
      <Link to="/providers/new/custom" className="pv-pill">
        <ProviderTile slug="custom" label="Custom" size={18} muted />
        Custom
      </Link>
    </div>
  );
}
