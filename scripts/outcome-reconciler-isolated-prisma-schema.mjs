#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [sourceArg, generatedArg, clientArg] = process.argv.slice(2);
assert.ok(sourceArg && generatedArg && clientArg, 'usage: isolated-prisma-schema <source> <generated> <client-output>');

const source = path.resolve(sourceArg);
const generated = path.resolve(generatedArg);
const client = path.resolve(clientArg);
const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const build = path.join(repository, 'src/apiserver/build');

for (const target of [generated, client]) {
  assert.ok(
    target === build || target.startsWith(`${build}${path.sep}`),
    `refusing to write isolated Prisma output outside ${build}: ${target}`,
  );
}

const schema = readFileSync(source, 'utf8');
const generator = /generator client \{\n  provider = "prisma-client-js"\n\}/;
assert.match(schema, generator, 'canonical Prisma client generator block changed');

const isolated = schema.replace(
  generator,
  `generator client {\n  provider = "prisma-client-js"\n  output   = "${client.replaceAll('\\', '\\\\')}"\n}`,
);

rmSync(client, { recursive: true, force: true });
mkdirSync(path.dirname(generated), { recursive: true });
writeFileSync(generated, isolated);
