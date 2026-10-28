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
  assert.deepEqual(includes, [`include ${MOUNT}/http/*.conf;`, `include ${MOUNT}/server/*.conf;`]);
  // The http one before the server block, the server one inside it.
  const server = block(main, /^server\s*\{/m);
  assert.ok(server.includes(`include ${MOUNT}/server/*.conf;`));
  assert.ok(!server.includes(`include ${MOUNT}/http/*.conf;`));
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
    .filter((d) => !/^(set |proxy_pass |client_max_body_size )/.test(d)).sort();
  const cases = [
    [/^location ~ \S+ \{/m, 'proxy_pass http://orbit_session_streams$request_uri'],
    [/^location = \/api\/runner\/link-token \{/m, 'proxy_pass http://orbit_link_tokens$request_uri'],
  ];
  for (const [header, pass] of cases) {
    const d = directives(block(routes, header));
    assert.ok(d.includes(pass), `${pass}`);
    assert.ok(d.includes('proxy_connect_timeout 2s'));
    assert.deepEqual(d.filter((x) => !x.startsWith('proxy_pass ') && x !== 'proxy_connect_timeout 2s').sort(), api);
  }
  // Nothing else is routed there: the two locations and no other.
  assert.equal(uncommented(routes).match(/^location /gm).length, 2);
});

test('the directory is mounted where gateway/nginx.conf includes it: the staging stack and the deployment\'s override alike', () => {
  const line = `./gateway/several-apiservers:${MOUNT}:ro`;
  assert.ok(read('docs/self-hosting.md').includes(`- ${line}`), 'docs/self-hosting.md shows the mount');
  assert.ok(read('scripts/runner-link/staging.spread.compose.yml').includes(`\${STAGING_REPO}/gateway/several-apiservers:${MOUNT}:ro`));
});
