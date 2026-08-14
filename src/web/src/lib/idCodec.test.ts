import { describe, expect, it } from 'vitest';
import { uuidToBase62 } from '@orbit/shared';
import { decodeId, encodeId } from './idCodec';

const UUID = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const B62 = uuidToBase62(UUID);

// This module is the web's whole id boundary: every link is built through encodeId and every
// route param is read through decodeId. Both have to survive the server changing which spelling
// it hands out (docs/public-id-migration-design.md), because neither has a call site that checks.
describe('encodeId', () => {
  it('encodes a UUID to the short public id', () => {
    expect(encodeId(UUID)).toBe(B62);
  });

  // The property that lets 27 link-building call sites go untouched through the Phase 3 flip.
  it('is idempotent, so an id that is already public survives re-encoding', () => {
    expect(encodeId(B62)).toBe(B62);
    expect(encodeId(encodeId(UUID))).toBe(B62);
  });

  it('canonicalizes a UUID that arrives uppercased', () => {
    expect(encodeId(UUID.toUpperCase())).toBe(B62);
  });

  // Unchanged from before it was made idempotent: a caller that cannot name what it links to has
  // a bug, and silently emitting a link to nowhere would hide it.
  it('still throws on a value that is neither spelling', () => {
    expect(() => encodeId('not an id')).toThrow();
    expect(() => encodeId('')).toThrow();
  });
});

describe('decodeId', () => {
  it('accepts either spelling from the URL and yields the UUID', () => {
    expect(decodeId(B62)).toBe(UUID);
    expect(decodeId(UUID)).toBe(UUID);
    expect(decodeId(UUID.toUpperCase())).toBe(UUID);
  });

  it('is null for an absent param, so a caller can branch on "no id"', () => {
    expect(decodeId(null)).toBeNull();
    expect(decodeId(undefined)).toBeNull();
    expect(decodeId('')).toBeNull();
  });

  // A malformed link has to degrade to a "not found" view rather than crash the router.
  it('passes an undecodable param through instead of throwing', () => {
    expect(decodeId('not an id')).toBe('not an id');
  });

  it('round-trips with encodeId', () => {
    expect(decodeId(encodeId(UUID))).toBe(UUID);
  });
});
