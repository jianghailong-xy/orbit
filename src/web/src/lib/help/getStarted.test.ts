import { describe, expect, it } from 'vitest';
import { getStartedSteps, type GetStartedAccount } from './getStarted';

/** A brand-new account: nothing of the four. */
const empty: GetStartedAccount = { machines: [], keys: [], pools: [], workspaces: [], hasDoneTask: false };

const ticks = (account: GetStartedAccount) =>
  Object.fromEntries(getStartedSteps(account).map((step) => [step.key, step.done]));

describe('the Get started checklist, ticked from the account', () => {
  it('ticks nothing for a new account, and says what to do for each step', () => {
    expect(ticks(empty)).toEqual({ machine: false, model: false, workspace: false, task: false });
    expect(getStartedSteps(empty).map((s) => [s.title, s.detail, s.to])).toEqual([
      ['Add a machine', 'Run one command on a computer.', '/settings/machines/new'],
      ['Connect a model', 'Sign an engine in, or add an API key.', '/settings/providers/new'],
      ['Open a workspace', 'Point Orbit at a repository.', '/settings/workspaces/new'],
      ['Finish a first task', 'From request to merged change.', '/help/get-started/your-first-task'],
    ]);
  });

  it('ticks Add a machine only for an online machine, and names it', () => {
    const offline = { ...empty, machines: [{ name: 'build-box', online: false }] };
    expect(ticks(offline).machine).toBe(false);
    const online = { ...empty, machines: [{ name: 'build-box', online: false }, { name: 'mia-macbook', online: true }] };
    expect(ticks(online).machine).toBe(true);
    expect(getStartedSteps(online)[0].detail).toBe('mia-macbook is online');
  });

  it('ticks Connect a model for a signed-in engine, an API key or an account pool, and not for a signed-out engine', () => {
    const signedOut = { ...empty, machines: [{ name: 'm', online: true, engines: [{ engine: 'claude', auth: 'no' }] }] };
    expect(ticks(signedOut).model).toBe(false);
    const engine = { ...empty, machines: [{ name: 'm', online: true, engines: [{ engine: 'claude', auth: 'yes' }] }] };
    expect(ticks(engine).model).toBe(true);
    expect(getStartedSteps(engine)[1].detail).toBe('Claude Code signed in');
    const key = { ...empty, keys: [{ label: 'DeepSeek' }] };
    expect(ticks(key).model).toBe(true);
    expect(getStartedSteps(key)[1].detail).toBe('DeepSeek');
    expect(ticks({ ...empty, pools: [{ id: 'p' }] }).model).toBe(true);
  });

  it('ticks Open a workspace once there is one', () => {
    const account = { ...empty, workspaces: [{ name: 'orbit' }] };
    expect(ticks(account).workspace).toBe(true);
    expect(getStartedSteps(account)[2].detail).toBe('orbit');
  });

  it('ticks Finish a first task once a task is done', () => {
    expect(ticks({ ...empty, hasDoneTask: true }).task).toBe(true);
  });

  it('ticks all four for a set-up account', () => {
    const all: GetStartedAccount = {
      machines: [{ name: 'm', online: true, engines: [{ engine: 'codex', auth: 'yes' }] }],
      keys: [],
      pools: [],
      workspaces: [{ name: 'orbit' }],
      hasDoneTask: true,
    };
    expect(ticks(all)).toEqual({ machine: true, model: true, workspace: true, task: true });
  });
});
