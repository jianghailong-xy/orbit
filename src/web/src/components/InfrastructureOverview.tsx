import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from 'antd';
import type { LoginEngine } from '@orbit/shared';
import { runsOnEnvKey } from '../lib/engineAccounts';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import { poolRunsCodex, type ProviderPool } from '../lib/providerPools';
import { ago } from '../lib/runnerEngines';
import { ENGINE_PRESET, providerDisplayLabel } from '../lib/sessionProviderChoices';
import { ProviderTile } from './ProviderGallery';
import { engineHealthOf, rowKindOf } from './RunnerEngines';
import { ENGINE_NAME, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';

/**
 * The top of the Infrastructure page (docs/mocks/infrastructure-page/02-after-infrastructure.png):
 * what needs a person (NeedsAttention), then what each engine can run on (EngineOverview). Both are
 * read from the lists the sections below them show — the machines, the keys and the pools — and ask
 * the server nothing of their own.
 */

/** The engines a machine signs in, in the order every list on the page names them. */
const ENGINES = Object.keys(ENGINE_NAME) as LoginEngine[];

const machineName = (runner: Runner) => runner.displayName || runner.name;

/**
 * Whether this engine is signed out on this machine: installed, the CLI's own answer is no, and no
 * account of it is signed in either — with one that is, sessions there still run on it. Antigravity
 * only where its Google sign-in can be started from here, since that is the one way back in this
 * offers.
 */
function signedOutOn(runner: Runner, engine: LoginEngine): boolean {
  const health = engineHealthOf(runner, engine);
  if (rowKindOf(health, runner.install, engine) !== 'out') return false;
  if (engine === 'antigravity' && (runner.antigravity?.supported === false || runner.antigravity?.googleLogin !== 'available')) {
    return false;
  }
  return !health?.accounts?.some((account) => account.auth === 'yes');
}

/**
 * How many logins of this engine a session on this machine can run on: each account signed in, or
 * the engine's own answer where it reports no accounts. Antigravity's Default on the machine's own
 * Gemini key counts, as it does on the machine's card (runsOnEnvKey).
 */
function loginsOn(runner: Runner, engine: LoginEngine): number {
  const health = engineHealthOf(runner, engine);
  if (!health?.installed || (engine === 'antigravity' && runner.antigravity?.supported === false)) return 0;
  const accounts = health.accounts ?? [];
  if (accounts.length === 0) return health.auth === 'yes' ? 1 : 0;
  return accounts.filter((account) => account.auth === 'yes' || runsOnEnvKey(health, account)).length;
}

/** The model a session on this key starts on, by the name the key's own list gives it. */
function defaultModelOf(key: ProviderRow): string | null {
  const model = key.defaultModel || key.models[0]?.value;
  if (!model) return null;
  return key.models.find((option) => option.value === model)?.label || model;
}

/**
 * What needs a person, a line each, and nothing at all while nothing does: an engine signed out on a
 * machine that is online — signed in again right here, with the same sign-in its row on the machine's
 * card opens — a machine that is offline, and an account pool no session can start on. Each line ends
 * in the way to deal with it.
 */
export function NeedsAttention({ runners, pools }: { runners: Runner[]; pools: ProviderPool[] }) {
  // The sign-in open under one of the lines, by runner and engine.
  const [signIn, setSignIn] = useState<string | null>(null);
  const signedOut = runners
    .filter((runner) => runner.online)
    .flatMap((runner) => ENGINES.filter((engine) => signedOutOn(runner, engine)).map((engine) => ({ runner, engine })));
  const offline = runners.filter((runner) => !runner.online);
  const unavailable = pools.filter((pool) => pool.unavailable);
  if (signedOut.length === 0 && offline.length === 0 && unavailable.length === 0) return null;
  const now = Date.now();

  return (
    <div className="infra-attn">
      {signedOut.map(({ runner, engine }) => {
        const panel = `${runner.id}/${engine}`;
        return (
          <div className="infra-attn-row" key={`out:${panel}`}>
            <span className="infra-attn-dot" />
            <span className="infra-attn-text">
              <b>{ENGINE_NAME[engine]}</b> is signed out on <b>{machineName(runner)}</b>
              <span className="infra-attn-sub"> · Sessions there can’t use it</span>
            </span>
            <Button size="small" type="primary" onClick={() => setSignIn(signIn === panel ? null : panel)}>
              Sign in
            </Button>
            {signIn === panel && (
              <div className="re-panel">
                <RunnerSignIn runnerId={runner.id} engine={engine} />
              </div>
            )}
          </div>
        );
      })}
      {offline.map((runner) => (
        <div className="infra-attn-row" key={`offline:${runner.id}`}>
          <span className="infra-attn-dot idle" />
          <span className="infra-attn-text">
            <b>{machineName(runner)}</b> is offline
            <span className="infra-attn-sub">
              {' · '}
              {runner.lastHeartbeatAt ? `Last seen ${ago(runner.lastHeartbeatAt, now)}` : 'Never checked in'}
              {' · its subscriptions are unavailable until it’s back'}
            </span>
          </span>
          <Link to={`/runners/${encodeId(runner.id)}`} aria-label={`Details of ${machineName(runner)}`}>
            <Button size="small">Details</Button>
          </Link>
        </div>
      ))}
      {unavailable.map((pool) => (
        <div className="infra-attn-row" key={`pool:${pool.id}`}>
          <span className="infra-attn-dot" />
          <span className="infra-attn-text">
            <b>{pool.label}</b> is unavailable
            <span className="infra-attn-sub"> · {pool.unavailable} · no session can start on it</span>
          </span>
          <Link to={`/providers/pools/${encodeId(pool.id)}`} aria-label={`Manage ${pool.label}`}>
            <Button size="small">Manage</Button>
          </Link>
        </div>
      ))}
    </div>
  );
}

/**
 * What each engine can run on now, a card each: the machines online and signed in to it
 * (Subscription), the enabled keys that run on it — a DeepSeek key on Claude Code among them — with
 * the model a session on each starts on (API key), and its account pools that can start a session
 * (Pool). Ready with any of them; with none, Not set up, and the two ways to get one.
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
  const installOn = (engine: LoginEngine) =>
    online.length > 0 ? `?runner=${encodeId(online[0].id)}&engine=${engine}` : '/runners/register';

  return (
    <div className="re-sec">
      <div className="re-sec-head">
        <h3>What your agents can run on</h3>
        <span className="re-sec-sub">Every engine, and everything that can pay for it right now.</span>
      </div>
      <div className="infra-engines">
        {ENGINES.map((engine) => {
          const machines = online.flatMap((runner) => {
            const logins = loginsOn(runner, engine);
            return logins === 0 ? [] : [logins > 1 ? `${machineName(runner)} ×${logins}` : machineName(runner)];
          });
          const engineKeys = keys.filter((key) => key.enabled && key.runtime === engine);
          const enginePools = pools.filter(
            (pool) => !pool.unavailable && (poolRunsCodex(pool) ? 'codex' : 'claude') === engine,
          );
          const ready = machines.length > 0 || engineKeys.length > 0 || enginePools.length > 0;
          return (
            <div className={`infra-engine${ready ? '' : ' none'}`} key={engine}>
              <ProviderTile slug={ENGINE_PRESET[engine] ?? engine} label={ENGINE_NAME[engine]} size={30} />
              <div className="infra-engine-main">
                <div className="infra-engine-name">
                  {ENGINE_NAME[engine]}
                  <span className={`infra-engine-state${ready ? ' ready' : ''}`}>{ready ? 'Ready' : 'Not set up'}</span>
                </div>
                {ready ? (
                  <div className="infra-engine-src">
                    {machines.length > 0 && (
                      <div>
                        <b>Subscription</b> · {machines.join(', ')}
                      </div>
                    )}
                    {engineKeys.length > 0 && (
                      <div>
                        <b>API key</b> ·{' '}
                        {engineKeys.map((key, index) => {
                          const model = defaultModelOf(key);
                          return (
                            <Fragment key={key.id}>
                              {index > 0 && ', '}
                              {providerDisplayLabel(key.label, key.presetSlug)}
                              {model && (
                                <>
                                  {' '}
                                  <span className="infra-model">{model}</span>
                                </>
                              )}
                            </Fragment>
                          );
                        })}
                      </div>
                    )}
                    {enginePools.length > 0 && (
                      <div>
                        <b>Pool</b> · {enginePools.map((pool) => pool.label).join(', ')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="infra-engine-src none">
                    No machine signed in, no key. <Link to={installOn(engine)}>Install on a machine</Link> or{' '}
                    <Link to="/providers/new">connect a key</Link>.
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
