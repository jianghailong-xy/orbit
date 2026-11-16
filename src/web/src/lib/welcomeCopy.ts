/**
 * Every sentence of a new account's welcome card (docs/mocks/new-user-onboarding, board 02): the card a
 * first sign-in lands on, on a bare machine's setup card and on the
 * registration guide. A file of its own, like machineSetupCopy, so the native clients can read one place
 * when they draw the same card.
 */

/** The first word of the account's name: "Welcome to Orbit, Mia". Without a name, no comma. */
export const welcomeTitle = (name: string | null | undefined): string => {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? `Welcome to Orbit, ${first}` : 'Welcome to Orbit';
};
export const WELCOME_LEAD =
  'Orbit gives a coding agent a computer and a task, and keeps the conversation and its results here — on the web and on your phone.';

export const WELCOME_COMPUTER = 'A computer to work on';
export const WELCOME_COMPUTER_OWN = 'Connect the computer you want the agent to work on. Run this there:';
export const WELCOME_WAITING_CONNECT = 'Waiting for it to connect… this page moves on by itself.';
export const WELCOME_HAVING_TROUBLE = 'Having trouble?';

export const WELCOME_MODEL = 'A model to think with';
export const WELCOME_MODEL_HELP =
  'Sign in with your Claude or ChatGPT subscription, or use an API key. The sign-in stays on that computer.';
export const WELCOME_AFTER_STEP_ONE = 'Opens after step 1';

export const WELCOME_FIRST = 'Your first message';
