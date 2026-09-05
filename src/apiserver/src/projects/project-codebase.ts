import { BadRequestException } from '@nestjs/common';
import { SOURCE_FIX_ACTIONS, SourceRefAuthority } from '@orbit/shared';

/**
 * The write surface for a Project's code binding: what a caller may state, and what is refused.
 *
 * Migration 0231 landed `project_codebase` with every constraint this file checks, and until now
 * nothing outside a spec ever wrote a row — the data model was true and the product capability
 * ("a Project can be explicitly bound to a code line") was not. This is that capability's one
 * door, and it is deliberately NARROW: four declared fields, one repository identity, and no
 * spelling at all for the two values the database owns.
 *
 * WHY THE CHECKS ARE HERE AND NOT ONLY IN POSTGRES. Every rule below is already a CHECK or a
 * trigger on the table, so nothing here is what makes a bad row impossible. What it makes possible
 * is being TOLD: a value that reaches Prisma and violates a CHECK comes back as an engine error
 * with no status and no code, which is a 500 for a request that was merely wrong. SR9 names the
 * refusal a caller is owed — `CODEBASE_AUTHORITY_INVALID` — and this is where that name is
 * attached. The constraints stay the authority: this file is written to agree with them, never to
 * relax them, and `project-codebase-binding.pg.spec.ts` drives the two together against a real
 * database so a disagreement is a failing test rather than a 500 in production.
 *
 * WHAT IS NOT SPELLABLE, and why each absence is load-bearing:
 *
 *  - `configRevision` (SR8) is the database's answer to "is this the configuration that session
 *    froze". A writer who could choose it could make an edited binding claim to be the one an
 *    in-flight run resolved against. The trigger sets it to 0 on INSERT whatever arrives, so
 *    accepting the field would not even corrupt anything — it would just tell the caller a version
 *    number was theirs to state. That lie is the thing being refused.
 *  - `rootCommitSha` (SR37) means "observed", not "asserted". It is filled once, by whatever first
 *    RESOLVES the repository, and the trigger refuses every write after that. A create surface
 *    that asked for it would be asking a person to guess a fact, and a person who guesses wrong
 *    has renamed the repository for every snapshot already frozen against it.
 *  - `slot` is `'primary'` in v1. The column exists so a second binding is expressible in the data
 *    model (§14 trade-off 1), and only the resolver's filter keeps v1 to one; a caller who could
 *    name a slot could write a binding that v1's resolver will never read.
 *
 * All three are DECLARED on the DTO and refused, rather than left off it: the global pipe runs
 * `whitelist: true` with `forbidNonWhitelisted: false`, so an undeclared property is silently
 * STRIPPED, and a caller who sent `configRevision: 7` would get 201 back and believe it. The same
 * reasoning `CreateProjectAcceptanceCriterionDto` gives for the four fields migration 0233 removed.
 */

/** What the caller states. The DTO carries the same fields; this is the shape the service works in. */
export interface ProjectCodebaseBindingInput {
  canonicalRepoUrl: string;
  upstreamRef: string;
  /** Defaults to `upstreamRef` (§3.1) — a project that never says otherwise merges back where it
   *  branched from, which is what SR44 then reads as the default merge target. */
  integrationRef?: string;
  refAuthority: string;
  remoteName?: string;
  /** Required exactly when `refAuthority` is `RUNNER_LOCAL`, refused otherwise (SR31). */
  authorityRunnerId?: string | null;
}

/** The columns this surface writes. Named one by one rather than spread from the DTO, so the two
 *  values the database owns cannot arrive by widening a type somewhere else. */
export interface ProjectCodebaseCreateColumns {
  slot: string;
  canonicalRepoUrl: string;
  upstreamRef: string;
  integrationRef: string;
  refAuthority: SourceRefAuthority;
  remoteName: string;
  authorityRunnerId: string | null;
}

/** v1's one slot. Not a parameter: see the header. */
export const PRIMARY_SLOT = 'primary';

/** `origin` unless the caller names another remote, as the column's own default says. */
export const DEFAULT_REMOTE_NAME = 'origin';

/**
 * SR9's rule, and the same predicate `project_codebase_refs_chk` enforces.
 *
 * A short name is refused rather than expanded: `main` is ambiguous the day `refs/heads/main` and
 * `refs/tags/main` both exist, and a baseline that is ambiguous is not a baseline. JavaScript's
 * `\s` is a superset of Postgres's `[:space:]`, so anything this accepts satisfies the CHECK.
 */
export const FULL_NAME_REF = /^refs\/[^\s]+$/;

export const REF_AUTHORITIES: readonly SourceRefAuthority[] = ['REMOTE', 'RUNNER_LOCAL'];

/**
 * The one refusal this surface makes, with the fix action §10.1 pairs it with.
 *
 * One code for every value rule rather than a code per field: `CODEBASE_AUTHORITY_INVALID` is what
 * the contract names for a binding whose configuration cannot be used (SR9), and it is what the
 * table's own trigger raises. `fixAction` is READ from the shared table rather than written here,
 * because a client that re-derives the pairing is a second copy of it that can drift (SR49).
 */
export function codebaseAuthorityInvalid(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'CODEBASE_AUTHORITY_INVALID',
    message,
    owner: 'USER',
    fixAction: SOURCE_FIX_ACTIONS.CODEBASE_AUTHORITY_INVALID,
  });
}

/** Why a field the database owns is refused. The code travels in the refusal body's `code`, so it
 *  is deliberately not repeated here — a message that restates its own code reads, to somebody
 *  pasting it into an issue, as two different facts. */
export function notYoursToState(field: 'configRevision' | 'rootCommitSha' | 'slot'): string {
  return `${field} is not a caller's to state — ${REASONS[field]}`;
}

const REASONS = {
  configRevision:
    'it is maintained by the database so that a frozen session snapshot can be compared against '
    + 'the configuration it actually resolved against (SR8)',
  rootCommitSha:
    'it records what a resolution OBSERVED, is written once by whatever first resolves this '
    + 'repository, and is immutable afterwards (SR37)',
  slot: `every binding is written to the '${PRIMARY_SLOT}' slot in v1`,
} as const;

/**
 * Check one stated binding against §3.1 and hand back exactly the columns to write.
 *
 * Pure, and separate from the service, so what the rules ARE can be read in one place and tested
 * without a database — while the database keeps the last word on whether they held.
 */
export function projectCodebaseCreateColumns(
  input: ProjectCodebaseBindingInput,
): ProjectCodebaseCreateColumns {
  const url = input.canonicalRepoUrl;
  // §7.1's normalisation residue, mirrored from `project_codebase_canonical_url_chk`. Refused
  // rather than normalised: SR36's canonicalisation is a pure function that must agree with the
  // runner's `cloneDirName`, and half of it implemented on one side is a second identity nobody
  // can compare against. Saying which character to remove is a fix a person can carry out.
  if (url !== url.trim() || url === '') {
    throw codebaseAuthorityInvalid(
      'canonicalRepoUrl must not be empty or carry surrounding whitespace',
    );
  }
  if (url.endsWith('/') || url.endsWith('.git')) {
    throw codebaseAuthorityInvalid(
      `canonicalRepoUrl is the repository's identity, not a clone command: drop the trailing `
      + `${url.endsWith('/') ? '"/"' : '".git"'} so two machines compute the same identity (§7.1)`,
    );
  }

  const integrationRef = input.integrationRef ?? input.upstreamRef;
  for (const [field, value] of [
    ['upstreamRef', input.upstreamRef],
    ['integrationRef', integrationRef],
  ] as const) {
    if (!FULL_NAME_REF.test(value)) {
      throw codebaseAuthorityInvalid(
        `${field} must be a full-name ref such as "refs/heads/main": "${value}" is ambiguous the `
        + 'day the same short name exists as both a branch and a tag, and a baseline may not be '
        + 'ambiguous (SR9)',
      );
    }
  }

  if (!REF_AUTHORITIES.includes(input.refAuthority as SourceRefAuthority)) {
    throw codebaseAuthorityInvalid(
      `refAuthority must be one of ${REF_AUTHORITIES.join(', ')} — it says where a ref resolves `
      + `AUTHORITATIVELY, not which machine runs the work (SR40)`,
    );
  }
  const refAuthority = input.refAuthority as SourceRefAuthority;

  const authorityRunnerId = input.authorityRunnerId ?? null;
  // SR31, stated as the double condition `project_codebase_authority_runner_chk` enforces rather
  // than as a one-way implication. A REMOTE row carrying a leftover machine id would adopt it the
  // moment somebody flipped the authority, and nobody would have chosen that machine.
  if (refAuthority === 'RUNNER_LOCAL' && authorityRunnerId === null) {
    throw codebaseAuthorityInvalid(
      'refAuthority RUNNER_LOCAL requires authorityRunnerId: an authority that is "some machine\'s '
      + 'local state" resolves to two answers on two runners (SR31)',
    );
  }
  if (refAuthority === 'REMOTE' && authorityRunnerId !== null) {
    throw codebaseAuthorityInvalid(
      'authorityRunnerId belongs to a RUNNER_LOCAL binding only: a REMOTE binding resolves against '
      + 'the remote, and a machine id left on the row would be adopted the moment somebody '
      + 'changed the authority to RUNNER_LOCAL (SR31)',
    );
  }

  const remoteName = input.remoteName ?? DEFAULT_REMOTE_NAME;
  if (remoteName !== remoteName.trim() || remoteName.length < 1 || remoteName.length > 100) {
    throw codebaseAuthorityInvalid(
      'remoteName must be a git remote name: 1 to 100 characters, no surrounding whitespace',
    );
  }

  return {
    slot: PRIMARY_SLOT,
    canonicalRepoUrl: url,
    upstreamRef: input.upstreamRef,
    integrationRef,
    refAuthority,
    remoteName,
    authorityRunnerId,
  };
}

/** The row as it is read back, and the columns the read needs. Field names are the Prisma model's,
 *  which is what makes them the same names every other surface already serves; `authorityRunnerId`
 *  is in `PUBLIC_ID_FIELDS`, so the response interceptor renders it base62 like any other address. */
export const PROJECT_CODEBASE_SELECT = {
  id: true,
  projectId: true,
  slot: true,
  canonicalRepoUrl: true,
  rootCommitSha: true,
  upstreamRef: true,
  integrationRef: true,
  refAuthority: true,
  remoteName: true,
  authorityRunnerId: true,
  configRevision: true,
  createdAt: true,
  updatedAt: true,
} as const;
