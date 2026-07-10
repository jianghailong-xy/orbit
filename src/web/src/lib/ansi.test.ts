import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi';

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  it('strips SGR colour codes (the tsc "not the tsc command" banner)', () => {
    const banner = `${ESC}[41m${ESC}[37m   This is not the tsc command   ${ESC}[0m`;
    expect(stripAnsi(banner)).toBe('   This is not the tsc command   ');
  });

  it('strips inline colour spans, keeping the words', () => {
    const line = `- Use ${ESC}[1mnpm install typescript${ESC}[0m before using npx`;
    expect(stripAnsi(line)).toBe('- Use npm install typescript before using npx');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('all good\nno codes here')).toBe('all good\nno codes here');
  });

  it('does not touch literal brackets a user typed (no ESC byte)', () => {
    const literal = 'arr[0] = x; price [41m looks like a code but is not';
    expect(stripAnsi(literal)).toBe(literal);
  });

  it('strips cursor/erase CSI sequences too, not just colours', () => {
    expect(stripAnsi(`loading${ESC}[2K${ESC}[Gdone`)).toBe('loadingdone');
  });
});
