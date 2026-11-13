import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Where the /api/gw/anthropic gateway may send a key's requests (docs/claude-engine-openai-gateway-design.md
 * §5.3, decision D3). The gateway calls a URL taken from a key row, so a row aimed at an internal address would
 * make the API server a proxy into its own network. The rule: https only, to `api.openai.com` or a host the
 * deployment admin lists in ORBIT_GATEWAY_UPSTREAM_HOSTS; the name is resolved before connecting, every address
 * it resolves to must be public, and the connection is pinned to the address that was checked. Redirects are
 * never followed (AnthropicGatewayService answers a 3xx as an error).
 */

export const GATEWAY_UPSTREAM_HOSTS_ENV = 'ORBIT_GATEWAY_UPSTREAM_HOSTS';
export const OPENAI_API_HOST = 'api.openai.com';

/** A name as it is compared: lower case, without a trailing dot. */
function normalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** api.openai.com and the admin's comma- or space-separated list, read on every call so a spec can set it. */
export function allowedUpstreamHosts(): Set<string> {
  const listed = (process.env[GATEWAY_UPSTREAM_HOSTS_ENV] ?? '').split(/[\s,]+/).map(normalHost).filter(Boolean);
  return new Set([OPENAI_API_HOST, ...listed]);
}

/** Loopback, private, link-local and every other range that is not the public internet. */
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network", including 0.0.0.0
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata at 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
] as const) NOT_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: an IPv4 address in IPv6 clothing, a way around the IPv4 ranges
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) NOT_PUBLIC.addSubnet(net, prefix, 'ipv6');
/**
 * IPv4-mapped IPv6 (::ffff:0:0/96), likewise never what a public name resolves to. A list of its own: a BlockList
 * matches every IPv4 address it is asked about against an IPv4-mapped rule.
 */
const MAPPED = new BlockList();
MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');

/** Whether `address` (an IP literal) is one the gateway must never connect to. Not an IP at all counts as not public. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6 && MAPPED.check(address, 'ipv6')) return true;
  return NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Why the gateway may not call `baseUrl`, read off the URL alone (no DNS): not an https URL, a host that is
 * neither api.openai.com nor listed, or an IP literal outside the public internet. Null when the URL may be
 * called, subject to what its name resolves to at the request (vetUpstream).
 */
export function upstreamUrlRefusal(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return 'its endpoint is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'its endpoint is not an https URL';
  if (url.username || url.password) return 'its endpoint carries a user name or password';
  const host = normalHost(url.hostname.replace(/^\[|\]$/g, ''));
  if (!allowedUpstreamHosts().has(host)) return `its host ${host} is not ${OPENAI_API_HOST} or a host listed in ${GATEWAY_UPSTREAM_HOSTS_ENV}`;
  if (isIP(host) && isNonPublicAddress(host)) return `its host ${host} is a private, loopback or link-local address`;
  return null;
}

/** What resolving a name answers: every address, as dns.promises.lookup with `all: true` gives them. */
export type HostResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export const resolveHost: HostResolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/** A vetted upstream: the address to connect to, and a lookup that answers only it. */
export interface VettedUpstream {
  address: string;
  family: 4 | 6;
  lookup: LookupFunction;
}

/** Refused before any connection: `reason` says why, in words that follow "the key … may not be used because". */
export class UpstreamRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Checks `baseUrl` and resolves its host, before anything connects: refused (UpstreamRefused) for a URL
 * upstreamUrlRefusal refuses, and for a name any of whose addresses is not public — one bad answer refuses the
 * name, so a resolver cannot be raced into handing out the internal one. A resolver failure is thrown as it is.
 * The connection is then pinned to the address checked here, so a second lookup cannot answer differently.
 */
export async function vetUpstream(baseUrl: string, resolve: HostResolver = resolveHost): Promise<VettedUpstream> {
  const refusal = upstreamUrlRefusal(baseUrl);
  if (refusal) throw new UpstreamRefused(refusal);
  const host = normalHost(new URL(baseUrl.trim()).hostname.replace(/^\[|\]$/g, ''));
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (addresses.length === 0) throw new Error(`${host} resolved to no address`);
  const bad = addresses.find((a) => isNonPublicAddress(a.address));
  if (bad) throw new UpstreamRefused(`its host ${host} resolves to ${bad.address}, a private, loopback or link-local address`);
  const { address } = addresses[0];
  const family = isIP(address) as 4 | 6;
  const lookup = ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as LookupFunction;
  return { address, family, lookup };
}
