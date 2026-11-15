import { ENGINE_CLI_NAME } from '../runnerEngines';

/**
 * The /help home's Get started checklist (docs/mocks/help-center board 01 §3): four steps ticked from what
 * the account really has, not from what the reader clicked.
 */

export interface GetStartedAccount {
  machines: ReadonlyArray<{ name: string; online: boolean; engines?: ReadonlyArray<{ engine: string; auth?: string }> }>;
  /** API keys the account has connected. */
  keys: ReadonlyArray<{ label: string }>;
  /** Account pools. */
  pools: ReadonlyArray<unknown>;
  workspaces: ReadonlyArray<{ name: string }>;
  /** Whether any of the account's tasks is DONE: done work is what Orbit lands on main. */
  hasDoneTask: boolean;
}

export interface GetStartedStep {
  key: 'machine' | 'model' | 'workspace' | 'task';
  title: string;
  done: boolean;
  /** What it says under the title: what was found when done, what to do when not. */
  detail: string;
  /** Where Start goes. */
  to: string;
}

export function getStartedSteps(account: GetStartedAccount): GetStartedStep[] {
  const online = account.machines.find((m) => m.online);
  let signedIn: string | null = null;
  for (const machine of account.machines) {
    const engine = machine.engines?.find((e) => e.auth === 'yes');
    if (engine) {
      signedIn = `${ENGINE_CLI_NAME[engine.engine as keyof typeof ENGINE_CLI_NAME] ?? engine.engine} signed in`;
      break;
    }
  }
  const model = signedIn ?? account.keys[0]?.label ?? (account.pools.length > 0 ? 'Account pool' : null);
  const workspace = account.workspaces[0];
  return [
    {
      key: 'machine',
      title: 'Add a machine',
      done: !!online,
      detail: online ? `${online.name} is online` : 'Run one command on a computer.',
      to: '/settings/machines/new',
    },
    {
      key: 'model',
      title: 'Connect a model',
      done: model !== null,
      detail: model ?? 'Sign an engine in, or add an API key.',
      to: '/settings/providers/new',
    },
    {
      key: 'workspace',
      title: 'Open a workspace',
      done: !!workspace,
      detail: workspace ? workspace.name : 'Point Orbit at a repository.',
      to: '/settings/workspaces/new',
    },
    {
      key: 'task',
      title: 'Finish a first task',
      done: account.hasDoneTask,
      detail: account.hasDoneTask ? 'A task is done' : 'From request to merged change.',
      to: '/help/get-started/your-first-task',
    },
  ];
}
