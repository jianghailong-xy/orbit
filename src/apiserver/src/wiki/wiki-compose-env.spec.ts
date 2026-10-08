import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WIKI_EXECUTOR_ENV } from '@orbit/shared';

/**
 * docker-compose.yml reads the rollout switches from the host under names no agent session carries.
 *
 * The runner puts ORBIT_WIKI=on and ORBIT_WATCHES=on into every agent session's environment for `orbit mcp`, and
 * Compose interpolation prefers the shell's environment to `.env`. While docker-compose.yml read the wiki's switch
 * from a host variable named ORBIT_WIKI, a deploy run from inside a session (upgrade.sh, `docker compose up`) took
 * the session's `on`, and the owner-approved `ORBIT_WIKI=canary` in `.env` was switched to on without a word; Watch's
 * switch the same. So the host side reads ORBIT_WIKI_MODE and ORBIT_WATCHES_MODE, and the container keeps the names
 * the apiserver reads (wiki-rollout.ts, watches/watch-rollout.ts).
 *
 * What a session carries is read from the runner's own source, runner-go codex.go's codexOrbitMCPEnvVarsConfig, so a
 * variable the runner starts injecting later is checked here without anyone copying it over.
 */

// From build/wiki back to the repository root, as wiki-rollout.spec.ts reads the contract.
const ROOT = path.resolve(__dirname, '../../../..');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** The variables codex.go forwards to `orbit mcp`: every one of them is in the environment of every agent session. */
function sessionVariables(): string[] {
  const config = /^const codexOrbitMCPEnvVarsConfig = `mcp_servers\.orbit\.env_vars=\[([^\]]*)\]`$/m.exec(
    read('src/runner-go/codex.go'),
  );
  assert.ok(config, 'runner-go codex.go no longer declares codexOrbitMCPEnvVarsConfig in the shape this spec reads');
  return [...config[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((match) => match[1]);
}

/**
 * Every variable a Compose file interpolates, braced or not, defaults included (`${A:-${B}}` reads both), with the
 * line it is on. `$$` is Compose's literal dollar. Comments are scanned too: this reads lines, not YAML.
 */
function interpolations(compose: string): Array<{ name: string; line: number }> {
  return compose.split('\n').flatMap((text, index) =>
    [...text.matchAll(/\$\$|\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)]
      .filter((match) => match[1] !== undefined)
      .map((match) => ({ name: match[1], line: index + 1 })),
  );
}

/** One service's `environment:` mapping, each value as written less its quotes. */
function serviceEnvironment(compose: string, service: string): Map<string, string> {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${service}:`, lines.indexOf('services:'));
  assert.ok(start > 0, `docker-compose.yml has no ${service} service`);
  const environment = new Map<string, string>();
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^ {0,2}\S/.test(line)) break; // the next service, or the next top-level key
    if (/^ {4}\S/.test(line)) {
      inEnvironment = line.trim() === 'environment:';
      continue;
    }
    const entry = inEnvironment ? /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line) : null;
    if (entry) environment.set(entry[1], entry[2].replace(/^"(.*)"$/, '$1'));
  }
  return environment;
}

test('the scan reads every form Compose interpolates, and not the literal dollar', () => {
  assert.deepEqual(
    interpolations('a: "${A:-${B}}"\nb: $C\nc: "$$D $${E} $$$F"\nd: "${G:?set G}"').map(({ name, line }) => `${line}:${name}`),
    ['1:A', '1:B', '2:C', '3:F', '4:G'],
  );
});

test('no interpolation in docker-compose.yml reads a variable the runner puts into every agent session', () => {
  const injected = new Set(sessionVariables());
  assert.ok(injected.has('ORBIT_SESSION_ID'), `codexOrbitMCPEnvVarsConfig read as [${[...injected].join(', ')}]`);
  const compose = read('docker-compose.yml');
  assert.ok(interpolations(compose).length > 0, 'docker-compose.yml read as interpolating nothing');
  const shadowed = interpolations(compose)
    .filter(({ name }) => injected.has(name))
    .map(({ name, line }) => `docker-compose.yml:${line} reads ${name}`);
  assert.deepEqual(
    shadowed,
    [],
    'every agent session carries these names (runner-go codex.go, codexOrbitMCPEnvVarsConfig), and Compose prefers ' +
      "the shell's environment to .env, so a deploy run from a session takes the session's value: read it from the " +
      'host under a name of its own, as ORBIT_WIKI_MODE is',
  );
});

test("the apiserver's ORBIT_WIKI comes from ORBIT_WIKI_MODE and its ORBIT_WATCHES from ORBIT_WATCHES_MODE", () => {
  const environment = serviceEnvironment(read('docker-compose.yml'), 'apiserver');
  for (const [container, host] of [
    ['ORBIT_WIKI', 'ORBIT_WIKI_MODE'],
    ['ORBIT_WATCHES', 'ORBIT_WATCHES_MODE'],
  ]) {
    const value = environment.get(container);
    assert.ok(value !== undefined, `the apiserver's environment has no ${container}`);
    assert.match(value, new RegExp(`^\\$\\{${host}(?:[:?+-][^}]*)?\\}$`), `the apiserver's ${container} is not read from ${host}`);
  }
});

/**
 * The wiki's executor switch (wiki-executor-switch.ts, P3) reaches the apiserver and the wiki worker from
 * one host variable each, under the names the services read — the same pair in both, so the process that
 * queues a job and the one that runs it decide the same about an account, and each defaults to `runner`.
 *
 * These two are NOT read from *_MODE names like the switches above, and that is deliberate: no agent
 * session carries ORBIT_WIKI_EXECUTOR, which the test below re-reads from the runner's own source. An
 * invocation of `orbit wiki` inside a session would otherwise be the thing that decides what the
 * deployment's .env meant.
 */
test('the wiki executor switch is read from the host by the apiserver and the wiki worker alike, and defaults to runner', () => {
  const compose = read('docker-compose.yml');
  for (const service of ['apiserver', 'wiki-worker']) {
    const environment = serviceEnvironment(compose, service);
    for (const name of Object.values(WIKI_EXECUTOR_ENV)) {
      assert.equal(environment.get(name), `\${${name}:-${name === WIKI_EXECUTOR_ENV.mode ? 'runner' : ''}}`,
        `the ${service}'s ${name} is ${JSON.stringify(environment.get(name))}, not the host's own with its default`);
    }
  }
  const injected = new Set(sessionVariables());
  for (const name of Object.values(WIKI_EXECUTOR_ENV)) {
    assert.equal(injected.has(name), false, `an agent session carries ${name}, so it may not be read as itself`);
  }
});
