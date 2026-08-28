import {
  FROZEN_ACTION_EFFECT_CLASSES,
  FROZEN_BINDING_FIELDS,
  FROZEN_COMPLETION_DIMENSIONS,
  FROZEN_COMPLETION_STATES,
  FROZEN_OBLIGATION_FIELDS,
  FROZEN_OBLIGATION_KINDS,
  obligationRevision,
  sha256Canonical,
  stableObligationIdentity,
  validateActionSafetyEnvelope,
  validateBinding,
  validateCanonicalFact,
} from './outcome-reconciler-v2.mjs';

const TOP_LEVEL_FIELDS = Object.freeze([
  'schemaVersion',
  'registryVersion',
  'contractName',
  'contractVersion',
  'modelGap',
  'profiles',
  'types',
]);

export const PROTOCOL_TYPE_FIELDS = Object.freeze([
  'kind',
  'mandatory',
  'identityProfile',
  'binding',
  'dispositionProfile',
  'goalAttemptProfile',
  'actor',
  'resolver',
  'action',
  'prerequisites',
  'successFacts',
  'failureFacts',
  'timeout',
  'retry',
  'compensation',
  'attribution',
]);

const ACTOR_FIELDS = Object.freeze(['role', 'adapter', 'capability', 'onUnavailable']);
const RESOLVER_FIELDS = Object.freeze([
  'id',
  'actor',
  'adapter',
  'capability',
  'actionId',
  'from',
  'routes',
]);
const ROUTE_FIELDS = Object.freeze(['on', 'terminal', 'kind', 'bypassesPrerequisites']);
const ACTION_FIELDS = Object.freeze([
  'id',
  'effectClass',
  'resourceType',
  'precondition',
  'authorityProfile',
  'authorityScopes',
  'policyProfile',
  'policyRules',
  'budgetProfile',
  'budgetUnit',
  'budgetCharge',
]);
const PREREQUISITE_FIELDS = Object.freeze(['factKind', 'obligationKind', 'onMissing']);
const TIMEOUT_FIELDS = Object.freeze([
  'logicalTicks',
  'durable',
  'factKind',
  'exit',
  'recoveryKind',
]);
const RETRY_FIELDS = Object.freeze([
  'maxAttempts',
  'sameFailureFingerprintLimit',
  'backoffLogicalTicks',
  'onExhausted',
]);
const COMPENSATION_FIELDS = Object.freeze([
  'mode',
  'capability',
  'manualRecovery',
  'remediationObligationKind',
]);
const ATTRIBUTION_FIELDS = Object.freeze([
  'profile',
  'servesCriterionMode',
  'blocksClosureOf',
]);

const TERMINAL_RESOLVER_TARGETS = Object.freeze([
  'RESOLVED',
  'CANCELLED',
  'SUPERSEDED',
  'ESCALATED',
  'TIMED_OUT',
  'VISIBLE_FAILURE',
]);
const RESOLVER_EVENTS = Object.freeze(['SUCCESS_FACT', 'FAILURE_FACT', 'TIMEOUT']);
const MODEL_GAP_CODES = new Set([
  'UNKNOWN_OBLIGATION_TYPE',
  'MISSING_RESOLVER',
  'RESOLVER_UNCALLABLE',
  'ACTION_UNCALLABLE',
  'RESOLVER_UNREACHABLE',
  'CLOSED_SCC',
  'CLOSED_PREREQUISITE_SCC',
  'NO_EXIT',
  'PROJECT_ATTRIBUTION_INVALID',
  'INVALID_SUCCESS_FACT',
  'REGISTRY_INVALID',
  'UNKNOWN_DISPOSITION_STATE',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableArray(value) {
  return Array.isArray(value) ? value : [];
}

function exactKeys(value, fields, label) {
  if (!isObject(value)) throw protocolError('FIELD_INVALID', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw protocolError(
      'FIELD_INVALID',
      `${label} fields differ: expected ${expected.join(', ')}, got ${actual.join(', ')}`,
    );
  }
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw protocolError('FIELD_INVALID', `${label} must exactly match ${expected.join(', ')}`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw protocolError('FIELD_INVALID', `${label} must be a non-empty string`);
  }
  return value;
}

function uniqueStrings(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw protocolError('FIELD_INVALID', `${label} must be a${allowEmpty ? '' : ' non-empty'} string array`);
  }
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw protocolError('FIELD_INVALID', `${label} contains a non-string or empty entry`);
  }
  if (new Set(value).size !== value.length) {
    throw protocolError('FIELD_INVALID', `${label} contains duplicates`);
  }
  return value;
}

function profile(group, id, label) {
  const value = group?.[id];
  if (!value) throw protocolError('PROFILE_MISSING', `${label} profile ${String(id)} is not registered`);
  return value;
}

function capabilityRecord(inventory, id) {
  if (inventory instanceof Map) return inventory.get(id);
  return inventory?.[id];
}

function clone(value) {
  return structuredClone(value);
}

export class ProtocolRegistryError extends Error {
  constructor(diagnostics) {
    super(`PROTOCOL_REGISTRY_INVALID: ${diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')}`);
    this.name = 'ProtocolRegistryError';
    this.code = 'PROTOCOL_REGISTRY_INVALID';
    this.diagnostics = diagnostics;
  }
}

function protocolError(code, message, detail = null) {
  return new ProtocolRegistryError([{ code, message, detail }]);
}

function diagnosticFrom(error) {
  if (error instanceof ProtocolRegistryError) return error.diagnostics;
  return [{ code: 'REGISTRY_INVALID', message: String(error?.message ?? error), detail: null }];
}

/**
 * Resolve every profile reference into a per-kind protocol. The checked-in JSON stays concise and
 * declarative, while every runtime consumer receives a complete declaration and cannot silently
 * invent defaults for identity, binding, disposition, goal/attempt, authority, policy, budget or
 * cross-project attribution.
 */
export function compileProtocolRegistry(registry, contract) {
  exactKeys(registry, TOP_LEVEL_FIELDS, 'protocol registry');
  if (registry.schemaVersion !== 1) {
    throw protocolError('FIELD_INVALID', 'protocol registry schemaVersion must be 1');
  }
  if (registry.contractName !== contract.contractName || registry.contractVersion !== contract.contractVersion) {
    throw protocolError('CONTRACT_MISMATCH', 'protocol registry is not bound to the frozen contract');
  }
  exactKeys(
    registry.modelGap,
    ['unknownTypeFactKind', 'obligationKind', 'owner', 'outcome', 'visible', 'handleable', 'implicitHumanFallback'],
    'modelGap protocol',
  );
  if (
    registry.modelGap.unknownTypeFactKind !== 'MODEL_GAP_DETECTED'
    || registry.modelGap.obligationKind !== 'DIAGNOSE_MODEL_GAP'
    || registry.modelGap.outcome !== 'MODEL_GAP'
    || registry.modelGap.visible !== true
    || registry.modelGap.handleable !== true
    || registry.modelGap.implicitHumanFallback !== false
    || registry.modelGap.owner === 'OWNER'
  ) {
    throw protocolError('MODEL_GAP_INVALID', 'unknown types must become a visible, actionable, non-human-default MODEL_GAP');
  }
  exactKeys(
    registry.profiles,
    ['identity', 'binding', 'disposition', 'goalAttempt', 'authority', 'policy', 'budget', 'crossProject'],
    'protocol profiles',
  );
  if (!Array.isArray(registry.types)) throw protocolError('FIELD_INVALID', 'protocol registry types must be an array');

  const types = registry.types.map((entry, index) => {
    if (!Object.prototype.hasOwnProperty.call(entry ?? {}, 'resolver') || !entry.resolver) {
      throw protocolError('MISSING_RESOLVER', `${entry?.kind ?? `type[${index}]`} has no resolver declaration`);
    }
    exactKeys(entry, PROTOCOL_TYPE_FIELDS, `protocol type[${index}]`);
    const frozenKind = contract.obligationContract.kinds.find((candidate) => candidate.kind === entry.kind);
    return {
      ...clone(entry),
      contractKind: frozenKind ? clone(frozenKind) : null,
      identity: clone(profile(registry.profiles.identity, entry.identityProfile, 'identity')),
      binding: {
        ...clone(profile(registry.profiles.binding, entry.binding.profile, 'binding')),
        profile: entry.binding.profile,
        subjectTypes: clone(entry.binding.subjectTypes),
      },
      dispositions: clone(profile(registry.profiles.disposition, entry.dispositionProfile, 'disposition')),
      goalAttempt: clone(profile(registry.profiles.goalAttempt, entry.goalAttemptProfile, 'goal/attempt')),
      action: {
        ...clone(entry.action),
        authority: clone(profile(registry.profiles.authority, entry.action.authorityProfile, 'authority')),
        policy: clone(profile(registry.profiles.policy, entry.action.policyProfile, 'policy')),
        budget: clone(profile(registry.profiles.budget, entry.action.budgetProfile, 'budget')),
      },
      crossProject: clone(profile(registry.profiles.crossProject, entry.attribution.profile, 'cross-project')),
    };
  });
  return {
    schemaVersion: registry.schemaVersion,
    registryVersion: registry.registryVersion,
    contractName: registry.contractName,
    contractVersion: registry.contractVersion,
    modelGap: clone(registry.modelGap),
    types,
    registryDigest: sha256Canonical(registry),
  };
}

function assertAdapter(contract, adapterId, actor, label) {
  const adapter = contract.obligationContract.runtimeAdapters.find((entry) => entry.id === adapterId);
  if (!adapter || adapter.status !== 'REGISTERED') {
    throw protocolError('ADAPTER_UNREACHABLE', `${label} adapter ${adapterId} is not registered`);
  }
  if (!adapter.actors.includes(actor)) {
    throw protocolError('ACTOR_CAPABILITY_MISSING', `${label} adapter ${adapterId} cannot be called by ${actor}`);
  }
}

function assertCapability(inventory, id, actor, adapter, unavailableCode, label) {
  const record = capabilityRecord(inventory, id);
  if (!record || typeof record.invoke !== 'function') {
    throw protocolError(unavailableCode, `${label} capability ${id} is not callable`);
  }
  if (record.actor !== actor || record.adapter !== adapter) {
    throw protocolError(
      'ACTOR_CAPABILITY_MISSING',
      `${label} capability ${id} is bound to ${record.actor ?? 'UNKNOWN'}/${record.adapter ?? 'UNKNOWN'}, not ${actor}/${adapter}`,
    );
  }
}

function validateCompiledType(entry, declaration, compiled, contract, capabilityInventory) {
  const label = `protocol ${entry.kind}`;
  nonEmpty(entry.kind, `${label}.kind`);
  if (entry.mandatory !== true) throw protocolError('FIELD_INVALID', `${label} must be mandatory`);

  exactArray(entry.identity.components, contract.obligationContract.identityComponents, `${label}.identity.components`);
  exactArray(entry.identity.forbiddenComponents, contract.obligationContract.identityForbiddenComponents, `${label}.identity.forbiddenComponents`);
  if (entry.identity.namespace !== 'orbit.obligation.v2' || entry.identity.stability !== 'ATTEMPT_AND_DELIVERY_INVARIANT') {
    throw protocolError('IDENTITY_UNSTABLE', `${label} identity is not stable across attempts and delivery`);
  }

  exactArray(entry.binding.requiredFields, FROZEN_BINDING_FIELDS, `${label}.binding.requiredFields`);
  exactArray(entry.binding.materialInvalidators, contract.bindingContract.materialInvalidators, `${label}.binding.materialInvalidators`);
  uniqueStrings(entry.binding.subjectTypes, `${label}.binding.subjectTypes`);
  if (entry.binding.foreignProjectRule !== 'EXPLICIT_ACCEPTED_HANDOFF_ONLY') {
    throw protocolError('PROJECT_ATTRIBUTION_INVALID', `${label} permits implicit foreign project adoption`);
  }

  exactKeys(entry.dispositions, FROZEN_COMPLETION_STATES, `${label}.dispositions`);
  const dispositionContract = {
    SATISFIED: ['RESOLVE', false],
    UNSATISFIED: ['EXECUTE_ACTION', true],
    UNKNOWN: ['MODEL_GAP', true],
    CONFLICT: ['MODEL_GAP', true],
    NOT_APPLICABLE: ['RESOLVE_NOT_APPLICABLE', false],
  };
  for (const state of FROZEN_COMPLETION_STATES) {
    exactKeys(entry.dispositions[state], ['directive', 'blocksClosure'], `${label}.dispositions.${state}`);
    const [directive, blocksClosure] = dispositionContract[state];
    if (entry.dispositions[state].directive !== directive || entry.dispositions[state].blocksClosure !== blocksClosure) {
      throw protocolError('DISPOSITION_INCOMPLETE', `${label} has an unsafe ${state} disposition`);
    }
  }

  exactKeys(entry.goalAttempt, ['appliesTo', 'requiresActiveGoal', 'terminalAttemptEffect', 'identityAcrossAttempts'], `${label}.goalAttempt`);
  if (!['GOAL', 'GOAL_AND_ATTEMPT'].includes(entry.goalAttempt.appliesTo)
      || entry.goalAttempt.requiresActiveGoal !== true
      || entry.goalAttempt.identityAcrossAttempts !== 'STABLE'
      || !entry.goalAttempt.terminalAttemptEffect) {
    throw protocolError('GOAL_ATTEMPT_CONFLATED', `${label} does not preserve active-goal semantics across attempts`);
  }

  exactKeys(declaration.actor, ACTOR_FIELDS, `${label}.actor`);
  if (
    declaration.actor.role !== entry.actor.role
    || declaration.actor.capability !== entry.actor.capability
    || entry.actor.onUnavailable !== 'VISIBLE_PROTOCOL_BLOCK'
  ) {
    throw protocolError('ACTOR_CAPABILITY_MISSING', `${label} actor/capability differs from the frozen kind declaration`);
  }
  assertAdapter(contract, entry.actor.adapter, entry.actor.role, `${label} action`);
  assertCapability(
    capabilityInventory,
    entry.actor.capability,
    entry.actor.role,
    entry.actor.adapter,
    'ACTION_UNCALLABLE',
    `${label} action`,
  );

  if (!entry.resolver) throw protocolError('MISSING_RESOLVER', `${label} has no resolver`);
  exactKeys(entry.resolver, RESOLVER_FIELDS, `${label}.resolver`);
  nonEmpty(entry.resolver.id, `${label}.resolver.id`);
  if (entry.resolver.from !== 'ACTIVE') {
    throw protocolError('RESOLVER_UNREACHABLE', `${label} resolver is not reachable from ACTIVE`);
  }
  if (entry.resolver.actionId !== entry.action.id) {
    throw protocolError('RESOLVER_UNREACHABLE', `${label} resolver does not point at its declared action`);
  }
  assertAdapter(contract, entry.resolver.adapter, entry.resolver.actor, `${label} resolver`);
  assertCapability(
    capabilityInventory,
    entry.resolver.capability,
    entry.resolver.actor,
    entry.resolver.adapter,
    'RESOLVER_UNCALLABLE',
    `${label} resolver`,
  );
  if (!Array.isArray(entry.resolver.routes)) {
    throw protocolError('RESOLVER_UNREACHABLE', `${label} resolver routes must be an array`);
  }
  exactArray(entry.resolver.routes.map((route) => route.on), RESOLVER_EVENTS, `${label}.resolver route events`);
  for (const route of entry.resolver.routes) {
    exactKeys(route, ROUTE_FIELDS, `${label}.resolver route ${route.on}`);
    if (typeof route.bypassesPrerequisites !== 'boolean') {
      throw protocolError('FIELD_INVALID', `${label}.resolver route ${route.on} lacks a prerequisite gate declaration`);
    }
    if ((route.terminal === null) === (route.kind === null)) {
      throw protocolError('NO_EXIT', `${label}.resolver route ${route.on} must name exactly one terminal or kind`);
    }
    if (route.terminal !== null && !TERMINAL_RESOLVER_TARGETS.includes(route.terminal)) {
      throw protocolError('NO_EXIT', `${label}.resolver route ${route.on} names an unknown terminal`);
    }
    if (route.kind !== null && !compiled.types.some((candidate) => candidate.kind === route.kind)) {
      throw protocolError('NO_EXIT', `${label}.resolver route ${route.on} names unregistered kind ${route.kind}`);
    }
  }
  exactKeys(declaration.action, ACTION_FIELDS, `${label}.action`);
  nonEmpty(entry.action.id, `${label}.action.id`);
  if (!FROZEN_ACTION_EFFECT_CLASSES.includes(entry.action.effectClass)) {
    throw protocolError('FIELD_INVALID', `${label} action has an unknown effect class`);
  }
  uniqueStrings(entry.action.authorityScopes, `${label}.action.authorityScopes`);
  uniqueStrings(entry.action.policyRules, `${label}.action.policyRules`);
  nonEmpty(entry.action.resourceType, `${label}.action.resourceType`);
  nonEmpty(entry.action.precondition, `${label}.action.precondition`);
  if (!Number.isInteger(entry.action.budgetCharge) || entry.action.budgetCharge < 0) {
    throw protocolError('FIELD_INVALID', `${label} action budget charge must be a non-negative integer`);
  }
  exactKeys(entry.action.authority, ['bindingField', 'commitRecheck', 'onMissingOrRevoked'], `${label}.authority`);
  exactKeys(entry.action.policy, ['bindingField', 'commitRecheck', 'onMismatch'], `${label}.policy`);
  exactKeys(entry.action.budget, ['bindingField', 'reservationRequired', 'onExhausted'], `${label}.budget`);
  if (
    entry.action.authority.bindingField !== 'authorityGrantDigest'
    || entry.action.authority.commitRecheck !== true
    || entry.action.policy.bindingField !== 'policyDigest'
    || entry.action.policy.commitRecheck !== true
    || entry.action.budget.bindingField !== 'budgetDigest'
    || entry.action.budget.reservationRequired !== true
  ) {
    throw protocolError('ACTION_REQUIREMENT_INVALID', `${label} does not bind authority, policy and budget at commit`);
  }

  if (!Array.isArray(entry.prerequisites)) throw protocolError('FIELD_INVALID', `${label}.prerequisites must be an array`);
  for (const prerequisite of entry.prerequisites) {
    exactKeys(prerequisite, PREREQUISITE_FIELDS, `${label}.prerequisite`);
    if ((prerequisite.factKind === null) === (prerequisite.obligationKind === null)) {
      throw protocolError('FIELD_INVALID', `${label} prerequisite must name exactly one fact or obligation kind`);
    }
    if (prerequisite.factKind !== null && !contract.factKinds.includes(prerequisite.factKind)) {
      throw protocolError('FIELD_INVALID', `${label} prerequisite fact ${prerequisite.factKind} is not registered`);
    }
    if (prerequisite.obligationKind !== null && !compiled.types.some((candidate) => candidate.kind === prerequisite.obligationKind)) {
      throw protocolError('FIELD_INVALID', `${label} prerequisite kind ${prerequisite.obligationKind} is not registered`);
    }
    if (prerequisite.onMissing !== 'VISIBLE_PREREQUISITE') {
      throw protocolError('FIELD_INVALID', `${label} prerequisite can disappear silently`);
    }
  }

  uniqueStrings(entry.successFacts, `${label}.successFacts`);
  uniqueStrings(entry.failureFacts, `${label}.failureFacts`);
  for (const factKind of [...entry.successFacts, ...entry.failureFacts]) {
    if (!contract.factKinds.includes(factKind)) {
      throw protocolError('FIELD_INVALID', `${label} names unregistered fact ${factKind}`);
    }
  }

  exactKeys(declaration.timeout, TIMEOUT_FIELDS, `${label}.timeout`);
  if (!Number.isInteger(entry.timeout.logicalTicks) || entry.timeout.logicalTicks <= 0
      || entry.timeout.durable !== true
      || entry.timeout.exit !== 'TIMEOUT'
      || !contract.factKinds.includes(entry.timeout.factKind)
      || !compiled.types.some((candidate) => candidate.kind === entry.timeout.recoveryKind)) {
    throw protocolError('NO_EXIT', `${label} has no finite durable timeout exit`);
  }

  exactKeys(declaration.retry, RETRY_FIELDS, `${label}.retry`);
  if (!Number.isInteger(entry.retry.maxAttempts) || entry.retry.maxAttempts <= 0
      || !Number.isInteger(entry.retry.sameFailureFingerprintLimit)
      || entry.retry.sameFailureFingerprintLimit <= 0
      || entry.retry.sameFailureFingerprintLimit > entry.retry.maxAttempts
      || !Array.isArray(entry.retry.backoffLogicalTicks)
      || entry.retry.backoffLogicalTicks.length !== entry.retry.maxAttempts
      || entry.retry.backoffLogicalTicks.some((tick) => !Number.isInteger(tick) || tick <= 0)
      || entry.retry.onExhausted !== 'VISIBLE_RETRY_EXHAUSTED') {
    throw protocolError('FIELD_INVALID', `${label} retry policy is not finite and visible`);
  }

  exactKeys(declaration.compensation, COMPENSATION_FIELDS, `${label}.compensation`);
  if (!['NONE_REQUIRED', 'AUTOMATIC', 'MANUAL'].includes(entry.compensation.mode)
      || (entry.compensation.capability === null && !entry.compensation.manualRecovery)
      || entry.compensation.remediationObligationKind !== 'REMEDIATE_SIDE_EFFECT') {
    throw protocolError('FIELD_INVALID', `${label} lacks compensation or manual recovery`);
  }
  if (entry.compensation.capability !== null) {
    assertCapability(
      capabilityInventory,
      entry.compensation.capability,
      'SYSTEM',
      'ACTION_EXECUTOR',
      'ACTION_UNCALLABLE',
      `${label} compensator`,
    );
  }

  exactKeys(declaration.attribution, ATTRIBUTION_FIELDS, `${label}.attribution`);
  uniqueStrings(entry.attribution.blocksClosureOf, `${label}.attribution.blocksClosureOf`);
  if (entry.attribution.blocksClosureOf.some((dimension) => !FROZEN_COMPLETION_DIMENSIONS.includes(dimension))
      || entry.attribution.servesCriterionMode !== 'EXPLICIT_STABLE_IDS'
      || entry.crossProject.implicitAdoption !== 'FORBIDDEN'
      || entry.crossProject.homeProjectSource !== 'BINDING_PROJECT') {
    throw protocolError('PROJECT_ATTRIBUTION_INVALID', `${label} cross-project attribution is ambiguous`);
  }
}

function tarjan(nodes, adjacency) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  }

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

/**
 * Analyse the executable resolver/prerequisite graph, rather than merely checking that fields
 * exist. A kind has an exit only if a resolver route can reach a terminal. Required-obligation
 * cycles are analysed separately because an ordinary success route is gated until every member's
 * prerequisite has already resolved.
 */
export function analyzeProtocolGraph(compiled) {
  const kinds = new Set(compiled.types.map((entry) => entry.kind));
  const adjacency = new Map([...kinds].map((kind) => [kind, new Set()]));
  const prerequisiteAdjacency = new Map([...kinds].map((kind) => [kind, new Set()]));
  const terminalRoutes = new Map([...kinds].map((kind) => [kind, []]));
  const bypassRoutes = new Map([...kinds].map((kind) => [kind, []]));

  for (const entry of compiled.types) {
    for (const prerequisite of entry.prerequisites) {
      if (prerequisite.obligationKind !== null) {
        adjacency.get(entry.kind).add(prerequisite.obligationKind);
        prerequisiteAdjacency.get(entry.kind).add(prerequisite.obligationKind);
      }
    }
    for (const route of entry.resolver.routes) {
      if (route.kind !== null) adjacency.get(entry.kind).add(route.kind);
      if (route.terminal !== null) terminalRoutes.get(entry.kind).push(route.terminal);
      if (route.bypassesPrerequisites) bypassRoutes.get(entry.kind).push(route);
    }
  }

  const canExit = new Set(
    [...kinds].filter((kind) => terminalRoutes.get(kind).length > 0),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const kind of kinds) {
      if (canExit.has(kind)) continue;
      if ([...(adjacency.get(kind) ?? [])].some((target) => canExit.has(target))) {
        canExit.add(kind);
        changed = true;
      }
    }
  }

  const diagnostics = [];
  for (const kind of [...kinds].filter((candidate) => !canExit.has(candidate)).sort()) {
    diagnostics.push({
      code: 'NO_EXIT',
      message: `${kind} has no resolver/prerequisite path to a terminal outcome`,
      detail: { kind },
    });
  }

  const components = tarjan(kinds, adjacency);
  for (const component of components) {
    const members = new Set(component);
    const cyclic = component.length > 1
      || (adjacency.get(component[0]) ?? new Set()).has(component[0]);
    if (!cyclic) continue;
    const hasTerminal = component.some((kind) => terminalRoutes.get(kind).length > 0);
    const hasOutEdge = component.some((kind) =>
      [...(adjacency.get(kind) ?? [])].some((target) => !members.has(target)));
    if (!hasTerminal && !hasOutEdge) {
      diagnostics.push({
        code: 'CLOSED_SCC',
        message: `closed resolver/prerequisite SCC has no outlet: ${component.join(' -> ')}`,
        detail: { kinds: component },
      });
    }
  }

  const prerequisiteComponents = tarjan(kinds, prerequisiteAdjacency);
  for (const component of prerequisiteComponents) {
    const members = new Set(component);
    const cyclic = component.length > 1
      || (prerequisiteAdjacency.get(component[0]) ?? new Set()).has(component[0]);
    if (!cyclic) continue;
    const hasIndependentOutlet = component.some((kind) =>
      bypassRoutes.get(kind).some((route) =>
        route.terminal !== null || (route.kind !== null && !members.has(route.kind))));
    if (!hasIndependentOutlet) {
      diagnostics.push({
        code: 'CLOSED_PREREQUISITE_SCC',
        message: `required-prerequisite SCC has no independent resolver: ${component.join(' -> ')}`,
        detail: { kinds: component },
      });
    }
  }

  return {
    valid: diagnostics.length === 0,
    diagnostics,
    components,
    prerequisiteComponents,
    noExitKinds: [...kinds].filter((kind) => !canExit.has(kind)).sort(),
    edges: [...adjacency.entries()].flatMap(([from, targets]) =>
      [...targets].sort().map((to) => ({ from, to }))),
  };
}

function validateCompiledRegistry(compiled, registry, contract, capabilityInventory) {
  if (compiled.registryVersion !== '2.0.0') {
    throw protocolError('FIELD_INVALID', 'registryVersion must be 2.0.0');
  }
  const kinds = compiled.types.map((entry) => entry.kind);
  exactArray(kinds, FROZEN_OBLIGATION_KINDS, 'protocol kind order');
  if (new Set(kinds).size !== kinds.length) throw protocolError('FIELD_INVALID', 'protocol kinds are duplicated');
  const declarations = new Map(contract.obligationContract.kinds.map((entry) => [entry.kind, entry]));
  const resolverIds = new Set();
  const actionIds = new Set();
  for (let index = 0; index < compiled.types.length; index += 1) {
    const entry = compiled.types[index];
    validateCompiledType(entry, registry.types[index], compiled, contract, capabilityInventory);
    if (resolverIds.has(entry.resolver.id)) throw protocolError('FIELD_INVALID', `resolver id ${entry.resolver.id} is duplicated`);
    if (actionIds.has(entry.action.id)) throw protocolError('FIELD_INVALID', `action id ${entry.action.id} is duplicated`);
    resolverIds.add(entry.resolver.id);
    actionIds.add(entry.action.id);
    const frozenKind = declarations.get(entry.kind);
    if (!frozenKind) throw protocolError('FIELD_INVALID', `kind ${entry.kind} is absent from the frozen contract`);
    if (entry.actor.role !== frozenKind.defaultOwner
        || entry.actor.capability !== frozenKind.capability
        || frozenKind.resolverProfile !== 'STANDARD_MANDATORY') {
      throw protocolError(
        'ACTOR_CAPABILITY_MISSING',
        `${entry.kind} actor/capability/resolver profile differs from the frozen declaration`,
      );
    }
  }
  const graph = analyzeProtocolGraph(compiled);
  if (!graph.valid) throw new ProtocolRegistryError(graph.diagnostics);
  return graph;
}

export function inspectProtocolRegistry(
  registry,
  contract,
  { capabilityInventory = createBuiltinCapabilityCatalog() } = {},
) {
  try {
    const compiled = compileProtocolRegistry(registry, contract);
    const graph = validateCompiledRegistry(compiled, registry, contract, capabilityInventory);
    return { valid: true, diagnostics: [], compiled, graph };
  } catch (error) {
    return { valid: false, diagnostics: diagnosticFrom(error), compiled: null, graph: null };
  }
}

export function assertProtocolRegistry(
  registry,
  contract,
  { capabilityInventory = createBuiltinCapabilityCatalog() } = {},
) {
  const inspection = inspectProtocolRegistry(registry, contract, { capabilityInventory });
  if (!inspection.valid) throw new ProtocolRegistryError(inspection.diagnostics);
  return inspection.compiled;
}

const ACTION_IMPLEMENTATIONS = Object.freeze({
  'goal.disposition.propose': { actor: 'AGENT', adapter: 'COORDINATOR_AGENT', factKind: 'GOAL_DISPOSITION_RECORDED' },
  'dimension.satisfy': { actor: 'AGENT', adapter: 'COORDINATOR_AGENT', factKind: 'DIMENSION_EVALUATED' },
  'fact-cut.repair': { actor: 'SYSTEM', adapter: 'OUTCOME_RECONCILER', factKind: 'ACTION_RECEIPT_RECORDED' },
  'binding.refresh': { actor: 'SYSTEM', adapter: 'OUTCOME_RECONCILER', factKind: 'ACTION_RECEIPT_RECORDED' },
  'artifact.integrate': { actor: 'AGENT', adapter: 'COORDINATOR_AGENT', factKind: 'MERGE_RECEIPT_RECORDED' },
  'target.presence.verify': { actor: 'SYSTEM', adapter: 'OUTCOME_RECONCILER', factKind: 'MERGE_RECEIPT_RECORDED' },
  'verification.execute': { actor: 'AGENT', adapter: 'COORDINATOR_AGENT', factKind: 'ACCEPTANCE_REVISION_RECORDED' },
  'model-gap.diagnose': { actor: 'AGENT', adapter: 'COORDINATOR_AGENT', factKind: 'DIMENSION_EVALUATED' },
  'attempt.start-successor': { actor: 'AGENT', adapter: 'COORDINATOR_AGENT', factKind: 'ATTEMPT_STARTED' },
  'external-wait.monitor': { actor: 'SYSTEM', adapter: 'EXTERNAL_WAIT_MONITOR', factKind: 'JUDGMENT_SIGNAL_OBSERVED' },
  'owner.goal-decision': { actor: 'OWNER', adapter: 'OWNER_DECISION_INBOX', factKind: 'JUDGMENT_DECIDED' },
  'owner.risk-acceptance': { actor: 'OWNER', adapter: 'OWNER_DECISION_INBOX', factKind: 'JUDGMENT_DECIDED' },
  'owner.authorization': { actor: 'OWNER', adapter: 'OWNER_DECISION_INBOX', factKind: 'JUDGMENT_DECIDED' },
  'owner.external-identity': { actor: 'OWNER', adapter: 'OWNER_DECISION_INBOX', factKind: 'JUDGMENT_DECIDED' },
  'effect.remediate': { actor: 'AGENT', adapter: 'COORDINATOR_AGENT', factKind: 'ACTION_RECEIPT_RECORDED' },
  'reconciler.recover': { actor: 'SYSTEM', adapter: 'OUTCOME_RECONCILER', factKind: 'TIMER_FIRED' },
});

const RESOLVER_IMPLEMENTATIONS = Object.freeze({
  'obligation.resolve.establish-goal-disposition': 'GOAL_DISPOSITION_RECORDED',
  'obligation.resolve.satisfy-completion-dimension': 'DIMENSION_EVALUATED',
  'obligation.resolve.repair-fact-cut': 'ACTION_RECEIPT_RECORDED',
  'obligation.resolve.refresh-stale-binding': 'ACTION_RECEIPT_RECORDED',
  'obligation.resolve.prove-artifact-integration': 'MERGE_RECEIPT_RECORDED',
  'obligation.resolve.prove-target-presence': 'MERGE_RECEIPT_RECORDED',
  'obligation.resolve.run-bound-verification': 'ACCEPTANCE_REVISION_RECORDED',
  'obligation.resolve.diagnose-model-gap': 'DIMENSION_EVALUATED',
  'obligation.resolve.start-successor-attempt': 'ATTEMPT_STARTED',
  'obligation.resolve.monitor-external-wait': 'JUDGMENT_SIGNAL_OBSERVED',
  'obligation.resolve.request-goal-decision': 'JUDGMENT_DECIDED',
  'obligation.resolve.request-risk-acceptance': 'JUDGMENT_DECIDED',
  'obligation.resolve.request-new-authorization': 'JUDGMENT_DECIDED',
  'obligation.resolve.request-external-identity': 'JUDGMENT_DECIDED',
  'obligation.resolve.remediate-side-effect': 'ACTION_RECEIPT_RECORDED',
  'obligation.resolve.recover-reconciler': 'TIMER_FIRED',
});

function actionPayload({ declaration, obligation, envelope }) {
  const common = {
    protocolKind: declaration.kind,
    obligationId: obligation.obligationId,
    obligationRevision: obligation.obligationRevision,
    bindingDigest: sha256Canonical(obligation.binding),
    actionId: declaration.action.id,
    actionIntentId: envelope.actionIntentId,
    result: 'SUCCEEDED',
  };
  if (declaration.actor.capability === 'dimension.satisfy'
      || declaration.actor.capability === 'model-gap.diagnose') {
    return {
      ...common,
      dimensionId: declaration.attribution.blocksClosureOf[0],
      state: 'SATISFIED',
      applicabilityProofDigest: null,
      reasonCode: 'CONTROLLED_PROTOCOL_ACTION_SUCCEEDED',
    };
  }
  if (declaration.actor.capability === 'goal.disposition.propose') {
    return { ...common, disposition: 'ACHIEVED' };
  }
  return common;
}

/**
 * The concrete capability catalogue is deliberately independent of the JSON registry. A typo or a
 * newly declared capability therefore does not manufacture a callable implementation by virtue of
 * being declared; build and runtime checks must resolve it here.
 */
export function createBuiltinCapabilityCatalog({ overrides = {} } = {}) {
  const catalog = new Map();
  for (const [id, implementation] of Object.entries(ACTION_IMPLEMENTATIONS)) {
    catalog.set(id, {
      id,
      actor: implementation.actor,
      adapter: implementation.adapter,
      invoke(context) {
        return {
          outcome: 'SUCCEEDED',
          factKind: implementation.factKind,
          payload: actionPayload(context),
          effectDigest: sha256Canonical({ id, actionIntentId: context.envelope.actionIntentId }),
        };
      },
    });
  }
  for (const [id, expectedFactKind] of Object.entries(RESOLVER_IMPLEMENTATIONS)) {
    catalog.set(id, {
      id,
      actor: 'SYSTEM',
      adapter: 'OUTCOME_RECONCILER',
      invoke({ successFact, obligation }) {
        if (successFact.factKind !== expectedFactKind) {
          return { outcome: 'REFUSED', code: 'INVALID_SUCCESS_FACT' };
        }
        if (
          successFact.payload?.obligationId !== obligation.obligationId
          || successFact.payload?.obligationRevision !== obligation.obligationRevision
        ) {
          return { outcome: 'REFUSED', code: 'SUCCESS_FACT_BINDING_MISMATCH' };
        }
        return { outcome: 'RESOLVED', exit: 'RESOLVE', state: 'RESOLVED' };
      },
    });
  }
  catalog.set('effect.rollback.internal', {
    id: 'effect.rollback.internal',
    actor: 'SYSTEM',
    adapter: 'ACTION_EXECUTOR',
    invoke({ envelope }) {
      return { outcome: 'COMPENSATED', effectDigest: sha256Canonical({ compensationFor: envelope.actionIntentId }) };
    },
  });
  catalog.set('effect.rollback.external', {
    id: 'effect.rollback.external',
    actor: 'SYSTEM',
    adapter: 'ACTION_EXECUTOR',
    invoke({ envelope }) {
      return { outcome: 'COMPENSATED', effectDigest: sha256Canonical({ externalCompensationFor: envelope.actionIntentId }) };
    },
  });
  for (const [id, override] of Object.entries(overrides)) {
    if (override === null) catalog.delete(id);
    else catalog.set(id, override);
  }
  return catalog;
}

function digest(label) {
  return sha256Canonical({ fixture: label });
}

export function protocolBinding(kind, subjectType, overrides = {}) {
  return {
    tenantId: 'tenant-protocol',
    projectId: 'project-protocol',
    subjectType,
    subjectId: `${kind.toLowerCase()}:subject`,
    goalId: 'goal-protocol',
    goalRevision: '1',
    contractDigest: digest('contract'),
    evaluationPlanDigest: digest('evaluation-plan'),
    policyDigest: digest('policy'),
    riskPolicyDigest: digest('risk-policy'),
    permissionDigest: digest('permission'),
    authorityGrantDigest: digest('authority'),
    budgetDigest: digest('budget'),
    capabilityRegistryDigest: digest('capability-registry'),
    recipientDigest: digest('recipient'),
    evaluatorDigest: digest('evaluator'),
    factSchemaDigest: digest('fact-schema'),
    environmentDigest: digest('environment'),
    artifactDigest: digest('artifact'),
    targetDigest: digest('target'),
    targetRef: 'refs/heads/protocol-fixture',
    asOfLogicalTime: '100',
    factCutDigest: digest('fact-cut'),
    ...overrides,
  };
}

function actorCapabilities(catalog) {
  const actors = new Map([
    ['SYSTEM', { id: 'system-protocol', role: 'SYSTEM', enabled: true, capabilities: new Set() }],
    ['AGENT', { id: 'agent-protocol', role: 'AGENT', enabled: true, capabilities: new Set() }],
    ['OWNER', { id: 'owner-protocol', role: 'OWNER', enabled: true, capabilities: new Set() }],
    ['EXTERNAL', { id: 'external-protocol', role: 'EXTERNAL', enabled: true, capabilities: new Set() }],
  ]);
  for (const [id, record] of catalog.entries()) {
    if (actors.has(record.actor)) actors.get(record.actor).capabilities.add(id);
  }
  return actors;
}

export function createControlledProtocolRuntime(binding, overrides = {}) {
  validateBinding(binding, overrides.contract ?? {
    bindingContract: { requiredFields: FROZEN_BINDING_FIELDS },
  });
  const capabilities = overrides.capabilities ?? createBuiltinCapabilityCatalog();
  const actors = overrides.actors ?? actorCapabilities(capabilities);
  const runtime = {
    binding,
    capabilities,
    actors,
    authorityGrants: overrides.authorityGrants ?? new Map([[binding.authorityGrantDigest, {
      active: true,
      scopes: new Set(['*']),
    }]]),
    policies: overrides.policies ?? new Map([[binding.policyDigest, {
      active: true,
      rules: new Set(['*']),
    }]]),
    budgets: overrides.budgets ?? new Map([[binding.budgetDigest, {
      accountId: binding.projectId,
      limit: 100,
      remaining: 100,
      reservationSequence: 0,
    }]]),
    facts: overrides.facts ?? [],
    factKinds: overrides.factKinds ?? new Set(),
    resolvedKinds: overrides.resolvedKinds ?? new Set(),
    activeObligations: overrides.activeObligations ?? new Map(),
    receipts: overrides.receipts ?? new Map(),
    retryAttempts: overrides.retryAttempts ?? new Map(),
    goal: overrides.goal ?? {
      goalId: binding.goalId,
      goalRevision: binding.goalRevision,
      projectId: binding.projectId,
      disposition: 'ACTIVE',
    },
    attempt: overrides.attempt ?? {
      attemptId: 'attempt-protocol',
      attemptGeneration: '1',
      goalId: binding.goalId,
      goalRevision: binding.goalRevision,
      status: 'OPEN',
      outcome: null,
    },
    criterionOwners: overrides.criterionOwners ?? new Map(),
    crossings: overrides.crossings ?? new Map(),
    logicalTime: BigInt(overrides.logicalTime ?? binding.asOfLogicalTime),
    invocationLog: overrides.invocationLog ?? [],
  };
  for (const fact of runtime.facts) runtime.factKinds.add(fact.factKind);
  return runtime;
}

function claimTypeFor(factKind) {
  if (factKind === 'ACTION_INTENT_RECORDED') return 'INTENT';
  if (factKind === 'JUDGMENT_DECIDED') return 'DECISION';
  if (factKind.endsWith('_RECORDED') || factKind === 'TIMER_FIRED') return 'RECEIPT';
  return 'ATTESTATION';
}

export function appendProtocolFact(runtime, contract, {
  factKind,
  payload,
  binding = runtime.binding,
  principalType = 'SYSTEM',
  idempotencyKey = null,
}) {
  runtime.logicalTime += 1n;
  const logicalTime = runtime.logicalTime.toString();
  const payloadDigest = sha256Canonical(payload);
  const key = idempotencyKey ?? `protocol-fact:${factKind}:${logicalTime}:${payloadDigest}`;
  const fact = {
    factId: sha256Canonical({ key, logicalTime }),
    factKind,
    tenantId: binding.tenantId,
    subject: {
      type: binding.subjectType,
      id: binding.subjectId,
      projectId: binding.projectId,
    },
    binding,
    schemaVersion: 2,
    schemaDigest: binding.factSchemaDigest,
    payload,
    payloadDigest,
    claimType: claimTypeFor(factKind),
    principal: {
      type: principalType,
      id: `${principalType.toLowerCase()}-protocol-runtime`,
    },
    authority: {
      grantId: `grant:${binding.authorityGrantDigest.slice(0, 16)}`,
      grantDigest: binding.authorityGrantDigest,
      scopeDigest: digest(`scope:${binding.authorityGrantDigest}`),
      delegationChainDigest: digest(`delegation:${binding.authorityGrantDigest}`),
      validFromLogicalTime: '0',
      validThroughLogicalTime: null,
      revokedAtLogicalTime: null,
    },
    observedAt: '2026-08-28T00:00:00.000Z',
    recordedAt: '2026-08-28T00:00:01.000Z',
    logicalTime,
    causalPredecessorFactId: runtime.facts.at(-1)?.factId ?? null,
    idempotencyKey: key,
    source: {
      system: 'OUTCOME_PROTOCOL_RUNTIME',
      collectorId: 'controlled-action-executor',
      collectorVersion: '2.0.0',
    },
    signature: null,
  };
  validateCanonicalFact(fact, contract);
  runtime.facts.push(fact);
  runtime.factKinds.add(fact.factKind);
  return fact;
}

function protocolKind(compiled, kind) {
  return compiled.types.find((entry) => entry.kind === kind) ?? null;
}

export function instantiateProtocolObligation(compiled, contract, kind, {
  binding,
  reasonCode = 'PROTOCOL_FIXTURE_UNSATISFIED',
  servesCriterionIds = [`criterion:${kind}`],
  blockingProjectIds = [binding.projectId],
  crossingId = null,
  handoffId = null,
  handoffStatus = 'NOT_REQUIRED',
  attributionDecisionFactId = null,
  dueLogicalTime = null,
} = {}) {
  const declaration = protocolKind(compiled, kind);
  if (!declaration) throw protocolError('UNKNOWN_OBLIGATION_TYPE', `cannot instantiate unknown type ${kind}`);
  const homeProjectId = binding.projectId;
  const obligationId = stableObligationIdentity({
    tenantId: binding.tenantId,
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    contractDigest: binding.contractDigest,
    kind,
    subjectType: binding.subjectType,
    subjectId: binding.subjectId,
    homeProjectId,
  }, contract);
  const actionProtocolDigest = sha256Canonical(declaration);
  const revision = obligationRevision({
    obligationId,
    bindingDigest: sha256Canonical(binding),
    authorityGrantDigest: binding.authorityGrantDigest,
    reasonCode,
    owner: declaration.actor.role,
    capability: declaration.actor.capability,
    actionProtocolDigest,
    dueLogicalTime,
  }, contract);
  const obligation = {
    obligationId,
    obligationRevision: revision,
    kind,
    state: 'ACTIVE',
    mandatory: true,
    owner: declaration.actor.role,
    capability: declaration.actor.capability,
    binding,
    reason: {
      code: reasonCode,
      message: `${kind} requires its declared controlled action.`,
      evidenceFactIds: [],
      attemptedActions: [],
      nextAction: declaration.action.id,
    },
    actionProtocolProfile: declaration.contractKind.actionProtocolProfile,
    servesCriterionIds,
    blocksClosureOf: [...declaration.attribution.blocksClosureOf],
    ownership: {
      homeProjectId,
      blockingProjectIds,
      crossingId,
      handoffId,
      handoffStatus,
      attributionDecisionFactId,
    },
    resolverProfile: declaration.contractKind.resolverProfile,
    createdAtLogicalTime: binding.asOfLogicalTime,
    dueLogicalTime,
  };
  validateProtocolObligation(obligation, declaration, contract);
  return obligation;
}

export function validateProtocolObligation(obligation, declaration, contract, runtime = null) {
  exactKeys(obligation, FROZEN_OBLIGATION_FIELDS, 'protocol obligation');
  validateBinding(obligation.binding, contract);
  if (obligation.kind !== declaration.kind
      || obligation.mandatory !== true
      || obligation.state !== 'ACTIVE'
      || obligation.owner !== declaration.actor.role
      || obligation.capability !== declaration.actor.capability
      || !declaration.binding.subjectTypes.includes(obligation.binding.subjectType)) {
    throw protocolError('OBLIGATION_PROTOCOL_MISMATCH', `${obligation.kind} does not match its protocol declaration`);
  }
  const ownership = obligation.ownership;
  exactKeys(ownership, contract.crossProjectContract.ownershipRequiredFields, 'protocol obligation ownership');
  if (ownership.homeProjectId !== obligation.binding.projectId) {
    throw protocolError('PROJECT_ATTRIBUTION_INVALID', 'homeProjectId differs from the binding project');
  }
  uniqueStrings(ownership.blockingProjectIds, 'ownership.blockingProjectIds');
  uniqueStrings(obligation.servesCriterionIds, 'obligation.servesCriterionIds', { allowEmpty: true });
  uniqueStrings(obligation.blocksClosureOf, 'obligation.blocksClosureOf');
  if (JSON.stringify(obligation.blocksClosureOf) !== JSON.stringify(declaration.attribution.blocksClosureOf)) {
    throw protocolError('PROJECT_ATTRIBUTION_INVALID', 'blocksClosureOf differs from the type declaration');
  }
  const foreignProjects = ownership.blockingProjectIds.filter((projectId) => projectId !== ownership.homeProjectId);
  if (foreignProjects.length === 0) {
    if (ownership.crossingId !== null
        || ownership.handoffId !== null
        || ownership.handoffStatus !== 'NOT_REQUIRED'
        || ownership.attributionDecisionFactId !== null) {
      throw protocolError('PROJECT_ATTRIBUTION_INVALID', 'local obligation claims a crossing or handoff');
    }
  } else {
    if (!ownership.crossingId
        || !ownership.handoffId
        || ownership.handoffStatus !== 'ACCEPTED'
        || !ownership.attributionDecisionFactId) {
      throw protocolError('PROJECT_ATTRIBUTION_INVALID', 'foreign closure edge lacks an accepted handoff and attribution fact');
    }
    if (runtime) {
      const crossing = runtime.crossings.get(ownership.crossingId);
      if (!crossing
          || crossing.homeProjectId !== ownership.homeProjectId
          || crossing.handoffId !== ownership.handoffId
          || crossing.status !== 'ACCEPTED'
          || foreignProjects.some((projectId) => !crossing.blockingProjectIds.includes(projectId))) {
        throw protocolError('PROJECT_ATTRIBUTION_INVALID', 'runtime crossing does not authorize the declared foreign closure edge');
      }
    }
  }
  if (runtime) {
    for (const criterionId of obligation.servesCriterionIds) {
      const criterionProjectId = runtime.criterionOwners.get(criterionId);
      if (!criterionProjectId) {
        throw protocolError('PROJECT_ATTRIBUTION_INVALID', `criterion ${criterionId} has no explicit project owner`);
      }
      if (criterionProjectId !== ownership.homeProjectId
          && !ownership.blockingProjectIds.includes(criterionProjectId)) {
        throw protocolError('PROJECT_ATTRIBUTION_INVALID', `criterion ${criterionId} belongs to an undeclared project`);
      }
    }
  }
  const expectedIdentity = stableObligationIdentity({
    tenantId: obligation.binding.tenantId,
    goalId: obligation.binding.goalId,
    goalRevision: obligation.binding.goalRevision,
    contractDigest: obligation.binding.contractDigest,
    kind: obligation.kind,
    subjectType: obligation.binding.subjectType,
    subjectId: obligation.binding.subjectId,
    homeProjectId: ownership.homeProjectId,
  }, contract);
  if (obligation.obligationId !== expectedIdentity) {
    throw protocolError('IDENTITY_UNSTABLE', 'obligationId is not the stable identity of its goal binding');
  }
  const expectedRevision = obligationRevision({
    obligationId: obligation.obligationId,
    bindingDigest: sha256Canonical(obligation.binding),
    authorityGrantDigest: obligation.binding.authorityGrantDigest,
    reasonCode: obligation.reason.code,
    owner: obligation.owner,
    capability: obligation.capability,
    actionProtocolDigest: sha256Canonical(declaration),
    dueLogicalTime: obligation.dueLogicalTime,
  }, contract);
  if (obligation.obligationRevision !== expectedRevision) {
    throw protocolError('IDENTITY_UNSTABLE', 'obligationRevision is not bound to the current protocol and action context');
  }
  return obligation;
}

function seedPrerequisites(runtime, contract, declaration) {
  for (const prerequisite of declaration.prerequisites) {
    if (prerequisite.factKind !== null && !runtime.factKinds.has(prerequisite.factKind)) {
      appendProtocolFact(runtime, contract, {
        factKind: prerequisite.factKind,
        payload: {
          fixture: true,
          prerequisiteFor: declaration.kind,
          obligationKind: declaration.kind,
        },
      });
    }
    if (prerequisite.obligationKind !== null) runtime.resolvedKinds.add(prerequisite.obligationKind);
  }
}

export function createProtocolFixture(registry, contract, kind, options = {}) {
  const compiled = assertProtocolRegistry(registry, contract);
  const declaration = protocolKind(compiled, kind);
  if (!declaration) throw protocolError('UNKNOWN_OBLIGATION_TYPE', `unknown fixture kind ${kind}`);
  const binding = protocolBinding(kind, declaration.binding.subjectTypes[0], options.binding);
  const obligationOptions = {
    binding,
    ...options.obligation,
  };
  const obligation = instantiateProtocolObligation(compiled, contract, kind, obligationOptions);
  const runtime = createControlledProtocolRuntime(binding, {
    contract,
    ...options.runtime,
  });
  if (kind === 'START_SUCCESSOR_ATTEMPT') {
    runtime.attempt = {
      ...runtime.attempt,
      status: 'CLOSED',
      outcome: 'FAILED',
    };
  }
  for (const criterionId of obligation.servesCriterionIds) {
    if (!runtime.criterionOwners.has(criterionId)) {
      runtime.criterionOwners.set(criterionId, binding.projectId);
    }
  }
  seedPrerequisites(runtime, contract, declaration);
  runtime.activeObligations.set(obligation.obligationId, obligation);
  return { compiled, declaration, binding, obligation, runtime };
}

function hasAll(set, required) {
  return required.every((entry) => set.has('*') || set.has(entry));
}

function appendDiagnostic(runtime, contract, obligation, code, message, {
  nextKind = 'RECOVER_RECONCILER',
  nextAction = 'REPAIR_PROTOCOL_RUNTIME',
  status = null,
  detail = {},
} = {}) {
  const modelGap = MODEL_GAP_CODES.has(code);
  const factKind = modelGap ? 'MODEL_GAP_DETECTED' : 'ACTION_RECEIPT_RECORDED';
  const fact = appendProtocolFact(runtime, contract, {
    factKind,
    payload: {
      code,
      message,
      obligationId: obligation?.obligationId ?? null,
      obligationRevision: obligation?.obligationRevision ?? null,
      protocolKind: obligation?.kind ?? detail.kind ?? null,
      visible: true,
      handleable: true,
      humanFallback: false,
      nextKind,
      nextAction,
      ...detail,
    },
  });
  return {
    status: status ?? (modelGap ? 'MODEL_GAP' : 'BLOCKED'),
    code,
    visible: true,
    handleable: true,
    owner: 'SYSTEM',
    humanFallback: false,
    next: { kind: nextKind, action: nextAction },
    obligation,
    facts: [fact],
    proof: {
      obligationId: obligation?.obligationId ?? null,
      activeAfter: obligation ? runtime.activeObligations.has(obligation.obligationId) : false,
      progressed: true,
    },
  };
}

function actionEnvelope(declaration, obligation, runtime, budget, contract) {
  const idempotencyKey = `protocol:v2:${obligation.obligationId}:${obligation.obligationRevision}:${declaration.action.id}`;
  const envelope = {
    actionIntentId: sha256Canonical({ idempotencyKey, kind: declaration.kind }),
    tenantId: obligation.binding.tenantId,
    obligationId: obligation.obligationId,
    obligationRevision: obligation.obligationRevision,
    effectClass: declaration.action.effectClass,
    resourceType: declaration.action.resourceType,
    resourceId: obligation.binding.subjectId,
    targetDigest: obligation.binding.targetDigest,
    authorityGrantDigest: obligation.binding.authorityGrantDigest,
    policyDigest: obligation.binding.policyDigest,
    preconditionDigest: sha256Canonical({
      precondition: declaration.action.precondition,
      factKinds: [...runtime.factKinds].sort(),
      resolvedKinds: [...runtime.resolvedKinds].sort(),
    }),
    evaluatedThroughLogicalTime: runtime.logicalTime.toString(),
    idempotencyKey,
    budget: {
      accountId: budget.accountId,
      unit: declaration.action.budgetUnit,
      charge: declaration.action.budgetCharge,
      limit: budget.limit,
      reservationId: sha256Canonical({ idempotencyKey, reservation: budget.reservationSequence + 1 }),
    },
    retryPolicy: {
      maxAttempts: declaration.retry.maxAttempts,
      backoffDigest: sha256Canonical(declaration.retry.backoffLogicalTicks),
      sameFailureFingerprintLimit: declaration.retry.sameFailureFingerprintLimit,
    },
    compensation: {
      compensatorCapability: declaration.compensation.capability,
      manualRecovery: declaration.compensation.manualRecovery,
      remediationObligationKind: declaration.compensation.remediationObligationKind,
    },
    receiptRequirements: {
      providerIdentity: true,
      effectDigest: true,
      observedAt: true,
      result: true,
      idempotencyKey: true,
    },
  };
  validateActionSafetyEnvelope(envelope, contract);
  return envelope;
}

function prerequisiteMissing(declaration, runtime) {
  return declaration.prerequisites.find((prerequisite) =>
    prerequisite.factKind !== null
      ? !runtime.factKinds.has(prerequisite.factKind)
      : !runtime.resolvedKinds.has(prerequisite.obligationKind));
}

function runtimeCapability(runtime, id, actor, adapter, code, label) {
  const record = capabilityRecord(runtime.capabilities, id);
  if (!record || typeof record.invoke !== 'function') {
    throw protocolError(code, `${label} capability ${id} is not callable`);
  }
  if (record.actor !== actor || record.adapter !== adapter) {
    throw protocolError('ACTOR_CAPABILITY_MISSING', `${label} capability ${id} is bound to the wrong actor or adapter`);
  }
  return record;
}

function runtimeInspection(registry, contract, runtime) {
  return inspectProtocolRegistry(registry, contract, { capabilityInventory: runtime.capabilities });
}

export function protocolDisposition(registry, contract, kind, state) {
  const inspection = inspectProtocolRegistry(registry, contract);
  if (!inspection.valid) return { directive: 'MODEL_GAP', blocksClosure: true, diagnostics: inspection.diagnostics };
  const declaration = protocolKind(inspection.compiled, kind);
  if (!declaration || !FROZEN_COMPLETION_STATES.includes(state)) {
    return {
      directive: 'MODEL_GAP',
      blocksClosure: true,
      diagnostics: [{
        code: !declaration ? 'UNKNOWN_OBLIGATION_TYPE' : 'UNKNOWN_DISPOSITION',
        message: !declaration ? `unknown obligation type ${kind}` : `unknown disposition ${state}`,
      }],
    };
  }
  return clone(declaration.dispositions[state]);
}

function resolveInspectionFailure(registry, contract, kind, obligation, runtime) {
  const rawType = stableArray(registry?.types).find((entry) => entry?.kind === kind);
  if (!rawType) {
    return appendDiagnostic(runtime, contract, obligation, 'UNKNOWN_OBLIGATION_TYPE', `dynamic obligation type ${kind} is not registered`, {
      nextKind: registry?.modelGap?.obligationKind ?? 'DIAGNOSE_MODEL_GAP',
      nextAction: 'REGISTER_OR_DIAGNOSE_DYNAMIC_TYPE',
      detail: { kind },
    });
  }
  const inspection = runtimeInspection(registry, contract, runtime);
  if (inspection.valid) return { inspection };
  const diagnostic = inspection.diagnostics.find((entry) =>
    entry.code === 'CLOSED_SCC' || entry.code === 'CLOSED_PREREQUISITE_SCC')
    ?? inspection.diagnostics[0];
  return appendDiagnostic(runtime, contract, obligation, diagnostic.code, diagnostic.message, {
    nextKind: 'DIAGNOSE_MODEL_GAP',
    nextAction: 'REPAIR_PROTOCOL_REGISTRY',
    detail: { registryDiagnostic: diagnostic },
  });
}

function handleActionFailure({ actionResult, declaration, obligation, envelope, runtime, contract, facts }) {
  const code = actionResult.code ?? actionResult.outcome ?? 'ACTION_FAILED';
  const failureFact = appendProtocolFact(runtime, contract, {
    factKind: declaration.failureFacts[0],
    principalType: declaration.actor.role,
    idempotencyKey: `${envelope.idempotencyKey}:failure:${code}`,
    payload: {
      protocolKind: declaration.kind,
      obligationId: obligation.obligationId,
      obligationRevision: obligation.obligationRevision,
      actionIntentId: envelope.actionIntentId,
      result: actionResult.outcome ?? 'FAILED',
      code,
      failureFingerprint: sha256Canonical({ code, detail: actionResult.detail ?? null }),
    },
  });
  facts.push(failureFact);
  const attempts = (runtime.retryAttempts.get(envelope.idempotencyKey) ?? 0) + 1;
  runtime.retryAttempts.set(envelope.idempotencyKey, attempts);

  if (actionResult.outcome === 'WRONG_EFFECT') {
    let compensation = null;
    if (declaration.compensation.capability !== null) {
      const compensator = runtimeCapability(
        runtime,
        declaration.compensation.capability,
        'SYSTEM',
        'ACTION_EXECUTOR',
        'ACTION_UNCALLABLE',
        'compensator',
      );
      runtime.invocationLog.push(declaration.compensation.capability);
      compensation = compensator.invoke({ declaration, obligation, envelope, actionResult, runtime });
      facts.push(appendProtocolFact(runtime, contract, {
        factKind: 'ACTION_RECEIPT_RECORDED',
        idempotencyKey: `${envelope.idempotencyKey}:compensation`,
        payload: {
          protocolKind: declaration.kind,
          obligationId: obligation.obligationId,
          obligationRevision: obligation.obligationRevision,
          result: compensation.outcome,
          compensationCapability: declaration.compensation.capability,
          effectDigest: compensation.effectDigest,
        },
      }));
    }
    return {
      status: 'PROGRESSED',
      code: 'WRONG_EFFECT_REMEDIATION_REQUIRED',
      visible: true,
      handleable: true,
      owner: 'AGENT',
      humanFallback: false,
      next: { kind: declaration.compensation.remediationObligationKind, action: 'REMEDIATE_RECORDED_EFFECT' },
      obligation,
      facts,
      compensation,
      proof: { obligationId: obligation.obligationId, activeAfter: true, progressed: true },
    };
  }

  const exhausted = attempts >= declaration.retry.maxAttempts;
  return {
    status: exhausted ? 'BLOCKED' : 'RETRY_SCHEDULED',
    code: exhausted ? 'RETRY_EXHAUSTED' : 'ACTION_FAILED_RETRY_SCHEDULED',
    visible: true,
    handleable: true,
    owner: declaration.actor.role,
    humanFallback: false,
    next: exhausted
      ? { kind: 'DIAGNOSE_MODEL_GAP', action: declaration.retry.onExhausted }
      : { kind: declaration.kind, action: declaration.action.id },
    obligation,
    facts,
    proof: { obligationId: obligation.obligationId, activeAfter: true, progressed: true },
  };
}

/**
 * Execute one mandatory obligation through the constrained action envelope and the separately
 * registered resolver. Every refusal appends a canonical fact and returns an explicit next
 * protocol; none defaults to a person or leaves the obligation silently parked.
 */
export function executeProtocolAction({
  registry,
  contract,
  kind,
  obligation,
  runtime,
  disposition = 'UNSATISFIED',
}) {
  runtime.activeObligations.set(obligation.obligationId, obligation);
  const previous = runtime.receipts.get(`${obligation.obligationId}:${obligation.obligationRevision}`);
  if (previous) return { ...previous, replayed: true };

  const inspectionResult = resolveInspectionFailure(registry, contract, kind, obligation, runtime);
  if (!inspectionResult.inspection) return inspectionResult;
  const { compiled } = inspectionResult.inspection;
  const declaration = protocolKind(compiled, kind);

  try {
    validateProtocolObligation(obligation, declaration, contract, runtime);
  } catch (error) {
    const diagnostic = diagnosticFrom(error)[0];
    return appendDiagnostic(runtime, contract, obligation, diagnostic.code, diagnostic.message, {
      nextKind: 'DIAGNOSE_MODEL_GAP',
      nextAction: 'REPAIR_PROJECT_ATTRIBUTION',
      detail: { diagnostic },
    });
  }

  if (!runtime.goal
      || runtime.goal.goalId !== obligation.binding.goalId
      || runtime.goal.goalRevision !== obligation.binding.goalRevision
      || (declaration.goalAttempt.requiresActiveGoal && runtime.goal.disposition !== 'ACTIVE')) {
    return appendDiagnostic(runtime, contract, obligation, 'GOAL_CONTEXT_INVALID', 'runtime goal is absent, stale or no longer active', {
      nextKind: 'ESTABLISH_GOAL_DISPOSITION',
      nextAction: 'REFRESH_GOAL_CONTEXT',
    });
  }
  if (declaration.goalAttempt.appliesTo === 'GOAL_AND_ATTEMPT'
      && (!runtime.attempt
        || runtime.attempt.goalId !== obligation.binding.goalId
        || runtime.attempt.goalRevision !== obligation.binding.goalRevision)) {
    return appendDiagnostic(runtime, contract, obligation, 'ATTEMPT_CONTEXT_INVALID', 'runtime attempt is absent or belongs to another goal revision', {
      nextKind: 'START_SUCCESSOR_ATTEMPT',
      nextAction: 'RESTORE_BOUND_ATTEMPT_CONTEXT',
    });
  }
  if (kind === 'START_SUCCESSOR_ATTEMPT' && runtime.attempt.status !== 'CLOSED') {
    return appendDiagnostic(runtime, contract, obligation, 'PREREQUISITE_UNSATISFIED', 'a successor attempt requires a terminal predecessor attempt', {
      nextKind: kind,
      nextAction: 'WAIT_FOR_ATTEMPT_TERMINATION',
      status: 'WAITING_PREREQUISITE',
    });
  }

  const dispositionPlan = protocolDisposition(registry, contract, kind, disposition);
  if (dispositionPlan.directive === 'MODEL_GAP') {
    return appendDiagnostic(runtime, contract, obligation, 'UNKNOWN_DISPOSITION_STATE', `${kind} disposition ${disposition} requires model diagnosis`, {
      nextKind: 'DIAGNOSE_MODEL_GAP',
      nextAction: 'DIAGNOSE_DISPOSITION',
    });
  }
  if (['RESOLVE', 'RESOLVE_NOT_APPLICABLE'].includes(dispositionPlan.directive)) {
    const exitFact = appendProtocolFact(runtime, contract, {
      factKind: 'OBLIGATION_EXIT_RECORDED',
      idempotencyKey: `protocol-disposition:${obligation.obligationId}:${obligation.obligationRevision}:${disposition}`,
      payload: {
        protocolKind: kind,
        obligationId: obligation.obligationId,
        obligationRevision: obligation.obligationRevision,
        disposition,
        exit: 'RESOLVE',
        state: 'RESOLVED',
      },
    });
    runtime.activeObligations.delete(obligation.obligationId);
    runtime.resolvedKinds.add(kind);
    const result = {
      status: 'RESOLVED',
      code: disposition === 'NOT_APPLICABLE' ? 'PROVEN_NOT_APPLICABLE' : 'ALREADY_SATISFIED',
      visible: true,
      handleable: true,
      owner: 'SYSTEM',
      humanFallback: false,
      action: null,
      obligation: { ...obligation, state: 'RESOLVED' },
      facts: [exitFact],
      proof: {
        obligationId: obligation.obligationId,
        exitFactId: exitFact.factId,
        activeAfter: false,
        progressed: true,
      },
      replayed: false,
    };
    runtime.receipts.set(`${obligation.obligationId}:${obligation.obligationRevision}`, result);
    return result;
  }

  let actionCapability;
  let resolverCapability;
  try {
    actionCapability = runtimeCapability(
      runtime,
      declaration.actor.capability,
      declaration.actor.role,
      declaration.actor.adapter,
      'ACTION_UNCALLABLE',
      `${kind} action`,
    );
    resolverCapability = runtimeCapability(
      runtime,
      declaration.resolver.capability,
      declaration.resolver.actor,
      declaration.resolver.adapter,
      'RESOLVER_UNCALLABLE',
      `${kind} resolver`,
    );
  } catch (error) {
    const diagnostic = diagnosticFrom(error)[0];
    return appendDiagnostic(runtime, contract, obligation, diagnostic.code, diagnostic.message, {
      nextKind: 'DIAGNOSE_MODEL_GAP',
      nextAction: 'RESTORE_CALLABLE_CAPABILITY',
    });
  }

  const actor = runtime.actors.get(declaration.actor.role);
  if (!actor || actor.enabled !== true) {
    return appendDiagnostic(runtime, contract, obligation, 'ACTOR_DISABLED', `${declaration.actor.role} owner is disabled`, {
      nextKind: 'RECOVER_RECONCILER',
      nextAction: 'RESTORE_OR_REASSIGN_DECLARED_ACTOR',
    });
  }
  if (!actor.capabilities.has(declaration.actor.capability)) {
    return appendDiagnostic(runtime, contract, obligation, 'ACTOR_CAPABILITY_MISSING', `${declaration.actor.role} lacks ${declaration.actor.capability}`, {
      nextKind: 'RECOVER_RECONCILER',
      nextAction: 'ASSIGN_CAPABLE_DECLARED_ACTOR',
    });
  }
  const resolverActor = runtime.actors.get(declaration.resolver.actor);
  if (!resolverActor || resolverActor.enabled !== true
      || !resolverActor.capabilities.has(declaration.resolver.capability)) {
    return appendDiagnostic(runtime, contract, obligation, 'ACTOR_CAPABILITY_MISSING', `${declaration.resolver.actor} cannot call ${declaration.resolver.capability}`, {
      nextKind: 'RECOVER_RECONCILER',
      nextAction: 'RESTORE_RESOLVER_ACTOR_CAPABILITY',
    });
  }

  const grant = runtime.authorityGrants.get(obligation.binding.authorityGrantDigest);
  if (!grant || grant.active !== true || !hasAll(grant.scopes, declaration.action.authorityScopes)) {
    return appendDiagnostic(runtime, contract, obligation, 'AUTHORITY_UNAVAILABLE', 'bound authority is missing, revoked or too narrow', {
      nextKind: 'REQUEST_NEW_AUTHORIZATION',
      nextAction: declaration.action.authority.onMissingOrRevoked,
    });
  }
  const policy = runtime.policies.get(obligation.binding.policyDigest);
  if (!policy || policy.active !== true || !hasAll(policy.rules, declaration.action.policyRules)) {
    return appendDiagnostic(runtime, contract, obligation, 'POLICY_MISMATCH', 'bound policy is missing or does not permit the action', {
      nextKind: 'DIAGNOSE_MODEL_GAP',
      nextAction: declaration.action.policy.onMismatch,
    });
  }
  const budget = runtime.budgets.get(obligation.binding.budgetDigest);
  if (!budget || budget.remaining < declaration.action.budgetCharge) {
    return appendDiagnostic(runtime, contract, obligation, 'BUDGET_EXHAUSTED', 'bound action budget is exhausted', {
      nextKind: kind,
      nextAction: declaration.action.budget.onExhausted,
    });
  }
  const missing = prerequisiteMissing(declaration, runtime);
  if (missing) {
    return appendDiagnostic(runtime, contract, obligation, 'PREREQUISITE_UNSATISFIED', 'declared prerequisite is not satisfied', {
      nextKind: missing.obligationKind ?? kind,
      nextAction: missing.onMissing,
      status: 'WAITING_PREREQUISITE',
      detail: { prerequisite: missing },
    });
  }

  const envelope = actionEnvelope(declaration, obligation, runtime, budget, contract);
  const facts = [appendProtocolFact(runtime, contract, {
    factKind: 'ACTION_INTENT_RECORDED',
    principalType: declaration.actor.role,
    idempotencyKey: `${envelope.idempotencyKey}:intent`,
    payload: {
      protocolKind: declaration.kind,
      obligationId: obligation.obligationId,
      obligationRevision: obligation.obligationRevision,
      actionIntentId: envelope.actionIntentId,
      actionId: declaration.action.id,
      effectClass: declaration.action.effectClass,
      authorityGrantDigest: envelope.authorityGrantDigest,
      policyDigest: envelope.policyDigest,
      budgetReservationId: envelope.budget.reservationId,
      preconditionDigest: envelope.preconditionDigest,
    },
  })];

  budget.remaining -= declaration.action.budgetCharge;
  budget.reservationSequence += 1;
  runtime.invocationLog.push(declaration.actor.capability);
  let actionResult;
  try {
    actionResult = actionCapability.invoke({ declaration, obligation, envelope, runtime });
  } catch (error) {
    actionResult = { outcome: 'FAILED', code: 'ACTION_THROWN', detail: String(error?.message ?? error) };
  }
  if (!actionResult || actionResult.outcome !== 'SUCCEEDED') {
    return handleActionFailure({ actionResult: actionResult ?? { outcome: 'FAILED', code: 'EMPTY_ACTION_RESULT' }, declaration, obligation, envelope, runtime, contract, facts });
  }
  if (!declaration.successFacts.includes(actionResult.factKind)) {
    return appendDiagnostic(runtime, contract, obligation, 'INVALID_SUCCESS_FACT', `${kind} action returned undeclared fact ${String(actionResult.factKind)}`, {
      nextKind: 'DIAGNOSE_MODEL_GAP',
      nextAction: 'REPAIR_ACTION_IMPLEMENTATION',
    });
  }
  const successFact = appendProtocolFact(runtime, contract, {
    factKind: actionResult.factKind,
    principalType: declaration.actor.role,
    idempotencyKey: `${envelope.idempotencyKey}:success`,
    payload: actionResult.payload,
  });
  facts.push(successFact);
  if (kind === 'START_SUCCESSOR_ATTEMPT') {
    runtime.attempt = {
      attemptId: `attempt:${successFact.factId}`,
      attemptGeneration: String(Number(runtime.attempt.attemptGeneration) + 1),
      goalId: obligation.binding.goalId,
      goalRevision: obligation.binding.goalRevision,
      status: 'OPEN',
      outcome: null,
    };
  }

  runtime.invocationLog.push(declaration.resolver.capability);
  let resolution;
  try {
    resolution = resolverCapability.invoke({ declaration, obligation, envelope, successFact, runtime });
  } catch (error) {
    return appendDiagnostic(runtime, contract, obligation, 'RESOLVER_UNCALLABLE', `${kind} resolver threw: ${String(error?.message ?? error)}`, {
      nextKind: 'DIAGNOSE_MODEL_GAP',
      nextAction: 'REPAIR_RESOLVER_IMPLEMENTATION',
    });
  }
  if (resolution?.outcome !== 'RESOLVED') {
    return appendDiagnostic(runtime, contract, obligation, resolution?.code ?? 'RESOLVER_UNREACHABLE', `${kind} resolver refused its declared success fact`, {
      nextKind: 'DIAGNOSE_MODEL_GAP',
      nextAction: 'REPAIR_RESOLVER_FACT_ROUTE',
    });
  }
  const exitFact = appendProtocolFact(runtime, contract, {
    factKind: 'OBLIGATION_EXIT_RECORDED',
    idempotencyKey: `${envelope.idempotencyKey}:exit`,
    payload: {
      protocolKind: declaration.kind,
      obligationId: obligation.obligationId,
      obligationRevision: obligation.obligationRevision,
      successFactId: successFact.factId,
      exit: resolution.exit,
      state: resolution.state,
    },
  });
  facts.push(exitFact);
  runtime.activeObligations.delete(obligation.obligationId);
  runtime.resolvedKinds.add(kind);
  const result = {
    status: 'RESOLVED',
    code: 'CONTROLLED_ACTION_RESOLVED',
    visible: true,
    handleable: true,
    owner: declaration.actor.role,
    humanFallback: false,
    action: declaration.action.id,
    actionCapability: declaration.actor.capability,
    resolverCapability: declaration.resolver.capability,
    envelope,
    obligation: { ...obligation, state: 'RESOLVED' },
    facts,
    proof: {
      obligationId: obligation.obligationId,
      successFactId: successFact.factId,
      exitFactId: exitFact.factId,
      activeAfter: runtime.activeObligations.has(obligation.obligationId),
      progressed: true,
    },
    replayed: false,
  };
  runtime.receipts.set(`${obligation.obligationId}:${obligation.obligationRevision}`, result);
  return result;
}

export function timeoutProtocolObligation({ registry, contract, kind, obligation, runtime }) {
  const inspectionResult = resolveInspectionFailure(registry, contract, kind, obligation, runtime);
  if (!inspectionResult.inspection) return inspectionResult;
  const declaration = protocolKind(inspectionResult.inspection.compiled, kind);
  const fact = appendProtocolFact(runtime, contract, {
    factKind: declaration.timeout.factKind,
    idempotencyKey: `protocol-timeout:${obligation.obligationId}:${obligation.obligationRevision}`,
    payload: {
      protocolKind: kind,
      obligationId: obligation.obligationId,
      obligationRevision: obligation.obligationRevision,
      exit: declaration.timeout.exit,
      state: 'TIMED_OUT',
      recoveryKind: declaration.timeout.recoveryKind,
    },
  });
  runtime.activeObligations.delete(obligation.obligationId);
  return {
    status: 'TIMED_OUT',
    code: 'DURABLE_TIMEOUT_EXIT',
    visible: true,
    handleable: true,
    owner: 'SYSTEM',
    humanFallback: false,
    next: { kind: declaration.timeout.recoveryKind, action: 'EXECUTE_TIMEOUT_RECOVERY' },
    facts: [fact],
    proof: { obligationId: obligation.obligationId, activeAfter: false, progressed: true },
  };
}

export function runProtocolConformanceMatrix(registry, contract) {
  const compiled = assertProtocolRegistry(registry, contract);
  const traces = [];
  for (const declaration of compiled.types) {
    const fixture = createProtocolFixture(registry, contract, declaration.kind);
    const result = executeProtocolAction({
      registry,
      contract,
      kind: declaration.kind,
      obligation: fixture.obligation,
      runtime: fixture.runtime,
    });
    for (const fact of result.facts) validateCanonicalFact(fact, contract);
    if (result.status !== 'RESOLVED'
        || result.proof.activeAfter !== false
        || !fixture.runtime.invocationLog.includes(declaration.actor.capability)
        || !fixture.runtime.invocationLog.includes(declaration.resolver.capability)) {
      throw protocolError('CONFORMANCE_FAILED', `${declaration.kind} did not complete its controlled action protocol`);
    }
    traces.push({
      kind: declaration.kind,
      obligationId: fixture.obligation.obligationId,
      obligationRevision: fixture.obligation.obligationRevision,
      actor: declaration.actor.role,
      actionCapability: declaration.actor.capability,
      resolverCapability: declaration.resolver.capability,
      effectClass: declaration.action.effectClass,
      factKinds: result.facts.map((fact) => fact.factKind),
      status: result.status,
      activeAfter: result.proof.activeAfter,
    });
  }
  return {
    registryDigest: compiled.registryDigest,
    registered: compiled.types.length,
    instantiated: traces.length,
    executed: traces.length,
    resolved: traces.filter((trace) => trace.status === 'RESOLVED').length,
    validFacts: traces.reduce((sum, trace) => sum + trace.factKinds.length, 0),
    traces,
  };
}
