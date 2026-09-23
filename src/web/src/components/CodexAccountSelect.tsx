import { Select } from 'antd';
import type { RunnerEngineAccount } from '@orbit/shared';
import { planUsageRows, planUsageSnapshotForProvider } from '../lib/planUsage';
import { tildePath } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/** The account every runner has: the CODEX_HOME its own environment selects. */
const DEFAULT = 'default';

/** The Codex accounts a runner reported, Default first. None from a runner too old to list them. */
export function codexAccountsOf(runner: Runner | null | undefined): RunnerEngineAccount[] {
  return runner?.engines?.find((engine) => engine.engine === 'codex')?.accounts ?? [];
}

/**
 * Whether a workspace form on this runner asks which Codex account to run on: only once the machine
 * has more than one, so a single-account runner's form is what it always was — or when the
 * workspace already names one, so a choice the runner no longer reports can still be seen and
 * undone.
 */
export function offersCodexAccount(
  runner: Runner | null | undefined,
  value: string | null,
): boolean {
  return codexAccountsOf(runner).length >= 2 || value !== null;
}

/** An account's own line under its name: its quota where one is reported, and its sign-in. */
function accountStatus(runner: Runner, account: Pick<RunnerEngineAccount, 'id' | 'auth'>): string {
  const signIn =
    account.auth === 'yes' ? 'signed in' : account.auth === 'no' ? 'signed out' : 'sign-in unknown';
  // The runner's usage probe reads Default, so Default's is the only quota there is to show — the
  // same rule as the account rows on Providers. Another account's would be Default's numbers.
  const snapshot =
    account.id === DEFAULT ? planUsageSnapshotForProvider(runner.planUsage, 'codex') : null;
  const quota = account.auth === 'yes' && snapshot ? planUsageRows(snapshot)[0] : undefined;
  return quota ? `${quota.label} ${quota.percent}% · ${signIn}` : signIn;
}

interface AccountOption {
  value: string;
  label: string;
  status: string;
}

/**
 * Which Codex account this workspace's Codex sessions run on (the workspace form's Advanced part).
 * `null` is Default. The choice is stored as the account's id and resolved on the runner that runs
 * the session, so an id this runner does not report runs on Default — which its option says.
 *
 * `envCodexHome` is a CODEX_HOME typed into the same form's environment variables: until an account
 * is picked here that is where the sessions run, and a picked account replaces it. Either way the
 * field says so, rather than naming an account the sessions are not on.
 */
export function CodexAccountSelect({
  runner,
  value,
  onChange,
  envCodexHome,
}: {
  runner: Runner;
  value: string | null;
  onChange: (next: string | null) => void;
  envCodexHome?: string;
}) {
  const codex = runner.engines?.find((engine) => engine.engine === 'codex');
  const accounts = codex?.accounts ?? [];
  const options: AccountOption[] = accounts.map((account) => ({
    value: account.id,
    label:
      account.id === DEFAULT
        ? `Default (${tildePath(account.codexHome)})`
        : account.name || `Account ${account.id}`,
    status: accountStatus(runner, account),
  }));
  // A runner that lists no accounts still has Default: the engine's own sign-in is its.
  if (!accounts.some((account) => account.id === DEFAULT)) {
    const auth = codex?.installed ? codex.auth : 'unknown';
    options.unshift({
      value: DEFAULT,
      label: 'Default',
      status: accountStatus(runner, { id: DEFAULT, auth }),
    });
  }
  if (value !== null && !accounts.some((account) => account.id === value)) {
    options.push({
      value,
      label: `Account ${value}`,
      status: 'not on this runner — sessions run on Default',
    });
  }
  const typedHome = envCodexHome?.trim();
  // A pick this runner does not report injects nothing, so a typed CODEX_HOME still applies to it.
  const replacesTyped = value !== null && accounts.some((account) => account.id === value);
  return (
    <div className="rd-form-field">
      <div className="rd-form-label">Codex account</div>
      <Select<string, AccountOption>
        className="rd-codex-account"
        value={value ?? DEFAULT}
        onChange={(next) => onChange(next === DEFAULT ? null : next)}
        options={options}
        optionRender={(option) => (
          <div>
            <div>{option.data.label}</div>
            <div className="rd-codex-account-status">{option.data.status}</div>
          </div>
        )}
      />
      <div className="rd-path-hint rd-path-muted">
        Only applies to sessions that run Codex on this machine. Leave it on Default unless this
        repo needs the other account.
      </div>
      {typedHome && (
        <div className="rd-path-hint rd-path-warn">
          {replacesTyped
            ? `The account picked here replaces CODEX_HOME=${tildePath(typedHome)} from ` +
              'Environment variables.'
            : 'CODEX_HOME is set under Environment variables, so sessions run in ' +
              `${tildePath(typedHome)}, not Default.`}
        </div>
      )}
    </div>
  );
}
