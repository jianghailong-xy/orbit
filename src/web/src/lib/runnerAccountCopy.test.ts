import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as copy from './runnerAccountCopy';

const SOURCE = readFileSync(fileURLToPath(new URL('./runnerAccountCopy.ts', import.meta.url)), 'utf8');

describe('runnerAccountCopy', () => {
  it('says what removing Default from Orbit, and bringing it back, come to', () => {
    expect(copy.runnerAccountRemoveTitle('Default')).toBe('Remove Default?');
    expect(copy.runnerDefaultRemoveDetail('wikova', 'Codex')).toBe(
      'Orbit stops using it on wikova. Its sign-in stays on the machine, and Codex in a terminal there keeps ' +
        'working. Workspaces set to it run on Automatic.',
    );
    expect(copy.runnerAccountRemoveDetailAutomatic('wikova')).toBe(
      'Its sign-in is deleted from wikova. Workspaces set to this account run on Automatic.',
    );
    expect(copy.runnerAccountRemoveDetailLast('wikova', 'Default')).toBe(
      'Its sign-in is deleted from wikova. Without it, Orbit uses Default there again, and workspaces set to ' +
        'this account run on it.',
    );
    expect(copy.runnerDefaultRemovedLine('Default', '~/.codex')).toBe('Default · ~/.codex isn’t used by Orbit');
    expect(copy.RUNNER_DEFAULT_USE_AGAIN).toBe('Use again');
    expect(copy.runnerDefaultUseAgainFailed('Default')).toBe('Couldn’t use Default again');
    expect(copy.ACCOUNT_SELECT_DEFAULT_REMOVED).toBe('removed from Orbit — sessions run on Automatic');
    expect(copy.ACCOUNT_SELECT_GONE_AUTOMATIC).toBe('not on this runner — sessions run on Automatic');
  });

  // The native clients' parity tests read this file as text, as OrbitKit's reads runnerCopy.ts, so its
  // shape is part of the contract.
  it('declares each fixed sentence as one quoted constant', () => {
    const declared = SOURCE.match(/^export const /gm)?.length ?? 0;
    const quoted = [...SOURCE.matchAll(/^export const [A-Z0-9_]+ =\s*'[^'\n]*'(?:\s*\+\s*'[^'\n]*')*;$/gm)];
    expect(declared).toBeGreaterThan(0);
    expect(quoted).toHaveLength(declared);
  });

  it('writes each sentence with values as one template of its own parameters', () => {
    const declared = SOURCE.match(/^export function /gm)?.length ?? 0;
    const templates = [...SOURCE.matchAll(/^export function \w+\(([^)]*)\): string \{\n {2}return `([^`]*)`;\n\}$/gm)];
    expect(declared).toBeGreaterThan(0);
    expect(templates).toHaveLength(declared);
    for (const [, params, template] of templates) {
      const names = params.split(',').map((p) => p.split(':')[0].trim());
      for (const [, used] of template.matchAll(/\$\{([^}]*)\}/g)) {
        expect(names, `\${${used}} in \`${template}\``).toContain(used);
      }
    }
  });
});
