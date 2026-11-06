import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { normalizeRepoUrl } from './wiki.service';

/**
 * The clients group a wiki's workspaces by repository and say which one a new wiki will describe, by their own
 * port of this normalizer (web `wikiRepositoryName`, OrbitKit and Android alike): the server's answers are the
 * ones `src/shared/src/wiki-start.fixture.json` holds all three to.
 */
const FIXTURE = path.resolve(__dirname, '../../../shared/src/wiki-start.fixture.json');

test('every spelling in the clients’ fixture names the repository the server names', () => {
  const { repositories } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    repositories: Array<{ url: string; repository: string | null }>;
  };
  assert.ok(repositories.length > 0);
  for (const row of repositories) assert.equal(normalizeRepoUrl(row.url), row.repository, JSON.stringify(row.url));
});
