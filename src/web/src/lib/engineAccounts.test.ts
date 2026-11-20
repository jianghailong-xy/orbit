import { describe, expect, it } from 'vitest';
import { accountNameOf, defaultAccountName } from './engineAccounts';

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

describe('what an account is called', () => {
  it('is the owner’s name, else Default for the default slot, else the slot', () => {
    expect(accountNameOf({ id: 'default' })).toBe('Default');
    expect(accountNameOf({ id: 'default', name: 'Main' })).toBe('Main');
    expect(accountNameOf({ id: '3fa91c2e' })).toBe('Account 3fa91c2e');
  });

  it('is, for a former Default the owner never named, its email, else "Former default"', () => {
    expect(accountNameOf({ id: '3fa91c2e', formerDefault: true, email: 'me@home.example' })).toBe('me@home.example');
    expect(accountNameOf({ id: '3fa91c2e', formerDefault: true })).toBe('Former default');
    expect(accountNameOf({ id: '3fa91c2e', name: 'Personal', formerDefault: true, email: 'me@home.example' })).toBe('Personal');
    // An email alone, without the server's mark, names nothing.
    expect(accountNameOf({ id: '3fa91c2e', email: 'me@home.example' })).toBe('Account 3fa91c2e');
  });
});
