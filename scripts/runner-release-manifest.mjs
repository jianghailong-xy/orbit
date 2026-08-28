#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [version, output] = process.argv.slice(2);
if (!version || !output) {
  throw new Error('usage: runner-release-manifest.mjs VERSION OUTPUT');
}
const source = readFileSync(path.join(root, 'contracts/runner-write-protocol.json'));
const contract = JSON.parse(source.toString());
const manifest = {
  version,
  capabilityRevision: contract.capabilityRevision,
  schemaRevision: contract.schemaRevision,
  minimumCapabilityRevision: contract.minimumCapabilityRevision,
  minimumSchemaRevision: contract.minimumSchemaRevision,
  contractDigest: createHash('sha256').update(source).digest('hex'),
};
writeFileSync(output, `${JSON.stringify(manifest)}\n`);
