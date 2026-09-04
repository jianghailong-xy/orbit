import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateProjectDto, UpdateProjectDto } from './dto';

type DtoConstructor = new () => object;

async function validationErrors(cls: DtoConstructor, body: object) {
  return validate(plainToInstance(cls, body));
}

test('structured acceptance input requires a verification method on every assertion', async () => {
  for (const { Dto, body } of [
    { Dto: CreateProjectDto as DtoConstructor,
      body: { title: 'N3', acceptanceCriteriaItems: [{ text: 'the suite passes' }] } },
    { Dto: UpdateProjectDto as DtoConstructor,
      body: { acceptanceCriteriaItems: [{ text: 'the suite passes' }] } },
  ]) {
    const missing = await validationErrors(Dto, body);
    assert.notEqual(missing.length, 0, `${Dto.name} accepted an assertion with no method`);

    const blank = await validationErrors(Dto, {
      ...body,
      acceptanceCriteriaItems: [{ text: 'the suite passes', verificationMethod: '   ' }],
    });
    assert.notEqual(blank.length, 0, `${Dto.name} accepted a blank method`);

    const valid = await validationErrors(Dto, {
      ...body,
      acceptanceCriteriaItems: [{
        text: 'the suite passes',
        verificationMethod: 'Run npm test and require exit code 0',
      }],
    });
    assert.deepEqual(valid, []);

    // And the four fields migration 0233 removed are REFUSED rather than dropped on the floor.
    // The pipe runs `whitelist: true` with `forbidNonWhitelisted: false`, so an undeclared
    // property would simply be stripped and the caller told nothing.
    for (const [field, value] of [
      ['completionCriterion', 'EVIDENCE_JUDGMENT'],
      ['acceptanceCommand', 'npm test'],
      ['acceptanceExpectedExitCode', 0],
      ['evidenceTaskId', '00000000-0000-4000-8000-000000000001'],
    ] as const) {
      const refused = await validationErrors(Dto, {
        ...body,
        acceptanceCriteriaItems: [{
          text: 'the suite passes',
          verificationMethod: 'Run npm test and require exit code 0',
          [field]: value,
        }],
      });
      assert.notEqual(refused.length, 0, `${Dto.name} silently ignored ${field}`);
      assert.match(JSON.stringify(refused), new RegExp(`${field} was removed by migration 0233`));
    }
  }
});
