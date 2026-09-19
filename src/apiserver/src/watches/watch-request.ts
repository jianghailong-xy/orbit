import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  WATCH_LEAF_SINCE_VERSION,
  WATCH_LEAVES,
  WATCH_LIMITS,
  WATCH_PREDICATE_VERSIONS,
  type WatchLeaf,
  type WatchLeafParams,
  type WatchMode,
  type WatchPredicate,
  type WatchRefusalCode,
  type WatchTargetKind,
} from '@orbit/shared';
import { countWatchRefusal } from './watch-metrics';
import { leafParamsProblem, predicateLeaves } from './watch-predicate';

/**
 * What the Watch API refuses before it reads or writes anything: the request side of the grammars in
 * `contracts/watch.contract.json` §2 and §12, answered with the contract's refusal codes.
 *
 * Strict where the evaluator's reading of a stored predicate (`parseWatchPredicate`) is lenient on
 * purpose. A term is one of the grammar's shapes with exactly the keys its version gives that shape,
 * inside the depth and operand limits; anything else — a string, a `kind` the version does not have, a
 * leaf outside it, or one extra key such as `script` — is refused, not ignored. Ignoring an unknown key
 * would store it, and a stored `script` is one reader away from being run.
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

/** The request's grammar version, when this build serves it. */
export function assertPredicateVersion(version: unknown): number {
  if (typeof version !== 'number' || !WATCH_PREDICATE_VERSIONS.includes(version)) {
    throw watchRefusal(
      'PREDICATE_VERSION_UNSUPPORTED',
      `this build serves predicateVersion ${WATCH_PREDICATE_VERSIONS.join(' and ')}, and the request ${
        version === undefined ? 'named none' : 'named another'
      }`,
    );
  }
  return version;
}

const GRAMMAR = 'no shell, SQL, log regex or free-text expression is part of the grammar';

/** `depth` counts terms from the root, so an aggregation inside a composite is at depth 2. */
export function parseRequestedPredicate(term: unknown, version: number, depth = 1): WatchPredicate {
  if (depth > WATCH_LIMITS.maxPredicateDepth) {
    throw watchRefusal('PREDICATE_TOO_DEEP', `a predicate nests at most ${WATCH_LIMITS.maxPredicateDepth} terms deep`);
  }
  if (!isPlainObject(term)) {
    throw watchRefusal('UNKNOWN_PREDICATE_KIND', `a predicate term is a JSON object, not ${describeJson(term)}: ${GRAMMAR}`);
  }
  const quorum = term.kind === 'AT_LEAST' && version >= 2;
  if (term.kind === 'ALL' || term.kind === 'ANY' || quorum) {
    onlyGrammarKeys(term, ['kind', 'over', 'leaf', ...(quorum ? ['count'] : []), ...(version >= 2 ? ['params'] : [])]);
    if (term.over !== 'ALL_TARGETS') {
      throw watchRefusal('UNKNOWN_PREDICATE_KIND', '`over` selects ALL_TARGETS, the only selector served');
    }
    if (
      typeof term.leaf !== 'string'
      || !Object.prototype.hasOwnProperty.call(WATCH_LEAVES, term.leaf)
      || WATCH_LEAF_SINCE_VERSION[term.leaf as WatchLeaf] > version
    ) {
      const leaves = Object.keys(WATCH_LEAVES).filter((leaf) => WATCH_LEAF_SINCE_VERSION[leaf as WatchLeaf] <= version);
      throw watchRefusal('UNKNOWN_PREDICATE_KIND', `\`leaf\` is one of ${leaves.join(', ')} in predicateVersion ${version}`);
    }
    const leaf = term.leaf as WatchLeaf;
    const problem = leafParamsProblem(leaf, term.params);
    if (problem !== null) throw watchRefusal('PREDICATE_PARAMETER_INVALID', problem);
    const params = term.params === undefined ? {} : { params: { ...(term.params as WatchLeafParams) } };
    if (!quorum) return { kind: term.kind as 'ALL' | 'ANY', over: 'ALL_TARGETS', leaf, ...params };
    if (!Number.isInteger(term.count) || (term.count as number) < 1) {
      throw watchRefusal('PREDICATE_PARAMETER_INVALID', '`AT_LEAST` takes `count`, an integer from 1 up to the number of targets');
    }
    return { kind: 'AT_LEAST', count: term.count as number, over: 'ALL_TARGETS', leaf, ...params };
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
    return { kind: term.kind, operands: term.operands.map((operand) => parseRequestedPredicate(operand, version, depth + 1)) };
  }
  const kinds = version >= 2 ? 'ALL, ANY, AT_LEAST, ALL_OF, ANY_OF' : 'ALL, ANY, ALL_OF, ANY_OF';
  throw watchRefusal('UNKNOWN_PREDICATE_KIND', `\`kind\` is one of ${kinds} in predicateVersion ${version}: ${GRAMMAR}`);
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

/**
 * Contract §12: a quorum is counted over the sealed target set, so it may ask for no more targets than
 * that set holds. Checked against the set as created — the set never grows, so a quorum that fits it now
 * is the largest it can ever have to fit.
 */
export function assertQuorumFitsTargets(predicate: WatchPredicate, targets: number): void {
  if (predicate.kind === 'AT_LEAST') {
    if (predicate.count > targets) {
      throw watchRefusal(
        'PREDICATE_PARAMETER_INVALID',
        `AT_LEAST ${predicate.count} can never hold over a sealed set of ${targets} target${targets === 1 ? '' : 's'}`,
      );
    }
    return;
  }
  if ('operands' in predicate) {
    for (const operand of predicate.operands) assertQuorumFitsTargets(operand, targets);
  }
}

/**
 * A CONTINUOUS watch's debounce window and wake budget, with the contract's defaults filled in; null for a
 * ONE_SHOT watch, which takes neither. Without both a continuous watch is a wake storm waiting for a busy
 * target, which is why it always has them.
 */
export function continuousPolicy(
  mode: WatchMode,
  debounceSeconds: number | undefined,
  wakeBudget: number | undefined,
): { debounceSeconds: number; wakeBudget: number } | null {
  if (mode === 'ONE_SHOT') {
    if (debounceSeconds !== undefined || wakeBudget !== undefined) {
      throw watchRefusal(
        'CONTINUOUS_POLICY_INVALID',
        'debounceSeconds and wakeBudget belong to a CONTINUOUS watch: a ONE_SHOT watch matches once',
      );
    }
    return null;
  }
  const debounce = debounceSeconds ?? WATCH_LIMITS.continuousDebounceSeconds;
  const budget = wakeBudget ?? WATCH_LIMITS.defaultContinuousWakeBudget;
  if (!isIntegerIn(debounce, WATCH_LIMITS.continuousDebounceSeconds, WATCH_LIMITS.maxContinuousDebounceSeconds)) {
    throw watchRefusal(
      'CONTINUOUS_POLICY_INVALID',
      `debounceSeconds is an integer from ${WATCH_LIMITS.continuousDebounceSeconds} to ${WATCH_LIMITS.maxContinuousDebounceSeconds}`,
    );
  }
  if (!isIntegerIn(budget, 1, WATCH_LIMITS.maxContinuousWakeBudget)) {
    throw watchRefusal('CONTINUOUS_POLICY_INVALID', `wakeBudget is an integer from 1 to ${WATCH_LIMITS.maxContinuousWakeBudget}`);
  }
  return { debounceSeconds: debounce, wakeBudget: budget };
}

/**
 * Contract `agentSurface.runnerDoor.mode`: the door an agent asks through makes ONE_SHOT watches, and says
 * so when asked for another. Refused by name rather than dropped by the request whitelist, because a caller
 * that asked to be woken again and again would otherwise be handed a watch that wakes it once and never
 * learn the difference. Where a CONTINUOUS watch is made instead: `continuous.reach`.
 */
export function assertAgentDoorOneShot(request: { mode?: unknown; debounceSeconds?: unknown; wakeBudget?: unknown }): void {
  const HERE = 'a watch made from inside a session wakes the session that asked for it, once;'
    + " a CONTINUOUS watch is the account's own to create (POST /api/watches)";
  if (request.mode !== undefined && request.mode !== 'ONE_SHOT') {
    throw watchRefusal('CONTINUOUS_POLICY_INVALID', `\`mode\` here is ONE_SHOT: ${HERE}`);
  }
  const policy = request.debounceSeconds !== undefined ? 'debounceSeconds' : request.wakeBudget !== undefined ? 'wakeBudget' : null;
  if (policy !== null) {
    throw watchRefusal('CONTINUOUS_POLICY_INVALID', `\`${policy}\` belongs to a CONTINUOUS watch, and this door makes none: ${HERE}`);
  }
}

function isIntegerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
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
