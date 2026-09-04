import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NEVER_PUBLIC_ID_FIELDS, PUBLIC_ID_FIELDS } from '@orbit/shared';
import {
  ACCEPTANCE_FINDING_ROUTING,
  criteriaFromDefinitions,
  criteriaSemanticRevision,
  sha256,
} from './project-acceptance';

// The criteria module, on its own. It is pure by design, which is what makes "what does this
// project state it is for" answerable by anything — a test, a CLI, a future evaluator — without a
// database in the room.
//
// Migration 0229 removed the judging half of this module with the machine it served: the evidence
// digest, the result digest, the legacy-text parser and the DONE gate's refusal codes all
// described runs, conclusions and an accepted-run pointer that no longer exist. What is asserted
// below is the declaration that stays, and — at the bottom — that the judging half is gone.

test('structured criteria preserve identity while semantic revision ignores presentation order', () => {
  const definitions = [
    { id: 'a', ordinal: 1, text: 'every suite green', revision: 4 },
    { id: 'b', ordinal: 2, text: 'merged to main', revision: 1 },
  ];
  const stated = criteriaFromDefinitions(definitions);
  assert.deepEqual(stated.map((criterion) => criterion.definitionId), ['a', 'b']);
  assert.deepEqual(stated.map((criterion) => criterion.definitionRevision), [4, 1]);
  assert.deepEqual(stated.map((criterion) => criterion.ordinal), [1, 2]);

  assert.equal(
    criteriaSemanticRevision(definitions),
    criteriaSemanticRevision([...definitions].reverse()),
    'a conjunction does not change when its display order changes',
  );
  assert.notEqual(
    criteriaSemanticRevision(definitions),
    criteriaSemanticRevision([{ ...definitions[0], text: 'every suite green on Linux' }, definitions[1]]),
  );
  assert.notEqual(
    criteriaSemanticRevision(definitions),
    criteriaSemanticRevision([...definitions, { ...definitions[0], id: 'duplicate', ordinal: 3 }]),
    'duplicates remain part of the multiset',
  );
});

// The key is CONTENT-addressed, which is what lets a criterion be recognised across a reorder or a
// re-ordinal while an edit to its words correctly makes it a different criterion.
test('a criterion key is its content, and ordinals are renumbered from the stated order', () => {
  const stated = criteriaFromDefinitions([
    { id: 'b', ordinal: 40, text: '  merged to main  ', revision: 1 },
    { id: 'a', ordinal: 7, text: 'every suite green', revision: 1 },
  ]);
  assert.deepEqual(stated.map((criterion) => criterion.definitionId), ['a', 'b']);
  assert.deepEqual(stated.map((criterion) => criterion.ordinal), [1, 2]);
  assert.deepEqual(stated.map((criterion) => criterion.text), ['every suite green', 'merged to main']);
  assert.equal(stated[0].key, sha256('every suite green').slice(0, 32));
  // A stored content hash wins over one derived here: the database computes it, and two spellings
  // of the same identity are two chances for a reader and a writer to disagree.
  const [withHash] = criteriaFromDefinitions([
    { id: 'a', ordinal: 1, text: 'every suite green', revision: 1, contentHash: 'c'.repeat(64) },
  ]);
  assert.equal(withHash.contentHash, 'c'.repeat(64));
  assert.equal(withHash.key, 'c'.repeat(32));
});

// Migration 0233 removed the four wiring fields from a criterion, so a stated criterion no longer
// carries a kind, a command, an expected exit code or an evidence pointer AT ALL — not even as a
// null. A null would still be a claim about wiring; their absence is the removal.
test('a stated criterion carries no wiring back towards the work', () => {
  const [criterion] = criteriaFromDefinitions([
    { id: 'a', ordinal: 1, text: 'a person looks at it', revision: 1 },
  ]);
  assert.equal(criterion.verificationMethod, null);
  for (const gone of [
    'completionCriterion', 'acceptanceCommand', 'acceptanceExpectedExitCode', 'evidenceTaskId',
  ]) {
    assert.equal(gone in criterion, false, `${gone} is still projected onto a stated criterion`);
  }
  assert.deepEqual(Object.keys(criterion).sort(), [
    'completionCriterionOverrideReason', 'contentHash', 'definitionId', 'definitionRevision',
    'key', 'ordinal', 'text', 'verificationMethod',
  ]);
});

// The routing rule a settled-project refusal quotes. It must not name a mechanism that was
// removed: telling somebody to "return that criterion to non-PASS with a new conclusion event"
// points at a table 0229 dropped.
test('the finding-routing sentence names only things that still exist', () => {
  assert.match(ACCEPTANCE_FINDING_ROUTING, /acceptance criterion/);
  for (const gone of [/conclusion event/i, /non-PASS/i, /acceptance run/i, /epoch/i]) {
    assert.doesNotMatch(ACCEPTANCE_FINDING_ROUTING, gone);
  }
});

test('every id the acceptance record serves is classified as a public id', () => {
  // The response interceptor keys on FIELD NAMES, so a new uuid column served under an
  // unclassified name comes back as a raw uuid beside base62 siblings — which is how a client ends
  // up unable to hand back an id it was just given.
  // `evidenceTaskId` stood here until migration 0233 dropped the criterion's pointer at the work
  // that serves it. Nothing produces the name any more, so classifying it would be a rule about a
  // field no response contains.
  for (const field of ['definitionId', 'criterionId']) {
    assert.ok(PUBLIC_ID_FIELDS.has(field), `${field} is not classified as a public id`);
    assert.equal(NEVER_PUBLIC_ID_FIELDS.has(field), false, `${field} is classified twice`);
  }
});

// The removal itself, asserted against the file rather than against an import: a symbol that came
// back would be caught by the import, and a symbol that came back under a new name would not.
test('the judging half of the criteria module is gone', () => {
  const source = readFileSync(path.resolve(__dirname, '../../src/projects/project-acceptance.ts'), 'utf8');
  for (const gone of [
    'ACCEPTANCE_DIGEST_VERSION',
    'ACCEPTANCE_MISSING',
    'ACCEPTANCE_BLOCKED',
    'AcceptanceRefusalCode',
    'acceptanceDigest',
    'acceptanceResultDigest',
    'AcceptanceFacts',
    'mergeEvidence',
    // The legacy blob and its parser: 0229 dropped `project.acceptance_criteria`, the database
    // parser that split it and the TypeScript one beside it, together.
    'parseCriteria',
    'criteriaFromLegacy',
    'statedCriteriaFrom',
    'criteriaLegacyProjection',
  ]) {
    assert.equal(source.includes(gone), false, `${gone} survives in project-acceptance.ts`);
  }
});
