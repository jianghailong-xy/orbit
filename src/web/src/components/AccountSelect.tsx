import { Select } from 'antd';
import type { LoginEngine, RunnerEngineAccount } from '@orbit/shared';
import { accountDir, accountPlanUsage } from '../lib/engineAccounts';
import { planUsageRows } from '../lib/planUsage';
import { tildePath } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/** The account every runner has: the directory its own environment selects. */
const DEFAULT = 'default';

/** The field's value for Automatic, which the workspace stores as null: the Select needs a string. */
const AUTOMATIC = '';

/** The accounts a runner reported for `engine`, Default first. None from a runner too old to list
 *  them, or from an engine whose CLI keeps a single login for the machine. */
export function accountsOf(
  runner: Runner | null | undefined,
  engine: LoginEngine,
): RunnerEngineAccount[] {
  return runner?.engines?.find((entry) => entry.engine === engine)?.accounts ?? [];
}

/**
 * Whether a workspace form on this runner asks which account of `engine` to run on: only once the
 * machine has more than one, so a single-account runner's form is what it always was — or when the
 * workspace already names one, so a choice the runner no longer reports can still be seen and
 * undone.
 */
export function offersAccount(
  runner: Runner | null | undefined,
  engine: LoginEngine,
  value: string | null,
): boolean {
  return accountsOf(runner, engine).length >= 2 || value !== null;
}

/** An account's own line under its name: its quota where one is reported, and its sign-in. */
function accountStatus(
  runner: Runner,
  engine: LoginEngine,
  account: Pick<RunnerEngineAccount, 'id' | 'auth'>,
): string {
  const signIn =
    account.auth === 'yes' ? 'signed in' : account.auth === 'no' ? 'signed out' : 'sign-in unknown';
  // Each account's quota is its own: the runner reads every account in that account's own
  // directory, and an account it has not read shows none rather than borrowing another's.
  const snapshot = accountPlanUsage(runner.planUsage, engine, account.id);
  const quota = account.auth === 'yes' && snapshot ? planUsageRows(snapshot)[0] : undefined;
  return quota ? `${quota.label} ${quota.percent}% · ${signIn}` : signIn;
}

interface AccountOption {
  value: string;
  label: string;
  status: string;
}

/** What one engine's account field calls itself and the variable it replaces. */
const ENGINE_COPY: Record<string, { label: string; envVar: string; sessions: string }> = {
  codex: { label: 'Codex account', envVar: 'CODEX_HOME', sessions: 'Codex' },
  claude: { label: 'Claude account', envVar: 'CLAUDE_CONFIG_DIR', sessions: 'Claude' },
};

/**
 * Which account of `engine` this workspace's sessions run on (the workspace form's Advanced part).
 * The choice is stored as the account's id and resolved on the runner that runs the session, so an id
 * this runner does not report runs on Default — which its option says.
 *
 * On a runner with more than one account of the engine `null` is Automatic: each new session starts on
 * the account whose quota resets soonest, and moves when that account's usage limit stops it
 * (automaticAccount on the server), so Default is saved as `default` there, a choice of its own. With
 * one account `null` is Default.
 *
 * `envDir` is the engine's own config-directory variable typed into the same form's environment:
 * until an account is picked here that is where the sessions run, and a picked account replaces it.
 * Either way the field says so, rather than naming an account the sessions are not on.
 */
export function AccountSelect({
  engine,
  runner,
  value,
  onChange,
  envDir,
}: {
  engine: LoginEngine;
  runner: Runner;
  value: string | null;
  onChange: (next: string | null) => void;
  envDir?: string;
}) {
  const copy = ENGINE_COPY[engine] ?? { label: 'Account', envVar: '', sessions: engine };
  const health = runner.engines?.find((entry) => entry.engine === engine);
  const accounts = accountsOf(runner, engine);
  const automatic = accounts.length >= 2;
  const options: AccountOption[] = accounts.map((account) => ({
    value: account.id,
    label:
      account.id === DEFAULT
        ? `Default (${tildePath(accountDir(account))})`
        : account.name || `Account ${account.id}`,
    status: accountStatus(runner, engine, account),
  }));
  // A runner that lists no accounts still has Default: the engine's own sign-in is its.
  if (!accounts.some((account) => account.id === DEFAULT)) {
    const auth = health?.installed ? health.auth : 'unknown';
    options.unshift({
      value: DEFAULT,
      label: 'Default',
      status: accountStatus(runner, engine, { id: DEFAULT, auth }),
    });
  }
  if (value !== null && value !== DEFAULT && !accounts.some((account) => account.id === value)) {
    options.push({
      value,
      label: `Account ${value}`,
      status: 'not on this runner — sessions run on Default',
    });
  }
  if (automatic) {
    options.unshift({
      value: AUTOMATIC,
      label: 'Automatic',
      status: 'each new session starts on the account whose quota resets soonest',
    });
  }
  const typedDir = envDir?.trim();
  // A pick this runner does not report injects nothing, and neither does Default, so a typed directory
  // still applies to them.
  const replacesTyped = value !== null && value !== DEFAULT && accounts.some((account) => account.id === value);
  return (
    <div className="rd-form-field">
      <div className="rd-form-label">{copy.label}</div>
      <Select<string, AccountOption>
        className="rd-codex-account"
        value={value ?? (automatic ? AUTOMATIC : DEFAULT)}
        onChange={(next) => onChange(next === AUTOMATIC || (!automatic && next === DEFAULT) ? null : next)}
        options={options}
        optionRender={(option) => (
          <div>
            <div>{option.data.label}</div>
            <div className="rd-codex-account-status">{option.data.status}</div>
          </div>
        )}
      />
      <div className="rd-path-hint rd-path-muted">
        {automatic
          ? `Only applies to sessions that run ${copy.sessions} on this machine. Automatic starts each new ` +
            'session on the account whose quota resets soonest, so none of it goes unused, and moves it ' +
            'when that account hits its limit.'
          : `Only applies to sessions that run ${copy.sessions} on this machine. Leave it on Default unless ` +
            'this repo needs the other account.'}
      </div>
      {typedDir && copy.envVar && (
        <div className="rd-path-hint rd-path-warn">
          {replacesTyped
            ? `The account picked here replaces ${copy.envVar}=${tildePath(typedDir)} from ` +
              'Environment variables.'
            : `${copy.envVar} is set under Environment variables, so sessions run in ` +
              `${tildePath(typedDir)}, not ${value === null && automatic ? 'on an automatic pick' : 'Default'}.`}
        </div>
      )}
    </div>
  );
}
