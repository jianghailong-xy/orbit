import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SharedRateLimiter, canonicalAddress, clientAddress, isInternalAddress, trustedProxies } from './public-surface.guard';

const refused = (take: () => void) =>
  assert.throws(
    take,
    (e: unknown) => e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
  );

test('a key spends its budget inside a window and gets it back as the window slides', () => {
  const limiter = new SharedRateLimiter({ max: 2, windowMs: 1_000 });
  limiter.take('a', 0);
  limiter.take('a', 500);
  refused(() => limiter.take('a', 999));
  limiter.take('b', 999); // another key is a budget of its own
  limiter.take('a', 1_000); // the request at 0 has left the window
  refused(() => limiter.take('a', 1_400));
});

test('keys whose window has ended are dropped, so made-up keys cannot pile up', () => {
  const limiter = new SharedRateLimiter({ max: 2, windowMs: 1_000 });
  for (let i = 0; i < 100; i += 1) limiter.take(`10.0.0.${i} token-${i}`, 10);
  assert.equal(limiter.size, 100);
  limiter.take('10.0.0.200 token-late', 1_010);
  assert.equal(limiter.size, 1);
});

// Where a visitor is, read behind the proxies. 198.51.100.0/24 and 2001:db8:cf::/48 stand for a CDN's edge,
// 10.0.0.0/8 for a load balancer behind it; 203.0.113.24 is the person, 203.0.113.66 what they claim to be.
const NOTHING = trustedProxies('');
const CDN = trustedProxies('198.51.100.0/24, 2001:db8:cf::/48');

test('TRUSTED_PROXIES: addresses and ranges, by commas or spaces; anything else stops the apiserver at boot', () => {
  const trusted = trustedProxies(' 198.51.100.0/24,10.0.0.2\n2001:db8:cf::/48 ');
  for (const address of ['198.51.100.7', '10.0.0.2']) assert.equal(trusted.check(address, 'ipv4'), true, address);
  assert.equal(trusted.check('2001:db8:cf::7', 'ipv6'), true);
  for (const address of ['198.51.101.7', '10.0.0.3']) assert.equal(trusted.check(address, 'ipv4'), false, address);
  assert.equal(NOTHING.rules.length, 0);
  for (const entry of ['proxy.example.com', '198.51.100.0/33', '2001:db8::/129', '198.51.100.0/', '198.51.100.0/24/8', '198.51.100.0/x']) {
    assert.throws(() => trustedProxies(`10.0.0.2, ${entry}`), new RegExp(`TRUSTED_PROXIES: "${entry.replace(/[./]/g, '\\$&')}" is not`), entry);
  }
});

test('one spelling per address: IPv4 mapped into IPv6 is the IPv4 address, IPv6 its shortest lowercase form', () => {
  assert.equal(canonicalAddress('::ffff:203.0.113.24'), '203.0.113.24');
  assert.equal(canonicalAddress('0:0:0:0:0:FFFF:203.0.113.24'), '203.0.113.24');
  assert.equal(canonicalAddress('::ffff:cb00:7118'), '203.0.113.24');
  assert.equal(canonicalAddress('2001:DB8:ABCD:0:0:0:0:24'), '2001:db8:abcd::24');
  for (const as of ['203.0.113.24', '::1', '2001:db8:abcd::24', 'fe80::1%eth0', 'unknown', '']) assert.equal(canonicalAddress(as), as);
});

test('with nothing trusted, the address that reached the gateway is the visitor and X-Forwarded-For counts for nothing', () => {
  assert.equal(clientAddress('198.51.100.7', '203.0.113.66, 203.0.113.24, 198.51.100.7', NOTHING), '198.51.100.7');
  assert.equal(clientAddress('::ffff:127.0.0.1', '203.0.113.24', NOTHING), '127.0.0.1');
});

test('behind trusted proxies, the chain is read from its right end up to the first address that is not one', () => {
  // A CDN edge reached the gateway; the edge appended the person, who had written an address of their own first.
  assert.equal(clientAddress('198.51.100.7', '203.0.113.66, 203.0.113.24, 198.51.100.7', CDN), '203.0.113.24');
  // A proxy that sends X-Real-IP without appending itself to the chain.
  assert.equal(clientAddress('198.51.100.7', '203.0.113.24', CDN), '203.0.113.24');
  // Two trusted hops, a load balancer behind the CDN.
  assert.equal(
    clientAddress('10.0.0.2', '203.0.113.24, 198.51.100.7, 10.0.0.2', trustedProxies('198.51.100.0/24 10.0.0.0/8')),
    '203.0.113.24',
  );
  // A proxy address the person wrote into their own chain is left of their real one, and never reached.
  assert.equal(clientAddress('198.51.100.7', '203.0.113.66, 198.51.100.9, 203.0.113.24, 198.51.100.7', CDN), '203.0.113.24');
  // The header sent twice reads as one chain.
  assert.equal(clientAddress('198.51.100.7', ['203.0.113.24', '198.51.100.7'], CDN), '203.0.113.24');
  // A hop that is not an address ends the walk at the last proxy trusted.
  assert.equal(clientAddress('198.51.100.7', 'unknown, 198.51.100.7', CDN), '198.51.100.7');
});

test('an IPv6 visitor through IPv6 and IPv4 edges, and a dual-stack socket\'s IPv4 peer, each in one spelling', () => {
  assert.equal(clientAddress('2001:db8:cf::7', '2001:DB8:ABCD:0:0:0:0:24, 2001:db8:cf::7', CDN), '2001:db8:abcd::24');
  assert.equal(clientAddress('198.51.100.7', '2001:db8:abcd::24, 198.51.100.7', CDN), '2001:db8:abcd::24');
  assert.equal(clientAddress('::ffff:198.51.100.7', '::ffff:203.0.113.24, 198.51.100.7', CDN), '203.0.113.24');
});

test('loopback, private and link-local addresses are internal; public ones and non-addresses are not', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.20', '169.254.1.1', '::1', 'fd12:3456::1', 'fe80::1']) {
    assert.equal(isInternalAddress(address), true, address);
  }
  for (const address of ['203.0.113.24', '172.32.0.1', '198.51.100.7', '2001:db8:abcd::24', 'unknown', '']) {
    assert.equal(isInternalAddress(address), false, address);
  }
});
