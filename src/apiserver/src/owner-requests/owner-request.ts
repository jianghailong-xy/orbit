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

/**
 * Where a secret goes. Never its value: that travels by a door of its own. `runnerId` is not the caller's to choose
 * (design §4.1): the server takes it from the asking session and stores it here, so a read names the machine.
 */
export interface OwnerRequestSecretSpec {
  name: string;
  runnerId: string;
  envVar?: string;
  filePath?: string;
}

/** A filing's secretSpec, as the caller sends it: `runnerId` only as an assertion of the session's own runner. */
export type OwnerRequestSecretSpecFiling = Omit<OwnerRequestSecretSpec, 'runnerId'> & { runnerId?: string };

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
  secretSpec?: OwnerRequestSecretSpecFiling;
  verifyHint?: string;
  expiresAt?: string;
  clientRequestId?: string;
  projectId?: string;
}

/** A filing this kind cannot carry; the door answers 400 with its message. */
export class OwnerRequestNotFileable extends Error {}

/** A secret's environment variable (design §3.2). */
export const SECRET_ENV_VAR = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Names a secret may not take (design §4.1): Orbit's own (`ORBIT_*`, which covers every name the runner's
 * sessionContextEnvKey and userCredentialEnvKey match), and the ones that change how a program is found or loaded.
 */
export function reservedSecretEnvVar(name: string): boolean {
  return /^(ORBIT_|LD_|DYLD_|PYTHON)/.test(name)
    || ['PATH', 'HOME', 'BASH_ENV', 'ENV', 'NODE_OPTIONS'].includes(name);
}

/**
 * The shape a secret's file path must have (design §5.2), as far as the server can tell without the machine: absolute
 * or under `~/`, no `..` segment, no NUL. The rest — under the runner user's home, outside Orbit's and every
 * workspace's directories, no symlink, not existing — is the runner's to check, at filing and again at delivery.
 */
export function secretFilePathShapeError(path: string): string | undefined {
  if (path.includes('\0')) return 'secretSpec.filePath may not contain NUL';
  if (!(path.startsWith('/') || path.startsWith('~/'))) return 'secretSpec.filePath must be absolute or start with ~/';
  if (path.split('/').includes('..')) return 'secretSpec.filePath may not contain a .. segment';
  return undefined;
}

/** The secret's grant record leaves this many days after the owner submits it, at most (design §3.2). */
export const OWNER_SECRET_MAX_DAYS = 7;

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

  let secretSpec: OwnerRequestSecretSpecFiling | undefined;
  if (kind === 'SECRET') {
    const spec = filing.secretSpec;
    const name = trimmed(spec?.name);
    if (!spec || !name) {
      throw new OwnerRequestNotFileable('a SECRET request needs secretSpec with a name');
    }
    const envVar = trimmed(spec.envVar);
    const filePath = trimmed(spec.filePath);
    if (Boolean(envVar) === Boolean(filePath)) {
      throw new OwnerRequestNotFileable('secretSpec names exactly one destination: envVar or filePath');
    }
    if (envVar && !SECRET_ENV_VAR.test(envVar)) {
      throw new OwnerRequestNotFileable('secretSpec.envVar must match ^[A-Z][A-Z0-9_]{0,63}$');
    }
    if (envVar && reservedSecretEnvVar(envVar)) {
      throw new OwnerRequestNotFileable(`secretSpec.envVar ${envVar} is reserved; choose another name`);
    }
    const pathError = filePath ? secretFilePathShapeError(filePath) : undefined;
    if (pathError) throw new OwnerRequestNotFileable(pathError);
    const runnerId = trimmed(spec.runnerId);
    secretSpec = {
      name,
      ...(runnerId ? { runnerId } : {}),
      ...(envVar ? { envVar } : {}),
      ...(filePath ? { filePath } : {}),
    };
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

/**
 * The turn key an ending is queued under on the asking session. A request ends once, so one key per request; the
 * Watch delivery worker writes it, and `createTurn` replays a retry under it instead of queuing a second turn.
 */
export function ownerRequestTurnClientId(requestId: string): string {
  return `owner-request:${requestId}:resolved`;
}

/** An ended request as the resolution turn reads it: columns that never change once the request has ended. */
export interface EndedOwnerRequest {
  id: string;
  kind: string;
  state: string;
  title: string;
  options: unknown;
  secretSpec: unknown;
  answer: unknown;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  /** SECRET: the grant the owner's value became, if any. Only what never changes once it was delivered. */
  secretGrant?: { exposure: string; expiresAt: Date } | null;
}

/** What each ending means, in the turn's first line. */
const ENDING_MEANING: Readonly<Record<Exclude<OwnerRequestState, 'PENDING'>, string>> = {
  DONE: 'the owner did what was asked',
  DECLINED: 'the owner declined it; their reason is in the payload',
  EXPIRED: 'its deadline passed before the owner answered',
  WITHDRAWN: 'this session withdrew it',
};

/**
 * The structured payload a resolution turn carries: the request's id, kind and outcome, the reason the owner or the
 * session gave, and per kind what was asked for. A DECISION carries the option the owner chose (and their words, if
 * any). A SECRET carries only where the secret goes — its name and the env var or file path — and nothing the owner
 * typed: no value reaches a turn, and neither does a free-text answer the value could have been pasted into.
 */
export function ownerRequestResolutionPayload(request: EndedOwnerRequest): Record<string, unknown> {
  const answer = (request.answer ?? {}) as { option?: number; text?: string };
  const payload: Record<string, unknown> = {
    requestId: request.id,
    kind: request.kind,
    outcome: request.state,
    title: request.title,
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    reason: request.resolutionNote,
  };
  if (request.kind === 'SECRET') {
    const spec = (request.secretSpec ?? {}) as Partial<OwnerRequestSecretSpec>;
    const grant = request.state === 'DONE' ? request.secretGrant : null;
    if (grant) {
      // Delivered (design §7.2): where it is and until when, and how to use it. Never the value or anything of it.
      payload.secret = {
        state: 'ACTIVE',
        name: spec.name,
        exposure: grant.exposure,
        ...(spec.envVar ? { envVar: spec.envVar } : {}),
        ...(spec.filePath ? { path: spec.filePath } : {}),
        runner: spec.runnerId,
        expiresAt: grant.expiresAt.toISOString(),
      };
      payload.usage = spec.envVar
        ? `Run the command that needs it as: orbit secret exec ${spec.envVar} -- <command>. It is not in your own environment.`
        : `It is at ${spec.filePath} (mode 0600) until it is removed. Do not print or copy its contents.`;
      return payload;
    }
    payload.secret = {
      name: spec.name,
      ...(spec.envVar ? { envVar: spec.envVar } : {}),
      ...(spec.filePath ? { filePath: spec.filePath } : {}),
    };
    return payload;
  }
  if (request.kind === 'DECISION' && answer.option !== undefined) {
    const options = (request.options ?? []) as OwnerRequestOption[];
    payload.chosenOption = { index: answer.option, label: options[answer.option]?.label ?? null };
  }
  if (answer.text !== undefined) payload.answerText = answer.text;
  return payload;
}

/**
 * The message the asking session is woken with when its request ends: one line naming the request and how it ended,
 * then the structured payload as JSON. Built only from columns an ended request never changes, so every attempt at one
 * delivery writes the same bytes and a retry replays the turn already queued.
 */
export function ownerRequestResolutionTurn(request: EndedOwnerRequest): string {
  const meaning = ENDING_MEANING[request.state as Exclude<OwnerRequestState, 'PENDING'>] ?? 'it ended';
  const header = [
    `Orbit owner request ${request.id} (${request.kind}) ended ${request.state}: ${meaning}.`,
    '',
    'This turn was queued by Orbit when the request ended, not typed by a person. The request is final and will not wake this session again.',
  ].join('\n');
  return `${header}\n\n\`\`\`json\n${JSON.stringify(ownerRequestResolutionPayload(request), null, 2)}\n\`\`\``;
}
