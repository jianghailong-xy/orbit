// The web gateway's routes for several apiservers (task 34nb3xgCijTDzQJVXDVT7; docs/self-hosting.md, "Several
// apiservers"): the session streams by session, and the runners' link tokens, over every apiserver.
//
// Two facts decide how the files are laid out, and this file pins both:
//
//   - A deployment keeps the nginx:alpine it first pulled: /upgrade refreshes base images only with --pull-base. The
//     routes need upstream `resolve`, which nginx has since 1.27.3, and an nginx that cannot parse its configuration
//     does not start, which takes every request the gateway serves down with it. So gateway/nginx.conf, which every
//     deployment runs, uses nothing of the kind, and the routes are in gateway/several-apiservers/, which a deployment
//     with more than one apiserver mounts where gateway/nginx.conf includes it.
//   - nginx's consistent hash places a server by its name, so the addresses of one name (the alias every apiserver
//     answers to) would be taken in turn. The session streams use plain hash.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(repo, file), 'utf8');

const main = read('gateway/nginx.conf');
const upstreams = read('gateway/several-apiservers/http/upstreams.conf');
const routes = read('gateway/several-apiservers/server/routes.conf');
// Where gateway/nginx.conf includes the two files from, and where a deployment mounts their directory.
const MOUNT = '/etc/nginx/several-apiservers';
// Where a two-stage deploy writes, inside the running gateway, the container a release hands over to
// (deploy/two-stage/deploy-stage.sh); nothing is mounted there.
const HANDOVER = '/etc/nginx/handover';

/** The configuration without its comments: nginx's comments run from # to the end of the line. */
const uncommented = (conf) => conf.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd()).join('\n');

/** The body of the first block whose header matches `header`, braces counted. */
function block(conf, header) {
  const text = uncommented(conf);
  const at = text.search(header);
  assert.ok(at >= 0, `no block matches ${header}`);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`the block at ${header} does not close`);
}

/** A block's directives, one per statement, whitespace collapsed. */
const directives = (body) => body.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean);

test('every deployment\'s gateway/nginx.conf loads on an nginx older than 1.27.3: no upstream, no resolve', () => {
  const text = uncommented(main);
  assert.doesNotMatch(text, /^\s*upstream\s+\S+\s*\{/m, 'an upstream block');
  assert.doesNotMatch(text, /\sresolve\s*;/, 'a server resolved again at run time');
  assert.doesNotMatch(text, /^\s*zone\s/m, 'a shared memory zone');
  assert.doesNotMatch(text, /orbit-apiservers/);
  // And these find what they look for: the routes for several apiservers have all three.
  const routesHttp = uncommented(upstreams);
  assert.match(routesHttp, /^\s*upstream\s+\S+\s*\{/m);
  assert.match(routesHttp, /\sresolve\s*;/);
  assert.match(routesHttp, /^\s*zone\s/m);
});

test('gateway/nginx.conf includes the routes for several apiservers by globs, which match nothing where nothing is mounted', () => {
  const includes = uncommented(main).match(/^\s*include\s+[^;]+;/gm).map((line) => line.trim());
  assert.deepEqual(includes, [
    `include ${MOUNT}/http/*.conf;`,
    `include ${MOUNT}/server/*.conf;`,
    // The run events' stream: a release handing over (the case below).
    `include ${HANDOVER}/apiserver*.conf;`,
    // Inside the /api/events and /api/ locations: the first apiserver with the others behind it, then a release
    // handing over.
    `include ${MOUNT}/first/*.conf;`,
    `include ${HANDOVER}/apiserver*.conf;`,
    `include ${MOUNT}/first/*.conf;`,
    `include ${HANDOVER}/apiserver*.conf;`,
    // The web app.
    `include ${HANDOVER}/web*.conf;`,
  ]);
  // The http one before the server block, the server one inside it.
  const server = block(main, /^server\s*\{/m);
  assert.ok(server.includes(`include ${MOUNT}/server/*.conf;`));
  assert.ok(!server.includes(`include ${MOUNT}/http/*.conf;`));
});

test('a release hands each route to the apiserver or web over by the variable it proxies to, set after its own line', () => {
  // Every location that proxies to the apiserver, and the one that proxies to web.
  const routes = [
    [/^\s*location ~ \^\/api\/runs\/\[\^\/\]\+\/events\$ \{/m, 'apiserver', 'apiserver:3000'],
    [/^\s*location = \/api\/events \{/m, 'apiserver', 'apiserver:3000'],
    [/^\s*location \/api\/ \{/m, 'apiserver', 'apiserver:3000'],
    [/^\s*location \/ \{/m, 'web', 'orbit-web:80'],
  ];
  for (const [header, variable, own] of routes) {
    const d = directives(block(main, header));
    const at = (x) => d.indexOf(x);
    const include = `include ${HANDOVER}/${variable}*.conf`;
    assert.ok(at(`set $${variable} ${own}`) >= 0, `${header}: names its own upstream`);
    assert.ok(at(`set $${variable} ${own}`) < at(include), `${header}: the handover comes after it`);
    // After the routes for several apiservers too, so that a deployment with several is handed over the same way.
    if (at(`include ${MOUNT}/first/*.conf`) >= 0) assert.ok(at(`include ${MOUNT}/first/*.conf`) < at(include), `${header}`);
    assert.ok(at(include) < at(`proxy_pass http://$${variable}$request_uri`), `${header}: and before the pass, of that variable`);
  }
  // The deploy stage writes exactly that, `set $<service> <container>:<port>;`, the apiserver's on 3000 and web's on 80.
  const stage = read('deploy/two-stage/deploy-stage.sh');
  assert.match(stage, /^HANDOVER=\/etc\/nginx\/handover$/m);
  assert.ok(stage.includes(`printf 'set $%s %s;\\n' "$service" "$to"`), 'the line the deploy writes');
  assert.match(stage, /apiserver\) port=3000; aliases=\(--use-aliases\) ;;/);
  assert.match(stage, /web\) port=80 ;;/);
});

test('the upstreams reach every apiserver by the alias docker-compose.yml gives the apiserver, re-resolved', () => {
  const compose = read('docker-compose.yml');
  const apiserver = compose.slice(compose.indexOf('\n  apiserver:\n'), compose.indexOf('\n  wiki-worker:\n'));
  assert.match(apiserver, /\n {4}networks:\n {6}default:\n(?: *#.*\n)* {8}aliases: \[orbit-apiservers\]\n/);
  for (const name of ['orbit_session_streams', 'orbit_link_tokens']) {
    const d = directives(block(upstreams, new RegExp(`^upstream ${name}\\s*\\{`, 'm')));
    assert.ok(d.includes(`zone ${name} 64k`), `${name} keeps its peers in a zone`);
    assert.ok(d.includes('server orbit-apiservers:3000 resolve'), `${name} lists the alias`);
    assert.ok(d.includes('resolver 127.0.0.11 valid=10s ipv6=off'), `${name} resolves it again every 10 s`);
    assert.equal(d.filter((x) => x.startsWith('server ')).length, 1, `${name} names one server, the alias`);
  }
  const streams = directives(block(upstreams, /^upstream orbit_session_streams\s*\{/m));
  assert.ok(streams.includes('hash $orbit_stream_session'), 'the session streams go by session');
  assert.ok(!streams.some((x) => /^hash .* consistent$/.test(x)), 'plain hash: the consistent hash takes an alias\'s addresses in turn');
  assert.ok(directives(block(upstreams, /^upstream orbit_link_tokens\s*\{/m)).includes('least_conn'));
});

test('the first apiserver\'s requests go to the others only while it cannot be reached: a backup behind it, given up on within 2 s', () => {
  const d = directives(block(upstreams, /^upstream orbit_first_apiserver\s*\{/m));
  assert.deepEqual(d.filter((x) => x.startsWith('server ')), ['server apiserver:3000 resolve', 'server orbit-apiservers:3000 resolve backup']);
  assert.ok(d.includes('zone orbit_first_apiserver 64k'));
  assert.ok(d.includes('resolver 127.0.0.11 valid=10s ipv6=off'));
  assert.ok(!d.some((x) => /^(hash|ip_hash|random|least_conn)\b/.test(x)), 'round robin: backup is its alone');
  const fallback = directives(uncommented(read('gateway/several-apiservers/first/fallback.conf')));
  assert.deepEqual(fallback, ['set $apiserver orbit_first_apiserver', 'proxy_connect_timeout 2s']);
  for (const header of [/^\s*location \/api\/ \{/m, /^\s*location = \/api\/events \{/m]) {
    const loc = directives(block(main, header));
    const at = (x) => loc.indexOf(x);
    // The first apiserver by name, then the include that replaces it where the directory is mounted, then the pass.
    assert.ok(at('set $apiserver apiserver:3000') >= 0, `${header}: names the first apiserver`);
    assert.ok(at('set $apiserver apiserver:3000') < at(`include ${MOUNT}/first/*.conf`), `${header}: the include comes after it`);
    assert.ok(at(`include ${MOUNT}/first/*.conf`) < at('proxy_pass http://$apiserver$request_uri'), `${header}: and before the pass`);
  }
});

test('the session stream route takes /api/sessions/:id/events alone, and hashes by the id', () => {
  const header = uncommented(routes).match(/^location ~ (\S+) \{/m);
  assert.ok(header, 'routes.conf has a regex location');
  // nginx's PCRE and JavaScript read this pattern alike: anchors, a class and a named group.
  const pattern = new RegExp(header[1]);
  const id = (uri) => pattern.exec(uri)?.groups?.orbit_stream_session ?? null;
  assert.equal(id('/api/sessions/343dlzsYWKo5z8l2M8tsB/events'), '343dlzsYWKo5z8l2M8tsB');
  assert.equal(id('/api/sessions/0b6f2c8e-5d1e-4b7a-9a43-2f1d5e7c9a10/events'), '0b6f2c8e-5d1e-4b7a-9a43-2f1d5e7c9a10');
  for (const other of ['/api/sessions/s1/events/page', '/api/sessions/s1/events/search', '/api/sessions/s1/events/12/full',
    '/api/sessions/s1', '/api/sessions//events', '/api/events', '/api/runs/s1/events', '/api/x/sessions/s1/events']) {
    assert.equal(id(other), null, `${other} stays on the first apiserver`);
  }
});

test('both routes proxy exactly as the /api/ location does, to their upstream, and give up on a gone apiserver within 2 s', () => {
  // The /api/ location's settings, less what picks the upstream and the upload limit, which no stream or token needs.
  const api = directives(block(main, /^\s*location \/api\/ \{/m))
    .filter((d) => !/^(set |proxy_pass |client_max_body_size |include )/.test(d)).sort();
  const cases = [
    [/^location ~ \S+ \{/m, 'proxy_pass http://orbit_session_streams$request_uri'],
    [/^location = \/api\/runner\/link-token \{/m, 'proxy_pass http://orbit_link_tokens$request_uri'],
  ];
  for (const [header, pass] of cases) {
    const d = directives(block(routes, header));
    assert.ok(d.includes(pass), `${pass}`);
    assert.ok(d.includes('proxy_connect_timeout 2s'));
    assert.deepEqual(d.filter((x) => !/^(proxy_pass|error_page) /.test(x) && x !== 'proxy_connect_timeout 2s').sort(), api);
  }
  // Nothing else is routed there: the two locations, and the streams' fallback, which only nginx sends to.
  assert.deepEqual(uncommented(routes).match(/^location \S+/gm), ['location ~', 'location @orbit_stream_any_apiserver', 'location =']);
});

test('a stream the gateway could not open is opened once more on any apiserver, a GET only (task 34wTlHHwbkvPyPDtw1Z88)', () => {
  // Measured: after two apiservers were stopped one after the other, the stream upstream counted both as failed for a
  // minute and answered 502 "no live upstreams" while one was up. Only the gateway's own 502 and 504 go there:
  // proxy_intercept_errors is off, so an apiserver's own answer passes through.
  const stream = directives(block(routes, /^location ~ \S+ \{/m));
  assert.ok(stream.includes('error_page 502 504 = @orbit_stream_any_apiserver'));
  assert.ok(!uncommented(routes).includes('proxy_intercept_errors'));
  const body = block(routes, /^location @orbit_stream_any_apiserver \{/m);
  // Nothing but a GET is sent again: anything else answers the 502 it had.
  assert.match(body, /^\s*if \(\$request_method != GET\) \{\s*return 502;\s*\}/);
  const d = directives(body.replace(/^\s*if [^{]*\{[^}]*\}/, ''));
  // Every apiserver the alias resolves to now, through the server's resolver: no upstream, so no failure it remembers.
  assert.deepEqual(d.slice(0, 2), ['set $orbit_any_apiserver orbit-apiservers:3000', 'proxy_pass http://$orbit_any_apiserver$request_uri']);
  // And proxied as the stream location is.
  assert.deepEqual(d.slice(2).sort(), stream.filter((x) => !/^(proxy_pass|error_page) /.test(x)).sort());
});

test('the directory is mounted where gateway/nginx.conf includes it: the staging stack and the deployment\'s override alike', () => {
  const line = `./gateway/several-apiservers:${MOUNT}:ro`;
  assert.ok(read('docs/self-hosting.md').includes(`- ${line}`), 'docs/self-hosting.md shows the mount');
  assert.ok(read('scripts/runner-link/staging.spread.compose.yml').includes(`\${STAGING_REPO}/gateway/several-apiservers:${MOUNT}:ro`));
});
