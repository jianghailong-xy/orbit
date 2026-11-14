import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownerChatWords } from './ownerChatReply';

/** `owner-chat-reply.fixture.json` is the contract the runner and every client are proved against. */
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'owner-chat-reply.fixture.json'), 'utf8')) as {
  cases: { name: string; result: string; words: string | null }[];
};

describe("the owner's words from a Chat about this, read back from the result", () => {
  it.each(fixture.cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    expect(ownerChatWords(c.result)).toBe(c.words);
  });
});
