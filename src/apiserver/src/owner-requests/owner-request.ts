/**
 * Owner requests: an agent session asking the account owner to act (migration 0503).
 *
 * One model for the things a session can need from a person: a DECISION it may not make, a
 * SECRET only the owner holds, a MANUAL_STEP only a person can do, a yes/no CONFIRM, and a WIKI_CREATE —
 * a wiki for its repository, which only the owner makes (docs/wiki-explicit-creation-design.md §3.6), and a BROWSER_SIGN_IN
 * — a sign-in to a site in the Orbit Cloud runner's shared browser, which only the owner does (browser_request_sign_in,
 * docs/mocks/runner-browser/03-agent-tools.html ①), and a CHANGE — one setting of one of the owner's runners, which the
 * owner applies with one press (docs/design/owner-request-change.md; v1: a runner's Max Concurrent). This file
 * is the rules with no database in them — what a filing must hold per kind, the state machine, and
 * the lock-screen copy — so they can be read and tested in one place.
 */

import {
  OWNER_REQUEST_CHANGE_REPLACED_NOTE,
  PROJECT_REOPEN_KIND,
  PROJECT_REOPEN_NOTES,
  type OwnerRequestChangeAnswer,
  type OwnerRequestChangeFiling,
  type OwnerRequestChangeOutcome,
  type OwnerRequestChangeSpec,
} from '@orbit/shared';

export const OWNER_REQUEST_KINDS = [
  'DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE', 'BROWSER_SIGN_IN', 'CHANGE',
] as const;
export type OwnerRequestKind = (typeof OWNER_REQUEST_KINDS)[number];

/**
 * An agent proposing a change to the owner's own Settings (docs/settings-from-conversation-design.md §5.1, migration
 * 1273). Filed only by `POST /runner/settings-proposals`, which writes its title and payload, so it is not one of the
 * OWNER_REQUEST_KINDS `POST /runner/owner-requests` takes.
 */
export const SETTINGS_CHANGE = 'SETTINGS_CHANGE';
/**
 * A session asking the owner to reopen a DONE or CANCELLED project (docs/project-reopen-request-design.md §4, migration
 * 1573). Filed only by `POST /runner/projects/:id/reopen-requests`, which writes its title and payload, so it is not one
 * of the OWNER_REQUEST_KINDS either.
 */
export const PROJECT_REOPEN = PROJECT_REOPEN_KIND;
/** Every kind a session files and the owner is alerted to. */
export type FiledOwnerRequestKind = OwnerRequestKind | typeof SETTINGS_CHANGE | typeof PROJECT_REOPEN;

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
/** A WIKI_CREATE filed for a repository whose card the owner already declined (design §3.6, D4). */
export const WIKI_CREATE_DECLINED = 'WIKI_CREATE_DECLINED';
/** A WIKI_CREATE filed from a workspace with no repository: there is nothing to make a wiki for. */
export const WIKI_CREATE_NO_REPOSITORY = 'WIKI_CREATE_NO_REPOSITORY';

/** A settings proposal whose every change is already in force (design §5.1 step 2): nothing to ask the owner. */
export const SETTINGS_ALREADY_SET = 'SETTINGS_ALREADY_SET';
/** A settings proposal re-filing a change this session's card was declined for (design §5.1 step 4). */
export const SETTINGS_CHANGE_DECLINED = 'SETTINGS_CHANGE_DECLINED';
/** Saving a SETTINGS_CHANGE card on a request that carries an acting session (design §5.2): only the owner saves it. */
export const SETTINGS_OWNER_CHANNEL_ONLY = 'SETTINGS_OWNER_CHANNEL_ONLY';
/** Saving a SETTINGS_CHANGE card after one of its settings changed since it was proposed (design §5.2). */
export const SETTINGS_STALE = 'SETTINGS_STALE';

/**
 * BROWSER_SIGN_IN (board docs/mocks/runner-browser/03-agent-tools.html ①). Filed only by browser_request_sign_in, through
 * POST /runner/browser/sign-in-requests, from a session on the account's Orbit Cloud runner; never through
 * request_owner_action's door, which refuses the kind. Orbit writes the title from the site; the agent's reason is `why`.
 * Answered DONE (the owner signed in) or DECLINED (Not now); the agent's call waits for that answer and returns it, so the
 * ending is not also delivered as a turn.
 */
export const BROWSER_SIGN_IN_KIND = 'BROWSER_SIGN_IN';
/** The site a BROWSER_SIGN_IN names: a host as the agent typed it (`github.com`, `accounts.google.com:443`). */
export const BROWSER_SIGN_IN_SITE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;
export const MAX_BROWSER_SIGN_IN_SITE = 253;
/** The reason the decline door records for the card's Not now. */
export const BROWSER_SIGN_IN_NOT_NOW = 'Not now';

/** The card's title, which the server writes: "Sign in to github.com". */
export function browserSignInTitle(site: string): string {
  return `Sign in to ${site}`;
}

/**
 * The site as browser_request_sign_in passed it, reduced to its host: an agent that pastes the login page's URL names the
 * same site as one that types the host. Lowercased; a path, query or credentials in the URL are dropped, never stored.
 * Undefined when what is left is not a host.
 */
export function browserSignInSite(raw: string | undefined): string | undefined {
  let site = raw?.trim() ?? '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(site)) {
    try {
      site = new URL(site).host;
    } catch {
      return undefined;
    }
  }
  site = site.toLowerCase();
  if (!site || site.length > MAX_BROWSER_SIGN_IN_SITE || !BROWSER_SIGN_IN_SITE.test(site)) return undefined;
  return site;
}

/** The maintenance a wiki made from a WIKI_CREATE card starts with (design §3.6): the Create wiki form's defaults. */
export const WIKI_CREATE_DAILY_RUN_LIMIT = 8;
export const WIKI_CREATE_LOOKBACK_DAYS = 14;

/** A repository's name as a wiki title reads it: its last path segment (`github.com/a/lfs-builder` is `lfs-builder`). */
export function wikiRepositoryName(repository: string): string {
  return repository.split('/').filter(Boolean).at(-1) ?? repository;
}

/** The card's title, which the server writes: the agent names no repository. */
export function wikiCreateTitle(repository: string): string {
  return `Create a wiki for ${wikiRepositoryName(repository)}?`;
}

/** The refusal of a filing after the owner declined a wiki for this repository, dated in UTC. */
export function wikiCreateDeclinedMessage(declinedAt: Date): string {
  return `The owner declined a wiki for this repository on ${declinedAt.toISOString().slice(0, 10)}.`;
}

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
  /** Every kind's but WIKI_CREATE's, whose title the server writes. */
  title?: string;
  why: string;
  blocksTaskIds?: string[];
  ifUnanswered?: string;
  options?: OwnerRequestOption[];
  recommendedOption?: number;
  steps?: OwnerRequestStep[];
  secretSpec?: OwnerRequestSecretSpecFiling;
  /** CHANGE: the one setting asked for. v1: `{ runnerId, maxConcurrent }`. */
  change?: OwnerRequestChangeFiling;
  verifyHint?: string;
  expiresAt?: string;
  clientRequestId?: string;
  projectId?: string;
}

/** A filing this kind cannot carry; the door answers 400 with its message. */
export class OwnerRequestNotFileable extends Error {}

/**
 * What a WIKI_CREATE filing may not carry (design §3.6): only `why` and `ifUnanswered` are the agent's — the title and
 * the repository the server reads from the asking session's workspace — beside the transport's own
 * `clientRequestId` and the `projectId` it is filed under.
 */
const NOT_FOR_WIKI_CREATE = [
  'title', 'blocksTaskIds', 'options', 'recommendedOption', 'steps', 'secretSpec', 'change', 'verifyHint', 'expiresAt',
] as const satisfies readonly (keyof OwnerRequestFiling)[];

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
  const { kind } = filing;
  if (kind === BROWSER_SIGN_IN_KIND) {
    throw new OwnerRequestNotFileable(
      'a BROWSER_SIGN_IN request is filed with browser_request_sign_in, from a session on the Orbit Cloud runner',
    );
  }
  if (kind === 'WIKI_CREATE') {
    const carried = NOT_FOR_WIKI_CREATE.find((field) => filing[field] !== undefined);
    if (carried) {
      throw new OwnerRequestNotFileable(
        `${carried} is not for a WIKI_CREATE request: Orbit writes its title and repository, and it carries only why and ifUnanswered`,
      );
    }
  } else if (!title) {
    throw new OwnerRequestNotFileable('title is required: the line the owner reads first');
  }
  if (!why) throw new OwnerRequestNotFileable('why is required: say what this unblocks');
  const only = (field: keyof OwnerRequestFiling, owner: OwnerRequestKind): void => {
    if (filing[field] !== undefined && kind !== owner) {
      throw new OwnerRequestNotFileable(`${field} is only for a ${owner} request`);
    }
  };
  only('options', 'DECISION');
  only('recommendedOption', 'DECISION');
  only('steps', 'MANUAL_STEP');
  only('secretSpec', 'SECRET');
  only('change', 'CHANGE');

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

  let change: OwnerRequestChangeFiling | undefined;
  if (kind === 'CHANGE') change = normalizeChange(filing.change);

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
    change,
    verifyHint: trimmed(filing.verifyHint),
    expiresAt: filing.expiresAt,
    clientRequestId: trimmed(filing.clientRequestId),
    projectId: filing.projectId,
    expiresAtDate,
  };
}

/**
 * A CHANGE's `change`, checked against the typed allow-list (design §2, decision 2): exactly one runner and one setting,
 * and v1's one setting is Max Concurrent, an integer of at least 1 — the floor `PATCH /runners/:id` holds it to.
 */
function normalizeChange(change: OwnerRequestChangeFiling | undefined): OwnerRequestChangeFiling {
  if (!change || typeof change !== 'object') {
    throw new OwnerRequestNotFileable('a CHANGE request needs change: { runnerId, maxConcurrent }');
  }
  const other = Object.keys(change).find((key) => key !== 'runnerId' && key !== 'maxConcurrent');
  if (other) {
    throw new OwnerRequestNotFileable(`change.${other} is not a setting a CHANGE request can ask for; it names maxConcurrent only`);
  }
  const runnerId = typeof change.runnerId === 'string' ? change.runnerId.trim() : '';
  if (!runnerId) throw new OwnerRequestNotFileable('change.runnerId is required: the runner whose setting changes');
  const { maxConcurrent } = change;
  if (maxConcurrent === undefined) throw new OwnerRequestNotFileable('change.maxConcurrent is required: the value asked for');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new OwnerRequestNotFileable('change.maxConcurrent must be an integer of at least 1');
  }
  return { runnerId, maxConcurrent };
}

/** The banner's first line, per kind. Short enough to read at a glance on a lock screen. */
const ALERT_TITLES: Readonly<Record<FiledOwnerRequestKind, string>> = {
  DECISION: 'Decision needed',
  SECRET: 'Secret needed',
  MANUAL_STEP: 'Action needed',
  CONFIRM: 'Please confirm',
  WIKI_CREATE: 'Create a wiki?',
  SETTINGS_CHANGE: 'Confirm settings',
  BROWSER_SIGN_IN: 'Sign in needed',
  CHANGE: 'Setting change',
  PROJECT_REOPEN: 'Reopen project?',
};

/** Longest body a lock screen shows without cutting it. */
export const OWNER_REQUEST_ALERT_BODY_MAX = 110;

/** The lock-screen alert for a newly filed request: the kind as the title, the request's own title as the body. */
export function ownerRequestAlert(kind: FiledOwnerRequestKind, title: string): { title: string; body: string } {
  const line = title.replace(/\s+/g, ' ').trim();
  const body = line.length <= OWNER_REQUEST_ALERT_BODY_MAX
    ? line
    : `${line.slice(0, OWNER_REQUEST_ALERT_BODY_MAX - 1).trimEnd()}…`;
  return { title: ALERT_TITLES[kind], body };
}

/**
 * The alert's category, one per kind, which the clients register with two actions: open the card on its input
 * ("Provide key", "Answer", "Mark done", "Review") and "Later". Neither answers the request from the notification:
 * a SECRET has no reply path outside its card (secrets design §7.2), and the other kinds are read before they are
 * answered.
 */
export function ownerRequestPushCategory(kind: FiledOwnerRequestKind): string {
  return `ORBIT_OWNER_REQUEST_${kind}`;
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
  /** WIKI_CREATE: the repository the wiki was asked for. */
  repoUrlNorm?: string | null;
  /** CHANGE: `{ runnerId, field, requested, before }`, as the server wrote it at filing. */
  changeSpec?: unknown;
  /** PROJECT_REOPEN: `{ projectId, statusAtAsk, settledAt, plannedWork, askers }`, as the server wrote it. */
  payload?: unknown;
}

/**
 * A WIKI_CREATE's two answers, in the words the asking session reads (design §3.6): the wiki it can propose to now, or
 * a repository it is not to ask about again. Its other endings read as any request's.
 */
function wikiCreateMeaning(request: EndedOwnerRequest): string | undefined {
  if (request.kind !== 'WIKI_CREATE') return undefined;
  if (request.state === 'DONE') {
    const name = ((request.answer ?? {}) as { name?: string }).name ?? wikiRepositoryName(request.repoUrlNorm ?? '');
    return `The owner created the wiki ${name}. You can propose to it now.`;
  }
  if (request.state === 'DECLINED') return 'The owner does not want a wiki for this repository. Do not ask again.';
  return undefined;
}

/**
 * A CHANGE withdrawn because a newer filing for the same runner setting replaced it (design §2): not withdrawn by this
 * session, whatever the generic WITHDRAWN line says, so its turn says what happened.
 */
function changeReplacedMeaning(request: EndedOwnerRequest): string | undefined {
  if (request.kind !== 'CHANGE' || request.state !== 'WITHDRAWN') return undefined;
  if (request.resolutionNote !== OWNER_REQUEST_CHANGE_REPLACED_NOTE) return undefined;
  return 'A newer request for the same runner setting replaced it; that one is the request the owner sees now.';
}

/**
 * A PROJECT_REOPEN's endings, in the words the asking sessions read (design §3): on DONE the project is OPEN and the
 * agent retries the write that was refused; on a decline it does not ask again; a deleted project has nothing to retry.
 */
function projectReopenMeaning(request: EndedOwnerRequest): string | undefined {
  if (request.kind !== PROJECT_REOPEN) return undefined;
  if (request.state === 'DONE') {
    return 'The project is OPEN again: the owner reopened it. Retry the write that was refused.';
  }
  if (request.state === 'DECLINED') {
    return 'The owner did not reopen the project; their reason is in the payload. Do not ask again: tell the person.';
  }
  if (request.state === 'WITHDRAWN' && request.resolutionNote === PROJECT_REOPEN_NOTES.projectDeleted) {
    return 'The project was deleted while the request waited; there is nothing to reopen.';
  }
  return undefined;
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
  const answer = (request.answer ?? {}) as { option?: number; text?: string; translation?: { text?: string } };
  // The owner's words as the session reads them: their translation into the agent language when Settings ›
  // Translation made one (the done text's, or a decline's reason's), else as they typed them.
  const translated = typeof answer.translation?.text === 'string' ? answer.translation.text : undefined;
  const payload: Record<string, unknown> = {
    requestId: request.id,
    kind: request.kind,
    outcome: request.state,
    title: request.title,
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    reason: request.state === 'DECLINED' && translated !== undefined ? translated : request.resolutionNote,
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
  if (request.kind === 'WIKI_CREATE') {
    const made = (request.answer ?? {}) as { spaceId?: string; name?: string };
    payload.repository = request.repoUrlNorm ?? null;
    if (request.state === 'DONE' && made.spaceId) payload.wiki = { spaceId: made.spaceId, name: made.name ?? null };
    return payload;
  }
  if (request.kind === 'CHANGE') {
    payload.change = ownerRequestChangeOutcome(request);
    return payload;
  }
  if (request.kind === PROJECT_REOPEN) {
    const asked = (request.payload ?? {}) as { projectId?: string; statusAtAsk?: string };
    payload.project = { projectId: asked.projectId ?? null, statusAtAsk: asked.statusAtAsk ?? null };
    return payload;
  }
  if (request.kind === 'DECISION' && answer.option !== undefined) {
    const options = (request.options ?? []) as OwnerRequestOption[];
    payload.chosenOption = { index: answer.option, label: options[answer.option]?.label ?? null };
  }
  if (answer.text !== undefined) payload.answerText = translated ?? answer.text;
  return payload;
}

/**
 * A CHANGE's `change` in its resolution turn (design §5): what was asked and the value then, and, only when the owner
 * applied it, the value written and the one it replaced at that moment. The agent reads `applied`: the owner may have
 * chosen another number than `requested`.
 */
export function ownerRequestChangeOutcome(request: Pick<EndedOwnerRequest, 'state' | 'changeSpec' | 'answer'>): OwnerRequestChangeOutcome {
  const spec = (request.changeSpec ?? {}) as OwnerRequestChangeSpec;
  const outcome: OwnerRequestChangeOutcome = {
    runnerId: spec.runnerId,
    field: spec.field,
    requested: spec.requested,
    before: spec.before,
  };
  const answer = (request.answer ?? {}) as Partial<OwnerRequestChangeAnswer>;
  if (request.state === 'DONE' && typeof answer.applied === 'number') {
    return { ...outcome, applied: answer.applied, actualBefore: answer.actualBefore };
  }
  return outcome;
}

/**
 * The message the asking session is woken with when its request ends: one line naming the request and how it ended,
 * then the structured payload as JSON. Built only from columns an ended request never changes, so every attempt at one
 * delivery writes the same bytes and a retry replays the turn already queued.
 */
export function ownerRequestResolutionTurn(request: EndedOwnerRequest): string {
  const special = wikiCreateMeaning(request) ?? changeReplacedMeaning(request) ?? projectReopenMeaning(request);
  const meaning = ENDING_MEANING[request.state as Exclude<OwnerRequestState, 'PENDING'>] ?? 'it ended';
  const header = [
    special
      ? `Orbit owner request ${request.id} (${request.kind}) ended ${request.state}. ${special}`
      : `Orbit owner request ${request.id} (${request.kind}) ended ${request.state}: ${meaning}.`,
    '',
    'This turn was queued by Orbit when the request ended, not typed by a person. The request is final and will not wake this session again.',
  ].join('\n');
  return `${header}\n\n\`\`\`json\n${JSON.stringify(ownerRequestResolutionPayload(request), null, 2)}\n\`\`\``;
}
