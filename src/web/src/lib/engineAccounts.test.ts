import { describe, expect, it } from 'vitest';
import { defaultAccountName } from './engineAccounts';

describe('the name + Account gives a new account', () => {
  it('is its number on the machine, Default being the first', () => {
    // A runner that lists no accounts has Default alone.
    expect(defaultAccountName([])).toBe('Account 2');
    expect(defaultAccountName([{ id: 'default' }])).toBe('Account 2');
    expect(defaultAccountName([{ id: 'default' }, { id: '3fa91c2e', name: 'Work' }])).toBe('Account 3');
  });

  it('skips a number an account already goes by, a renamed Default included', () => {
    expect(defaultAccountName([{ id: 'default' }, { id: '3fa91c2e', name: 'Account 3' }])).toBe('Account 4');
    expect(defaultAccountName([{ id: 'default', name: 'Account 2' }])).toBe('Account 3');
  });
});
