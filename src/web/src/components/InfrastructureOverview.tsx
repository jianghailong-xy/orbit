import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { AgentProvider, ALL_ENGINES, ENGINE_CLI_NAMES } from '@orbit/shared';
import { CURSOR_CONNECT_HREF } from '../lib/cursorRuntime';
import { DSH_CONNECT_HREF } from '../lib/dshRuntime';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import { poolRunsCodex, type ProviderPool } from '../lib/providerPools';
import { webShowsEngine } from '../lib/runnerEngines';
import { EngineTile } from './ProviderGallery';
import { machineChipsOf } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * The end of the Infrastructure page (docs/mocks/infrastructure-focus): what each engine can run on, an
 * index of the sections above it — the machines, the keys and the pools — read from the lists they show,
 * and asking the server nothing of its own.
 */

const machineName = (runner: Runner) => runner.displayName || runner.name;

/**
 * By engine: what each engine can run on now, a row each, in the order the session pickers list them:
 * the machines online and signed in to it (Subscription; for OpenCode, its own sign-in on the machine) —
 * what their cards' chips say (machineChipsOf) — the enabled keys that run on it (API key), and its
 * account pools that can start a session (Pool). A key is listed under every engine it runs on — the
 * server's `engines` for it: a DeepSeek key under Claude Code, OpenCode and DeepSeek Harness, a Claude
 * subscription token under Claude Code alone. Ready with any of them; with none, Not set up, and the
 * ways to get one.
 */
export function EngineOverview({
  runners,
  keys,
  pools,
}: {
  runners: Runner[];
  keys: ProviderRow[];
  pools: ProviderPool[];
}) {
  const online = runners.filter((runner) => runner.online);
  // An install is made from a machine's own card: the first one online, opened on that engine
  // (RunnerEngines reads ?runner=&engine=). With none online, a machine to register.
  const installOn = (engine: AgentProvider) =>
    online.length > 0 ? `?runner=${encodeId(online[0].id)}&engine=${engine}` : '/runners/register';
  const chips = new Map(online.map((runner) => [runner.id, machineChipsOf(runner)]));

  return (
    <div className="re-sec">
      <div className="re-sec-head">
        <h3>By engine</h3>
        <span className="re-sec-sub">
          Which engines can start a session right now, and on what — read from the machines, keys and pools above.
        </span>
      </div>
      <div className="infra-engines">
        {ALL_ENGINES.map((engine) => {
          if (!webShowsEngine(engine, runners)) return null;
          // DeepSeek Harness has no sign-in on a machine: it runs on DeepSeek keys alone.
          const machines =
            engine === AgentProvider.DSH
              ? []
              : online.flatMap((runner) => {
                  const logins = chips.get(runner.id)?.find((chip) => chip.engine === engine)?.logins ?? 0;
                  return logins === 0 ? [] : [logins > 1 ? `${machineName(runner)} ×${logins}` : machineName(runner)];
                });
          const engineKeys = keys.filter((key) => key.enabled && key.engines.includes(engine));
          const enginePools = pools.filter(
            (pool) => !pool.unavailable && (poolRunsCodex(pool) ? 'codex' : 'claude') === engine,
          );
          const ready = machines.length > 0 || engineKeys.length > 0 || enginePools.length > 0;
          return (
            <div className={`infra-engine${ready ? '' : ' none'}`} key={engine}>
              <EngineTile engine={engine} size={20} />
              <div className="infra-engine-main">
                <div className="infra-engine-name">
                  {ENGINE_CLI_NAMES[engine]}
                  <span className={`infra-engine-state${ready ? ' ready' : ''}`}>{ready ? 'Ready' : 'Not set up'}</span>
                </div>
                {ready ? (
                  <div className="infra-engine-src">
                    {machines.length > 0 && (
                      <div>
                        <b>{engine === AgentProvider.OPENCODE ? 'Own sign-in' : 'Subscription'}</b> · {machines.join(', ')}
                      </div>
                    )}
                    {/* The keys by name alone: the model each starts on is on its own row above. */}
                    {engineKeys.length > 0 && (
                      <div>
                        <b>API key</b> ·{' '}
                        {engineKeys.map((key, index) => (
                          <Fragment key={key.id}>
                            {index > 0 && ', '}
                            {key.label}
                          </Fragment>
                        ))}
                      </div>
                    )}
                    {enginePools.length > 0 && (
                      <div>
                        <b>Pool</b> · {enginePools.map((pool) => pool.label).join(', ')}
                      </div>
                    )}
                  </div>
                ) : engine === AgentProvider.DSH ? (
                  <div className="infra-engine-src none">
                    No DeepSeek key. <Link to={DSH_CONNECT_HREF}>Connect a DeepSeek key</Link> — it runs on Claude Code
                    and OpenCode too.
                  </div>
                ) : (
                  <div className="infra-engine-src none">
                    No machine signed in, no key. <Link to={installOn(engine)}>Install on a machine</Link> or{' '}
                    <Link to={engine === AgentProvider.CURSOR ? CURSOR_CONNECT_HREF : '/providers/new'}>connect a key</Link>.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
