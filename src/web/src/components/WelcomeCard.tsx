import { CheckCircleFilled, RocketOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { LoginEngine } from '@orbit/shared';
import { api } from '../api';
import type { ManagedRunner } from '../lib/managedRunner';
import { machineName } from '../lib/machineSetup';
import { SETUP_CHANGE, SETUP_ON_A_KEY, SETUP_ON_A_POOL } from '../lib/machineSetupCopy';
import { meQuery } from '../lib/queries';
import {
  WELCOME_AFTER_COMPUTER,
  WELCOME_COMPUTER,
  WELCOME_COMPUTER_DONE,
  WELCOME_COMPUTER_MANAGED,
  WELCOME_EXAMPLES,
  WELCOME_FIRST,
  WELCOME_FIRST_HELP,
  WELCOME_FOOT_READY,
  WELCOME_FOOT_SEND_NOW,
  WELCOME_FOOT_WAIT,
  WELCOME_LEAD,
  WELCOME_MODEL,
  WELCOME_MODEL_DONE,
  WELCOME_MODEL_HELP,
  WELCOME_OWN_INSTEAD,
  welcomeComputerReady,
  welcomeTitle,
} from '../lib/welcomeCopy';
import type { SetupCredential } from './MachineSetupCard';
import { ManagedRunnerNotice } from './ManagedRunnerNotice';
import { ENGINE_NAME, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';
import './MachineSetupCard.css';

/**
 * Whether this account has never had a session: no Open one and no Completed one. Only then does a
 * draft page wear the welcome card (board 03, rule 1); nothing is stored to remember it. A read that
 * fails, or answers anything but two empty lists, is an account that is not new.
 */
export function useNewAccount(enabled: boolean): boolean {
  const read = (view: 'open' | 'completed') =>
    ({
      queryKey: ['welcome', 'any-session', view] as const,
      queryFn: () => api<unknown>(`/sessions?view=${view}&limit=1`),
      enabled,
      retry: false,
    }) as const;
  const open = useQuery(read('open'));
  const completed = useQuery(read('completed'));
  const empty = (data: unknown) => Array.isArray(data) && data.length === 0;
  return enabled && empty(open.data) && empty(completed.data);
}

/** The card's head: who it greets and what Orbit is, in one sentence. */
export function WelcomeHead() {
  const me = useQuery(meQuery());
  return (
    <div className="msc-head">
      <span className="msc-head-icon">
        <RocketOutlined aria-hidden="true" />
      </span>
      <div>
        <div className="msc-title">{welcomeTitle(me.data?.name)}</div>
        <div className="msc-sub">{WELCOME_LEAD}</div>
      </div>
    </div>
  );
}

/** The last step: three first messages to try. Picking one only fills the composer. */
export function WelcomeExamples({ step, picked, onPick }: { step: number; picked: string; onPick: (text: string) => void }) {
  return (
    <div className="msc-step" data-step="first">
      <span className="msc-num">{step}</span>
      <div>
        <div className="msc-step-title">{WELCOME_FIRST}</div>
        <div className="msc-step-help">{WELCOME_FIRST_HELP}</div>
        <div className="welcome-examples">
          {WELCOME_EXAMPLES.map((text) => (
            <button
              key={text}
              type="button"
              className={`welcome-example${picked.trim() === text ? ' on' : ''}`}
              aria-pressed={picked.trim() === text}
              onClick={() => onPick(text)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A step drawn as one line once it is done. */
function DoneLine({ step, title, detail, onChange }: { step: string; title: string; detail: string; onChange?: () => void }) {
  return (
    <div className="msc-step" data-step={step}>
      <CheckCircleFilled className="msc-num done" />
      <div>
        <div className="msc-done-line">
          <span className="msc-step-title">{title}</span>
          <span className="msc-meta">{detail}</span>
          {onChange && (
            <button className="msc-change" type="button" onClick={onChange}>
              {SETUP_CHANGE}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Kinds where the managed runner is up, whatever it still lacks. */
const UP = new Set(['available', 'modelUnavailable']);

/**
 * A new account's first draft in its managed runner's default workspace: the runner Orbit starts for it,
 * a model to run on, and a first message (board 02, P1 and P2). It stands where the managed runner's
 * notice and the engine hero stand for everybody else; the composer under it is the page's own.
 */
export function ManagedWelcomeCard({
  managed,
  runner,
  engine,
  credential,
  composerText,
  startsNow,
  onExample,
  onUseApiKey,
  onChangeCredential,
}: {
  managed: ManagedRunner;
  runner: Runner;
  /** The engine a sign-in is offered for. */
  engine: LoginEngine;
  credential: SetupCredential;
  composerText: string;
  /** A first session can be sent now (`startsNewSession`): it starts, or waits for the runner. */
  startsNow: boolean;
  onExample: (text: string) => void;
  onUseApiKey: () => void;
  onChangeCredential: () => void;
}) {
  const machine = machineName(runner);
  const up = UP.has(managed.display.kind) || runner.online === true;
  const signedIn = credential.step === 'signedIn' || credential.step === 'onKey';
  const ready = startsNow && up && signedIn;
  const engineName = ENGINE_NAME[engine] ?? engine;
  return (
    <div className="msc welcome-card">
      <WelcomeHead />

      {up ? (
        <DoneLine step="computer" title={WELCOME_COMPUTER_DONE} detail={welcomeComputerReady(machine)} />
      ) : (
        <div className="msc-step" data-step="computer">
          <span className="msc-num">1</span>
          <div>
            <div className="msc-step-title">{WELCOME_COMPUTER}</div>
            <div className="msc-step-help">{WELCOME_COMPUTER_MANAGED}</div>
            {/* The managed runner's own state, its Retry and Set up included: the same words as everywhere. */}
            <ManagedRunnerNotice managed={managed} className="welcome-managed" />
            <div className="msc-alt">
              <Link className="msc-change" to="/runners/register">
                {WELCOME_OWN_INSTEAD}
              </Link>
            </div>
          </div>
        </div>
      )}

      {credential.step === 'signedIn' ? (
        <DoneLine step="model" title={WELCOME_MODEL_DONE} detail={`${engineName} signed in on ${machine}`} />
      ) : credential.step === 'onKey' ? (
        <DoneLine
          step="model"
          title={WELCOME_MODEL_DONE}
          detail={`${credential.label} · ${credential.pool ? SETUP_ON_A_POOL : SETUP_ON_A_KEY}`}
          onChange={onChangeCredential}
        />
      ) : (
        <div className="msc-step" data-step="model">
          <span className="msc-num">2</span>
          <div>
            <div className="msc-step-title">{WELCOME_MODEL}</div>
            <div className="msc-step-help">{WELCOME_MODEL_HELP}</div>
            {runner.online === true ? (
              <RunnerSignIn key={engine} runnerId={runner.id} engine={engine} onUseApiKey={onUseApiKey} />
            ) : (
              <div className="welcome-later">{WELCOME_AFTER_COMPUTER}</div>
            )}
          </div>
        </div>
      )}

      <WelcomeExamples step={3} picked={composerText} onPick={onExample} />

      <div className={`msc-foot${ready ? ' ready' : ''}`}>
        {ready ? WELCOME_FOOT_READY : startsNow ? WELCOME_FOOT_SEND_NOW : WELCOME_FOOT_WAIT}
      </div>
    </div>
  );
}
