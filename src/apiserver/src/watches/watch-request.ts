import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  WATCH_LEAVES,
  WATCH_LIMITS,
  WATCH_PREDICATE_VERSION,
  type WatchLeaf,
  type WatchPredicate,
  type WatchRefusalCode,
  type WatchTargetKind,
} from '@orbit/shared';
import { countWatchRefusal } from './watch-metrics';
import { predicateLeaves } from './watch-predicate';

/**
 * What the Watch API refuses before it reads or writes anything: the request side of the v1 grammar
 * in `contracts/watch.contract.json` §2, answered with the contract's refusal codes.
 *
 * Strict where the evaluator's reading of a stored predicate (`parseWatchPredicate`) is lenient on
 * purpose. A term is one of the grammar's two shapes with exactly the grammar's keys, inside the
 * depth and operand limits; anything else — a string, a `kind` the grammar does not have, a leaf
 * outside the seven, or one extra key such as `script` — is refused, not ignored. Ignoring an
 * unknown key would store it, and a stored `script` is one reader away from being run.
 */

/**
 * A refusal carrying the contract's code: 403 for `PERMISSION_DENIED`, 400 for the rest. Counted where it is made
 * (`orbit_watch_refusals_total`), because every one is thrown where it is made.
 */
export function watchRefusal(code: WatchRefusalCode, message: string): BadRequestException | ForbiddenException {
  countWatchRefusal(code);
  const body = { code, kind: 'REFUSAL' as const, message };
  return code === 'PERMISSION_DENIED' ? new ForbiddenException(body) : new BadRequestException(body);
}

export function assertPredicateVersion(version: unknown): void {
  if (version !== WATCH_PREDICATE_VERSION) {
    throw watchRefusal(
      'PREDICATE_VERSION_UNSUPPORTED',
      `this build serves predicateVersion ${WATCH_PREDICATE_VERSION}, and the request ${
        version === undefined ? 'named none' : 'named another'
      }`,
    );
  }
}

const GRAMMAR = 'no shell, SQL, log regex or free-text expression is part of the v1 grammar';

/** `depth` counts terms from the root, so an aggregation inside a composite is at depth 2. */
export function parseRequestedPredicate(term: unknown, depth = 1): WatchPredicate {
  if (depth > WATCH_LIMITS.maxPredicateDepth) {
    throw watchRefusal('PREDICATE_TOO_DEEP', `a predicate nests at most ${WATCH_LIMITS.maxPredicateDepth} terms deep`);
  }
  if (!isPlainObject(term)) {
    throw watchRefusal('UNKNOWN_PREDICATE_KIND', `a predicate term is a JSON object, not ${describeJson(term)}: ${GRAMMAR}`);
  }
  if (term.kind === 'ALL' || term.kind === 'ANY') {
    onlyGrammarKeys(term, ['kind', 'over', 'leaf']);
    if (term.over !== 'ALL_TARGETS') {
      throw watchRefusal('UNKNOWN_PREDICATE_KIND', '`over` selects ALL_TARGETS, the only selector in v1');
    }
    if (typeof term.leaf !== 'string' || !Object.prototype.hasOwnProperty.call(WATCH_LEAVES, term.leaf)) {
      throw watchRefusal('UNKNOWN_PREDICATE_KIND', `\`leaf\` is one of ${Object.keys(WATCH_LEAVES).join(', ')}`);
    }
    return { kind: term.kind, over: 'ALL_TARGETS', leaf: term.leaf as WatchLeaf };
  }
  if (term.kind === 'ALL_OF' || term.kind === 'ANY_OF') {
    onlyGrammarKeys(term, ['kind', 'operands']);
    // An empty composite would hold (ALL_OF) or fail (ANY_OF) without looking at anything — the
    // same vacuous answer EMPTY_TARGET_SET refuses for an empty target set.
    if (!Array.isArray(term.operands) || term.operands.length === 0) {
      throw watchRefusal('UNKNOWN_PREDICATE_KIND', `\`${term.kind}\` takes a non-empty array of operands`);
    }
    if (term.operands.length > WATCH_LIMITS.maxOperandsPerComposite) {
      throw watchRefusal('PREDICATE_TOO_DEEP', `a composite takes at most ${WATCH_LIMITS.maxOperandsPerComposite} operands`);
    }
    return { kind: term.kind, operands: term.operands.map((operand) => parseRequestedPredicate(operand, depth + 1)) };
  }
  throw watchRefusal('UNKNOWN_PREDICATE_KIND', `\`kind\` is one of ALL, ANY, ALL_OF, ANY_OF: ${GRAMMAR}`);
}

/** Every target is read by every leaf (`ALL_TARGETS`), so each leaf must be of every target's kind. */
export function assertLeavesFitTargets(predicate: WatchPredicate, targetKinds: Iterable<WatchTargetKind>): void {
  const kinds = new Set(targetKinds);
  for (const leaf of predicateLeaves(predicate)) {
    const mismatch = [...kinds].find((kind) => kind !== WATCH_LEAVES[leaf]);
    if (mismatch !== undefined) {
      throw watchRefusal(
        'TARGET_KIND_MISMATCH',
        `${leaf} is evaluated against ${WATCH_LEAVES[leaf]} targets, and this watch names a ${mismatch}`,
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyGrammarKeys(term: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(term).find((key) => !keys.includes(key));
  if (extra !== undefined) {
    throw watchRefusal(
      'UNKNOWN_PREDICATE_KIND',
      `\`${extra.slice(0, 40)}\` is not a key of a \`${String(term.kind)}\` term: ${GRAMMAR}`,
    );
  }
}

/** The JSON type of a value, never the value itself: a refused predicate is not echoed back. */
function describeJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
