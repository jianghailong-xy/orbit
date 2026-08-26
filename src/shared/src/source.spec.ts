import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SESSION_SOURCE_PIN_V1,
  SOURCE_FIX_ACTIONS,
  SOURCE_REFUSAL_CODES,
} from './source';

/**
 * The wire vocabulary against `docs/project-source-contract.md` itself.
 *
 * `project-source-contract.spec.ts` already proves the DOCUMENT is self-consistent, and migration
 * 0175 already proves the DATABASE spells the same codes. Neither of them looks at this file, so
 * without these the third copy — the one the control plane, the runner and every client actually
 * import — is the one free to drift. And it is the copy that decides what a person sees.
 *
 * Read out of the document rather than restated here on purpose: a test that lists the ten codes
 * again would pass a rename of the contract's table and fail nothing.
 */

const DOC = readFileSync(
  path.resolve(__dirname, '../../../docs/project-source-contract.md'),
  'utf8',
);

/** §10.1's table: the only rows in the document that start with `| \`CODE\` |`. */
const TABLE = [...DOC.matchAll(/^\| `([A-Z][A-Z_]+)` \|.*\| `([A-Z][A-Z_]+)` \|$/gm)].map(
  ([, code, fixAction]) => ({ code, fixAction }),
);

describe('the SOURCE wire vocabulary', () => {
  it('carries exactly §10.1\'s codes, in §10.1\'s order', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(10);
    // Order matters as much as membership: the table is read top to bottom by anyone comparing the
    // two, and a set comparison would let them silently disagree about which is which.
    expect([...SOURCE_REFUSAL_CODES]).toEqual(TABLE.map((row) => row.code));
  });

  it('pairs every code with the contract\'s own fixAction', () => {
    // SR49: each value must be something a person can DO. The pairing lives in the contract's sixth
    // column, so re-deriving it here would be a second copy free to disagree with the first.
    for (const { code, fixAction } of TABLE) {
      expect(SOURCE_FIX_ACTIONS[code as keyof typeof SOURCE_FIX_ACTIONS]).toBe(fixAction);
    }
    expect(Object.keys(SOURCE_FIX_ACTIONS).sort()).toEqual(TABLE.map((r) => r.code).sort());
  });

  it('spells the capability token the way SR35 spells it', () => {
    // Not cosmetic. This string is compared, not parsed: the runner puts it in a header and the
    // dispatch gate looks for it, so a differently-spelled token is a fleet that silently stops
    // being handed project code tasks — the failure mode is "nothing runs", with nothing to read.
    expect(DOC).toContain(`\`${SESSION_SOURCE_PIN_V1}\``);
    expect(SESSION_SOURCE_PIN_V1).toBe('source-pin/v1');
  });

  it('is spelled so a capability header survives the round trip', () => {
    // The header is comma-separated and the server lowercases and trims each item
    // (parseRunnerCapabilities). A token containing a comma, whitespace or an upper-case letter
    // would arrive as something else, or as two things.
    expect(SESSION_SOURCE_PIN_V1).toBe(SESSION_SOURCE_PIN_V1.trim().toLowerCase());
    expect(SESSION_SOURCE_PIN_V1).not.toContain(',');
  });
});
