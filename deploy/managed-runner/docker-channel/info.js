// What each Docker channel of the managed runner profile reports in GET /v1/info, one line per host, as the apiserver
// reaches it. Run in the apiserver's container, which has the profile and the token files and the way to each channel:
//
//   docker compose exec -T apiserver node - [profile.json] < deploy/managed-runner/docker-channel/info.js
//
// /upgrade runs it on a deployment whose channel hosts are all on other machines, where it builds no image itself
// (docs/self-hosting.md, "Managed runners on another host"). Read only: no token is printed, and nothing is changed.
// It exits 0 whatever a host answers; a host it cannot ask is said on its line.
'use strict';

const { readFileSync } = require('node:fs');
const http = require('node:http');

const file = process.argv[2] || process.env.ORBIT_MANAGED_RUNNERS_PROFILE || '/var/lib/orbit-managed-runners/profile.json';
const profile = JSON.parse(readFileSync(file, 'utf8'));
const hosts = profile.docker?.hosts ?? [profile.docker];
const pinned = /^sha256:[0-9a-f]{64}$/.test(profile.runner?.image ?? '') ? profile.runner.image : null;

function info(host) {
  return new Promise((resolve, reject) => {
    const token = readFileSync(host.tokenFile, 'utf8').trim();
    const where = host.channel.url ? new URL('/v1/info', host.channel.url) : null;
    const request = http.request(
      where ?? { socketPath: host.channel.socketPath, path: '/v1/info' },
      { method: 'GET', timeout: 10_000, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* said below */ }
          if (res.statusCode !== 200 || !json) reject(new Error(`answered ${res.statusCode} ${json?.code ?? body.slice(0, 80)}`));
          else resolve(json);
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('no answer within 10 s')));
    request.on('error', reject);
    request.end();
  });
}

(async () => {
  for (const host of hosts) {
    const where = host.channel?.url ?? host.channel?.socketPath;
    const notes = [];
    if (host.draining) notes.push('draining');
    try {
      const got = await info(host);
      if (got.instanceId !== host.instanceId) notes.push(`it is instance ${got.instanceId}, not the profile's: the apiserver makes nothing there`);
      if (pinned && got.image !== pinned) notes.push(`the profile pins ${pinned}: the apiserver makes nothing there until they agree`);
      console.log(`    ${host.instanceId} at ${where}: image ${got.image}${notes.length ? ` (${notes.join('; ')})` : ''}`);
    } catch (error) {
      notes.unshift(`not reached: ${error.message}`);
      console.log(`    ${host.instanceId} at ${where}: ${notes.join('; ')}`);
    }
  }
})();
