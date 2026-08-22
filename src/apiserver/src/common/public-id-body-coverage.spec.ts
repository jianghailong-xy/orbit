import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ArgumentMetadata } from '@nestjs/common';
import { PUBLIC_ID_FIELDS } from '@orbit/shared';
import { PublicIdPipe } from './public-id';

/**
 * The body half of the id rule. `public-id-coverage.spec.ts` reflects over route metadata, which
 * covers params and queries — Nest records those. It cannot see bodies: a DTO's shape lives in
 * types, and types are gone at runtime. So this one reads the source.
 *
 * The two ways a body id gets normalized, and the two ways that fails:
 *  - a DTO CLASS, seen by the global ValidationPipe → each public-id field needs `@IsPublicId`.
 *    Writing `@IsString()` instead type-checks, validates, and hands Prisma a base62 string (500);
 *    writing `@IsUUID()` type-checks and rejects the short id every client URL contains (400).
 *  - a DTO INTERFACE, which the ValidationPipe never sees → the route needs
 *    `@Body(PublicIdPipe.forFields(…))`. A bare `@Body()` there is invisible in review: nothing
 *    is missing from the signature, the id simply arrives unconverted.
 *
 * Both were real when this was written: six class fields (`BatchAssignDto.taskIds` and friends)
 * and `TurnCompleteRequest.turnId`, whose id the runner echoes back into `where: { id }`.
 *
 * And a third, found later: a body typed `unknown`, validated by hand in the controller because
 * there is no class for the ValidationPipe to check and no interface for the scan above to read.
 * That is a hole in BOTH nets at once, and it swallowed `runnerId` on agent create/update — the
 * base62 id `orbit agent create --runner-id` was handed by this very API reached
 * `prisma.runner.findFirst` and 500'd. Hence the third test.
 */
const SRC = path.resolve(__dirname, '../..', 'src');
const SHARED_DTO = path.resolve(__dirname, '../../..', 'shared/src/dto.ts');

function walk(dir: string, hit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, hit);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) hit(full);
  }
}

/** Decorators have to come off before the field name is read: `@IsString({ each: true }) taskIds`
 *  contains `each:` before `taskIds:`, so a naive "first identifier before a colon" match reads
 *  the option, decides the field isn't an id, and passes the exact line it exists to catch. */
const stripDecorators = (line: string) =>
  line.replace(/@\w+\([^()]*(\([^()]*\))?[^()]*\)/g, ' ').replace(/@\w+/g, ' ');

/** Field declarations of every `export class` in a file, each with the decorators that apply to
 *  it (same line, plus any decorator-only lines directly above). */
function classFields(src: string): { cls: string; field: string; decorators: string }[] {
  const out: { cls: string; field: string; decorators: string }[] = [];
  for (const cls of src.matchAll(/export class (\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
    const lines = cls[2].split('\n');
    lines.forEach((line, i) => {
      const field = stripDecorators(line).match(/^\s*(\w+)[!?]?\s*:/);
      if (!field) return;
      let decorators = line;
      for (let j = i - 1; j >= 0 && /^\s*@/.test(lines[j]); j--) decorators = lines[j] + decorators;
      out.push({ cls: cls[1], field: field[1], decorators });
    });
  }
  return out;
}

/** Public-id-bearing fields of every `export interface` in a file. */
function interfacePublicIdFields(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const iface of src.matchAll(/export interface (\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
    const fields = [...iface[2].matchAll(/^\s+(\w+)\??\s*:/gm)]
      .map((m) => m[1])
      .filter((f) => PUBLIC_ID_FIELDS.has(f));
    out.set(iface[1], fields);
  }
  return out;
}

test('every public-id field on a DTO class is declared @IsPublicId', () => {
  const offenders: string[] = [];
  let scanned = 0;
  walk(SRC, (file) => {
    if (!file.endsWith('dto.ts')) return;
    for (const { cls, field, decorators } of classFields(readFileSync(file, 'utf8'))) {
      if (!PUBLIC_ID_FIELDS.has(field)) continue;
      scanned++;
      if (!/IsPublicId/.test(decorators)) offenders.push(`${path.basename(path.dirname(file))}/${cls}.${field}`);
    }
  });
  assert.ok(scanned > 20, `only ${scanned} public-id DTO fields found — the scan broke, not the DTOs`);
  assert.deepEqual(offenders, [], '@IsString/@IsUUID on a public id — use @IsPublicId');
});

test('every interface DTO body normalizes the public ids it carries', () => {
  const interfaces = interfacePublicIdFields(readFileSync(SHARED_DTO, 'utf8'));
  const offenders: string[] = [];
  let scanned = 0;
  walk(SRC, (file) => {
    if (!file.endsWith('.controller.ts')) return;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('@Body(')) return;
      // The type annotation may sit on the next line when forFields() wraps.
      const type = `${line} ${lines[i + 1] ?? ''}`.match(/:\s*([A-Z]\w+)/);
      const carried = type && interfaces.get(type[1]);
      if (!carried?.length) return;
      scanned++;
      const normalized = [...`${line} ${lines[i + 1] ?? ''}`.matchAll(/'(\w+)'/g)].map((m) => m[1]);
      const missed = carried.filter((f) => !normalized.includes(f));
      if (missed.length) {
        offenders.push(`${path.basename(file)}:${i + 1} ${type![1]} → ${missed.join(',')}`);
      }
    });
  });
  assert.ok(scanned > 0, 'found no interface-DTO bodies carrying ids — the scan broke');
  assert.deepEqual(offenders, [], 'interface DTO body needs @Body(PublicIdPipe.forFields(…))');
});

/**
 * The free-form bodies: `@Body() body: unknown`, whitelisted and validated by hand in the
 * controller. Nothing above can see what fields they carry — there is no class and no named
 * interface — so the rule here is positional and fails safe: such a body MUST bind a
 * `PublicIdPipe`. A controller that genuinely takes no id from its body should give the body a
 * type, which puts it back under one of the two scans above.
 */
test('every free-form @Body() binds a PublicIdPipe', () => {
  const offenders: string[] = [];
  let scanned = 0;
  walk(SRC, (file) => {
    if (!file.endsWith('.controller.ts')) return;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // The type annotation may sit on the next line when the pipe expression wraps.
      const decl = `${line} ${lines[i + 1] ?? ''}`;
      if (!/@Body\(/.test(line) || !/:\s*unknown\b/.test(decl)) return;
      scanned++;
      if (!/@Body\([^)]*PublicIdPipe/.test(decl)) {
        offenders.push(`${path.basename(file)}:${i + 1}`);
      }
    });
  });
  assert.ok(scanned > 0, 'found no free-form bodies — the scan broke, not the controllers');
  assert.deepEqual(offenders, [], 'hand-validated body needs @Body(PublicIdPipe.forFields(…))');
});

/**
 * Binding the pipe is only half of a free-form body's job, and the half a scan can see. The other
 * half is the VALUE: `PublicIdPipe` decodes ids that are *present*, and `""` / `"   "` fail that
 * test — it skips them and hands them on verbatim (pinned below, since it is the reason the rest
 * of this exists). A DTO class survives that: `@IsPublicId`'s `@IsUUID` refuses the blank. A
 * free-form body has no validator behind the pipe, so the blank rides straight into a `@db.Uuid`
 * column — `runnerId: ""` was a bare P2023 500 on agent create, and on PATCH, `""` being falsy,
 * a 200 that silently unbound the agent's runner.
 *
 * So every id a free-form body's pipe names needs a blank guard written by hand, and this is the
 * register of which ones have one and where the behaviour is pinned. Naming a new field in a
 * `forFields(…)` on such a body — or adding a whole new free-form body — fails here until its
 * blank case is guarded and covered too.
 *
 * Like the three scans above, the guard half is checked by shape, not by meaning: this can tell
 * that the field is tested for blankness and not that the test is right. The behavioural spec each
 * entry names is what settles that, the same way `@IsPublicId` being present is settled elsewhere.
 */
const BLANK_GUARDED: Record<string, readonly string[]> = {
  // runner-agents-sanitize.spec.ts: 'a blank runnerId is a 400 on both routes, not a 500 and not
  // an unbind'.
  'runner-agents.controller.ts': ['runnerId'],
};

test('a blank body id is not decoded — the pipe hands it straight through', () => {
  assert.deepEqual(
    PublicIdPipe.forFields('runnerId').transform(
      { runnerId: '   ' },
      { type: 'body' } as ArgumentMetadata,
    ),
    { runnerId: '   ' },
    'the pipe now judges blank body ids itself — revisit the guards BLANK_GUARDED records',
  );
});

test('every public id a free-form @Body() names is guarded against a blank value', () => {
  const named: Record<string, string[]> = {};
  const unguarded: string[] = [];
  walk(SRC, (file) => {
    if (!file.endsWith('.controller.ts')) return;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const decl = `${line} ${lines[i + 1] ?? ''}`;
      if (!/@Body\(/.test(line) || !/:\s*unknown\b/.test(decl)) return;
      const fields = [...decl.matchAll(/'(\w+)'/g)].map((m) => m[1]);
      if (!fields.length) return;
      // Union across the file's routes — create and update are two declarations, and one of them
      // naming a field the other doesn't still needs that field guarded.
      const key = path.basename(file);
      named[key] = [...new Set([...(named[key] ?? []), ...fields])];
      // The guard is hand-written, so all this can look for is a blankness test that names the
      // field. `optionalString` already refuses a non-string, so trimming is the whole of it.
      for (const field of fields) {
        const entry = `${key} → ${field}`;
        if (!new RegExp(`\\b${field}\\b[^\\n]*\\.trim\\(\\)`).test(src)) {
          if (!unguarded.includes(entry)) unguarded.push(entry);
        }
      }
    });
  });
  assert.ok(Object.keys(named).length > 0, 'found no free-form bodies — the scan broke');
  assert.deepEqual(
    unguarded,
    [],
    'a free-form body takes this id but never refuses a blank one — "" reaches the uuid column',
  );
  assert.deepEqual(
    named,
    BLANK_GUARDED,
    'register the new free-form body id here, with the spec that pins its blank case',
  );
});

/**
 * And the exit the body leaves BY, which is two exits and not one.
 *
 * Everything above is about ids arriving. This is about them leaving: `PublicIdInterceptor` maps
 * what a handler returns and `PublicIdExceptionFilter` maps what it throws, and for a long time
 * only the first was registered — so a 409 that named a row named it by raw UUID while the 200 on
 * the same route did not. Neither half is reachable from the other's tests, and dropping the
 * filter from `main.ts` breaks nothing that anything else asserts, so the wiring is pinned here.
 */
test('both exits map the body: the interceptor for returns, the filter for throws', () => {
  const main = readFileSync(path.resolve(SRC, 'main.ts'), 'utf8');
  assert.match(
    main,
    /useGlobalInterceptors\(.*new PublicIdInterceptor\(\)/,
    'the success path stopped mapping ids',
  );
  // Reached through the conflict boundary, which is registered in front of it: Nest runs exactly
  // one filter per exception, so the id filter is wired as that one's `next` rather than as a
  // second global. Dropping it out of the chain is the same regression as dropping it entirely.
  assert.match(
    main,
    /useGlobalFilters\(\s*new TransientDbConflictFilter\(new PublicIdExceptionFilter\(/,
    'a refusal body leaves unmapped again — see public-id.filter.ts for what that cost',
  );
});
