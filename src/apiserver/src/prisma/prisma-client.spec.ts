import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PG_ADAPTER_OPTIONS, PREPARED_STATEMENT, preparedStatementName } from './prisma-client';

/** Which statements go to PostgreSQL as named prepared statements (prisma-client.ts). */

const SRC = path.resolve(__dirname, '../../src');

test('a statement that opens with the mark is named, one name per text; any other is sent unnamed', () => {
  const beat = `${PREPARED_STATEMENT}\n    SELECT 1 FROM "runner" WHERE "id" = $1::uuid`;
  const name = preparedStatementName({ sql: beat });
  assert.match(name ?? '', /^orbit_[0-9a-f]{32}$/, 'a name PostgreSQL takes as it is: under 64 bytes, nothing to quote');
  assert.equal(preparedStatementName({ sql: beat }), name, 'the same text, the same name: parsed once per connection');
  assert.notEqual(
    preparedStatementName({ sql: beat.replace('SELECT 1', 'SELECT 2') }), name,
    'another text, another name: pg refuses a name prepared for a different statement',
  );
  assert.equal(preparedStatementName({ sql: 'SELECT 1 FROM "runner"' }), undefined);
  assert.equal(preparedStatementName({ sql: `\n${PREPARED_STATEMENT} SELECT 1` }), undefined, 'the mark opens the statement or does nothing');
  assert.equal(PG_ADAPTER_OPTIONS.statementNameGenerator, preparedStatementName);
});

test('no module of the API server builds its driver adapter but prisma-client.ts, so every client names by that rule', () => {
  const builders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) && /new PrismaPg\(/.test(readFileSync(file, 'utf8'))) {
        builders.push(path.relative(SRC, file));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(builders, ['prisma/prisma-client.ts']);
});
