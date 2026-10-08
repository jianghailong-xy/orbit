import type { SignupPolicy } from '../auth/sign-in-providers.service';

/**
 * docs/google-sign-in-design.md §5.2 as a table: every row of its two tables, each with what the
 * exchange answers under both sign-up policies. `google-account-resolution.http.spec.ts` runs it
 * against the exchange over in-memory tables, and `google-account-resolution.pg.spec.ts` over
 * PostgreSQL, through the fake Google.
 *
 * Emails and names are templates: `{tag}` is replaced by a lowercase tag of the run, the case and the
 * policy, so that on one database no case meets another's accounts.
 */

/** An Orbit account a case starts with, with a password. */
export interface SeedAccount {
  email: string;
  /** The Google account linked to it: the one that signs in (ME), another one (OTHER), or none. */
  linkedTo?: 'ME' | 'OTHER';
  /** An administrator disabled it (§5.5). */
  disabled?: true;
}

/** The Google account that signs in, as its verified ID token describes it. */
export interface SigningIn {
  email: string;
  hd?: string;
  name?: string;
}

export type ResolutionRefusal =
  | 'ACCOUNT_DISABLED'
  | 'SETUP_REQUIRED'
  | 'GOOGLE_EMAIL_AMBIGUOUS'
  | 'GOOGLE_ACCOUNT_MISMATCH'
  | 'GOOGLE_EMAIL_NOT_AUTHORITATIVE'
  | 'GOOGLE_ACCOUNT_NOT_FOUND';

export type ResolutionOutcome =
  /** Signs in as the seeded account at `account`; `links` when the exchange links the Google account to it now (AUTO). */
  | { signsInAs: number; links: boolean }
  /** An account is opened for the Google account (SIGNUP) with this name, and signed in. */
  | { opens: { name: string } }
  /** 403 with this code, and nothing written. */
  | { refused: ResolutionRefusal };

export interface ResolutionCase {
  /** The row of §5.2 it is: `1`–`6` of the first table, `3:` and the row of the second. */
  row: string;
  what: string;
  /** Empty: the deployment has no account at all. */
  accounts: SeedAccount[];
  signingIn: SigningIn;
  expect: Record<SignupPolicy, ResolutionOutcome>;
}

const both = (outcome: ResolutionOutcome): Record<SignupPolicy, ResolutionOutcome> => ({ EXISTING_ACCOUNTS: outcome, OPEN: outcome });
const opensUnderOpenOnly = (name: string): Record<SignupPolicy, ResolutionOutcome> => ({
  EXISTING_ACCOUNTS: { refused: 'GOOGLE_ACCOUNT_NOT_FOUND' },
  OPEN: { opens: { name } },
});

/** The name Google gives in the 80-character case: 101 characters, the 80th of them outside the BMP. */
export const LONG_NAME = `${'x'.repeat(79)}🙂${'y'.repeat(21)}`;

export const RESOLUTION_CASES: readonly ResolutionCase[] = [
  {
    row: '1',
    what: 'the Google account is linked: it signs in, whatever its email now is',
    accounts: [{ email: 'ada.{tag}@example.com', linkedTo: 'ME' }],
    signingIn: { email: 'ada.{tag}@gmail.com', hd: 'example.com', name: 'Ada Lovelace' },
    expect: both({ signsInAs: 0, links: false }),
  },
  {
    row: '1',
    what: 'the Google account is linked, and its email is another account\'s: the link decides, before any email',
    accounts: [{ email: 'lin.{tag}@example.com', linkedTo: 'ME' }, { email: 'lin.{tag}@corp.example' }],
    signingIn: { email: 'lin.{tag}@corp.example' },
    expect: both({ signsInAs: 0, links: false }),
  },
  {
    row: '1',
    what: 'the Google account is linked to an account an administrator disabled',
    accounts: [{ email: 'babbage.{tag}@example.com', linkedTo: 'ME', disabled: true }],
    signingIn: { email: 'babbage.{tag}@gmail.com', name: 'Charles Babbage' },
    expect: both({ refused: 'ACCOUNT_DISABLED' }),
  },
  {
    row: '2',
    what: 'the deployment has no account yet',
    accounts: [],
    signingIn: { email: 'first.{tag}@gmail.com', name: 'First' },
    expect: both({ refused: 'SETUP_REQUIRED' }),
  },
  {
    row: '3: disabled',
    what: 'the one account with this email, a gmail.com address an administrator disabled: refused, not linked',
    accounts: [{ email: 'lamarr.{tag}@gmail.com', disabled: true }],
    signingIn: { email: 'lamarr.{tag}@gmail.com' },
    expect: both({ refused: 'ACCOUNT_DISABLED' }),
  },
  {
    row: '3: disabled',
    what: 'the one account with this email is disabled and linked to another Google account: disabled is the first answer',
    accounts: [{ email: 'hamilton.{tag}@gmail.com', linkedTo: 'OTHER', disabled: true }],
    signingIn: { email: 'hamilton.{tag}@gmail.com' },
    expect: both({ refused: 'ACCOUNT_DISABLED' }),
  },
  {
    row: '3: disabled',
    what: 'the one account with this email is disabled, and Google is not authoritative for it: disabled is the first answer',
    accounts: [{ email: 'goldberg.{tag}@corp.example', disabled: true }],
    signingIn: { email: 'goldberg.{tag}@corp.example' },
    expect: both({ refused: 'ACCOUNT_DISABLED' }),
  },
  {
    row: '3: linked to another Google account',
    what: 'the one account with this email signs in with a different Google account',
    accounts: [{ email: 'grace.{tag}@gmail.com', linkedTo: 'OTHER' }],
    signingIn: { email: 'grace.{tag}@gmail.com' },
    expect: both({ refused: 'GOOGLE_ACCOUNT_MISMATCH' }),
  },
  {
    row: '3: not authoritative',
    what: 'the one account with this email, which a personal Google account registered without Gmail or Workspace',
    accounts: [{ email: 'hopper.{tag}@corp.example' }],
    signingIn: { email: 'hopper.{tag}@corp.example', name: 'Grace Hopper' },
    expect: both({ refused: 'GOOGLE_EMAIL_NOT_AUTHORITATIVE' }),
  },
  {
    row: '3: authoritative',
    what: 'the one account with this email, a gmail.com address: linked, and signed in',
    accounts: [{ email: 'turing.{tag}@gmail.com' }],
    signingIn: { email: 'turing.{tag}@gmail.com' },
    expect: both({ signsInAs: 0, links: true }),
  },
  {
    row: '3: authoritative',
    what: 'the one account with this email, a googlemail.com address: linked, and signed in',
    accounts: [{ email: 'noether.{tag}@googlemail.com' }],
    signingIn: { email: 'noether.{tag}@googlemail.com' },
    expect: both({ signsInAs: 0, links: true }),
  },
  {
    row: '3: authoritative',
    what: 'the one account with this email, the address of a Workspace account (hd): linked, and signed in',
    accounts: [{ email: 'shannon.{tag}@corp.example' }],
    signingIn: { email: 'shannon.{tag}@corp.example', hd: 'corp.example' },
    expect: both({ signsInAs: 0, links: true }),
  },
  {
    row: '3: authoritative',
    what: 'the one account with this email written in other letter cases: linked, and signed in',
    accounts: [{ email: 'Knuth.{tag}@Gmail.com' }],
    signingIn: { email: 'knuth.{tag}@gmail.com' },
    expect: both({ signsInAs: 0, links: true }),
  },
  {
    row: '4',
    what: 'two accounts have this email, differing only in letter case — one of them exactly',
    accounts: [{ email: 'Dup.{tag}@gmail.com' }, { email: 'dup.{tag}@gmail.com' }],
    signingIn: { email: 'dup.{tag}@gmail.com' },
    expect: both({ refused: 'GOOGLE_EMAIL_AMBIGUOUS' }),
  },
  {
    row: '5, 6',
    what: 'no account has this email, a Gmail address',
    accounts: [{ email: 'admin.{tag}@example.com' }],
    signingIn: { email: 'new.{tag}@gmail.com', name: 'Ada Lovelace' },
    expect: opensUnderOpenOnly('Ada Lovelace'),
  },
  {
    row: '5, 6',
    what: 'no account has this email, one Google is not authoritative for — which only linking asks',
    accounts: [{ email: 'admin.{tag}@example.com' }],
    signingIn: { email: 'new.{tag}@corp.example', name: '  Lin Hu  ' },
    expect: opensUnderOpenOnly('Lin Hu'),
  },
  {
    row: '5, 6',
    what: 'no account has this email, and Google\'s name is longer than 80 characters',
    accounts: [{ email: 'admin.{tag}@example.com' }],
    signingIn: { email: 'long.{tag}@gmail.com', name: LONG_NAME },
    expect: opensUnderOpenOnly(`${'x'.repeat(79)}🙂`),
  },
  {
    row: '5, 6',
    what: 'no account has this email, and Google gives no name',
    accounts: [{ email: 'admin.{tag}@example.com' }],
    signingIn: { email: 'nameless.{tag}@gmail.com' },
    expect: opensUnderOpenOnly('nameless.{tag}'),
  },
  {
    row: '5, 6',
    what: 'no account has this email, and Google\'s name is blank',
    accounts: [{ email: 'admin.{tag}@example.com' }],
    signingIn: { email: 'blank.{tag}@gmail.com', name: '   ' },
    expect: opensUnderOpenOnly('blank.{tag}'),
  },
];

/** A template with its tag. */
export const tagged = (template: string, tag: string): string => template.replaceAll('{tag}', tag);
