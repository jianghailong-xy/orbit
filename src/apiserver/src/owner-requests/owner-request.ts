/**
 * Owner requests: an agent session asking the account owner to act (migration 0503).
 *
 * One model for the four things a session can need from a person: a DECISION it may not make, a
 * SECRET only the owner holds, a MANUAL_STEP only a person can do, and a yes/no CONFIRM. This file
 * is the rules with no database in them — what a filing must hold per kind, the state machine, and
 * the lock-screen copy — so they can be read and tested in one place.
 */

export const OWNER_REQUEST_KINDS = ['DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM'] as const;
export type OwnerRequestKind = (typeof OWNER_REQUEST_KINDS)[number];

export const OWNER_REQUEST_STATES = ['PENDING', 'DONE', 'DECLINED', 'EXPIRED', 'WITHDRAWN'] as const;
export type OwnerRequestState = (typeof OWNER_REQUEST_STATES)[number];

/**
 * The only legal moves: out of PENDING, once. Every terminal state is final — a request the owner
 * declined is not later marked done, and an expired one is not answered late.
 *
 *   DONE       the owner did it (or chose, for a DECISION)
 *   DECLINED   the owner refused it, with a reason
 *   EXPIRED    its deadline passed while it was PENDING (the sweep)
 *   WITHDRAWN  the asking session no longer needs it
 */
export const OWNER_REQUEST_TRANSITIONS: Readonly<Record<OwnerRequestState, readonly OwnerRequestState[]>> = {
  PENDING: ['DONE', 'DECLINED', 'EXPIRED', 'WITHDRAWN'],
  DONE: [],
  DECLINED: [],
  EXPIRED: [],
  WITHDRAWN: [],
};

export function canTransition(from: OwnerRequestState, to: OwnerRequestState): boolean {
  return OWNER_REQUEST_TRANSITIONS[from].includes(to);
}

/** Error codes the doors answer with. */
export const OWNER_REQUEST_NOT_PENDING = 'OWNER_REQUEST_NOT_PENDING';
export const OWNER_REQUEST_EXPIRED = 'OWNER_REQUEST_EXPIRED';
export const OWNER_REQUEST_KEY_SPENT = 'OWNER_REQUEST_KEY_SPENT';
export const OWNER_REQUEST_NOT_ASKER = 'OWNER_REQUEST_NOT_ASKER';

export const MAX_OWNER_REQUEST_TITLE = 200;
export const MAX_OWNER_REQUEST_WHY = 2_000;
export const MAX_OWNER_REQUEST_IF_UNANSWERED = 500;
export const MAX_OWNER_REQUEST_OPTIONS = 4;
export const MAX_OWNER_REQUEST_STEPS = 20;
export const MAX_OWNER_REQUEST_NOTE = 2_000;
export const MAX_OWNER_REQUEST_VERIFY_HINT = 1_000;

export interface OwnerRequestOption {
  label: string;
  description?: string;
}

export interface OwnerRequestStep {
  text: string;
  /** A command the owner can copy and run. */
  command?: string;
  /** A page the owner opens to do the step. */
  link?: string;
}

/** Where a secret goes. Never its value: that travels by a door of its own. */
export interface OwnerRequestSecretSpec {
  name: string;
  runnerId: string;
  envVar?: string;
  filePath?: string;
}

/** A filing as the caller sent it, after DTO validation. */
export interface OwnerRequestFiling {
  kind: OwnerRequestKind;
  title: string;
  why: string;
  blocksTaskIds?: string[];
  ifUnanswered?: string;
  options?: OwnerRequestOption[];
  recommendedOption?: number;
  steps?: OwnerRequestStep[];
  secretSpec?: OwnerRequestSecretSpec;
  verifyHint?: string;
  expiresAt?: string;
  clientRequestId?: string;
  projectId?: string;
}

/** A filing this kind cannot carry; the door answers 400 with its message. */
export class OwnerRequestNotFileable extends Error {}

const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/**
 * The filing, checked against its kind and trimmed. Kind-specific fields are refused on any other
 * kind rather than dropped, so a caller that mixed them up learns it instead of filing a request
 * the owner cannot act on.
 */
export function normalizeOwnerRequest(filing: OwnerRequestFiling, now: Date): OwnerRequestFiling & { expiresAtDate: Date | null } {
  const title = trimmed(filing.title);
  const why = trimmed(filing.why);
  if (!title) throw new OwnerRequestNotFileable('title is required: the line the owner reads first');
  if (!why) throw new OwnerRequestNotFileable('why is required: say what this unblocks');
  const { kind } = filing;
  const only = (field: keyof OwnerRequestFiling, owner: OwnerRequestKind): void => {
    if (filing[field] !== undefined && kind !== owner) {
      throw new OwnerRequestNotFileable(`${field} is only for a ${owner} request`);
    }
  };
  only('options', 'DECISION');
  only('recommendedOption', 'DECISION');
  only('steps', 'MANUAL_STEP');
  only('secretSpec', 'SECRET');

  const options = filing.options?.map((option) => {
    const label = trimmed(option.label);
    if (!label) throw new OwnerRequestNotFileable('every option needs a label');
    const description = trimmed(option.description);
    return { label, ...(description ? { description } : {}) };
  });
  if (filing.recommendedOption !== undefined
    && (!options || filing.recommendedOption < 0 || filing.recommendedOption >= options.length)) {
    throw new OwnerRequestNotFileable('recommendedOption must name one of the options');
  }

  let steps: OwnerRequestStep[] | undefined;
  if (kind === 'MANUAL_STEP') {
    steps = (filing.steps ?? []).map((step) => {
      const text = trimmed(step.text);
      if (!text) throw new OwnerRequestNotFileable('every step needs its text');
      const command = trimmed(step.command);
      const link = trimmed(step.link);
      return { text, ...(command ? { command } : {}), ...(link ? { link } : {}) };
    });
    if (steps.length === 0) throw new OwnerRequestNotFileable('a MANUAL_STEP request needs at least one step');
  }

  let secretSpec: OwnerRequestSecretSpec | undefined;
  if (kind === 'SECRET') {
    const spec = filing.secretSpec;
    const name = trimmed(spec?.name);
    if (!spec || !name || !spec.runnerId) {
      throw new OwnerRequestNotFileable('a SECRET request needs secretSpec with a name and a target runnerId');
    }
    const envVar = trimmed(spec.envVar);
    const filePath = trimmed(spec.filePath);
    if (Boolean(envVar) === Boolean(filePath)) {
      throw new OwnerRequestNotFileable('secretSpec names exactly one destination: envVar or filePath');
    }
    if (envVar && !ENV_VAR.test(envVar)) {
      throw new OwnerRequestNotFileable('secretSpec.envVar must be a valid environment variable name');
    }
    secretSpec = { name, runnerId: spec.runnerId, ...(envVar ? { envVar } : {}), ...(filePath ? { filePath } : {}) };
  }

  let expiresAtDate: Date | null = null;
  if (filing.expiresAt !== undefined) {
    expiresAtDate = new Date(filing.expiresAt);
    if (Number.isNaN(expiresAtDate.getTime())) throw new OwnerRequestNotFileable('expiresAt is not a date');
    if (expiresAtDate.getTime() <= now.getTime()) throw new OwnerRequestNotFileable('expiresAt must be in the future');
  }

  return {
    kind,
    title,
    why,
    blocksTaskIds: [...new Set(filing.blocksTaskIds ?? [])],
    ifUnanswered: trimmed(filing.ifUnanswered),
    options,
    recommendedOption: filing.recommendedOption,
    steps,
    secretSpec,
    verifyHint: trimmed(filing.verifyHint),
    expiresAt: filing.expiresAt,
    clientRequestId: trimmed(filing.clientRequestId),
    projectId: filing.projectId,
    expiresAtDate,
  };
}

/** The banner's first line, per kind. Short enough to read at a glance on a lock screen. */
const ALERT_TITLES: Readonly<Record<OwnerRequestKind, string>> = {
  DECISION: 'Decision needed',
  SECRET: 'Secret needed',
  MANUAL_STEP: 'Action needed',
  CONFIRM: 'Please confirm',
};

/** Longest body a lock screen shows without cutting it. */
export const OWNER_REQUEST_ALERT_BODY_MAX = 110;

/** The lock-screen alert for a newly filed request: the kind as the title, the request's own title as the body. */
export function ownerRequestAlert(kind: OwnerRequestKind, title: string): { title: string; body: string } {
  const line = title.replace(/\s+/g, ' ').trim();
  const body = line.length <= OWNER_REQUEST_ALERT_BODY_MAX
    ? line
    : `${line.slice(0, OWNER_REQUEST_ALERT_BODY_MAX - 1).trimEnd()}…`;
  return { title: ALERT_TITLES[kind], body };
}
