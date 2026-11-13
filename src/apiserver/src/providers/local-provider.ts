import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AgentProvider,
  isCloudModelId,
  localProviderStatus,
  type ProviderAuthMode,
  type ProviderPreset,
  type ProviderScope,
  type ProviderScopeFields,
} from '@orbit/shared';

/**
 * Runner-scoped providers on the API side (docs/ollama-local-provider-contract.md): the rules a write is
 * held to, and the fields every provider read adds. A runner-scoped row is a model server on one runner's
 * own machine — Ollama — that runs Claude Code on that runner alone, takes no key, and lists the models
 * that runner discovers on it.
 */

/** The bound runner, as much of it as a provider read needs: whose it is, and what it can do. */
export const PROVIDER_RUNNER_SELECT = {
  select: { id: true, ownerId: true, capabilities: true, capabilitiesReportedAt: true },
} satisfies Prisma.ModelProvider$runnerArgs;

type BoundRunner = Prisma.RunnerGetPayload<typeof PROVIDER_RUNNER_SELECT>;

/** The row fields the scope view reads. */
export interface ScopedRow {
  ownerId: string | null;
  scope: string;
  authMode: string;
  runnerId: string | null;
  enabled: boolean;
  probeState: string | null;
  probedAt: Date | null;
  probeVersion: string | null;
  probeLatencyMs?: number | null;
  instanceModels: unknown;
  runner?: BoundRunner | null;
}

/** The columns a provider read selects to build the scope fields, beside `ownerId` and `enabled`, which every
 *  such read selects for itself. */
export const PROVIDER_SCOPE_SELECT = {
  scope: true,
  authMode: true,
  runnerId: true,
  probeState: true,
  probedAt: true,
  probeVersion: true,
  probeLatencyMs: true,
  instanceModels: true,
  runner: PROVIDER_RUNNER_SELECT,
} satisfies Prisma.ModelProviderSelect;

/**
 * The fields a provider read carries for scope (shared ProviderScopeFields). The runner is named only while
 * it is still the row owner's own: a runner that moved to another account is nobody's business here, and
 * the row reads as having none (state NO_RUNNER), which is also how dispatch treats it.
 */
export function providerScopeFields(row: ScopedRow): ProviderScopeFields {
  const scope = row.scope === 'runner' ? 'runner' : 'account';
  const authMode = row.authMode === 'none' ? 'none' : 'bearer';
  if (scope === 'account') return { scope, authMode, runnerId: null };
  const runner = ownedRunner(row);
  return { scope, authMode, runnerId: runner?.id ?? null, local: localProviderStatus(row, runner) };
}

function ownedRunner(row: ScopedRow): BoundRunner | null {
  const runner = row.runner ?? null;
  return runner && row.ownerId && runner.ownerId === row.ownerId && runner.id === row.runnerId ? runner : null;
}

/**
 * A whole provider row with every scope column taken out — what a read that spreads the row hands on, beside
 * providerScopeFields. `probeMessage` is the runner's own wording and is not served at all.
 */
export function withoutScopeColumns<T extends ScopedRow & { probeMessage?: string | null }>(row: T) {
  const {
    scope: _scope,
    authMode: _authMode,
    runnerId: _runnerId,
    probeState: _probeState,
    probedAt: _probedAt,
    probeVersion: _probeVersion,
    probeMessage: _probeMessage,
    probeLatencyMs: _probeLatencyMs,
    instanceModels: _instanceModels,
    runner: _runner,
    ...rest
  } = row;
  return rest;
}

function refuse(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

/**
 * One of `ownerId`'s own runners, or the same 404 for one that does not exist and one somebody else owns: a
 * provider is never bound to a runner its owner does not hold, and the refusal says nothing about whose it is.
 */
export async function assertOwnedRunner(
  db: Pick<Prisma.TransactionClient, 'runner'>,
  ownerId: string,
  runnerId: string,
): Promise<void> {
  const runner = await db.runner.findFirst({ where: { id: runnerId, ownerId }, select: { id: true } });
  if (!runner) throw new NotFoundException({ code: 'RUNNER_NOT_FOUND', message: 'runner not found' });
}

/** A local provider names no model Ollama would forward to its cloud (phase 0 §6.3). */
export function assertNoCloudModels(models: unknown, defaultModel?: string | null): void {
  const ids = [
    ...(Array.isArray(models) ? models.map((m) => (m as { value?: unknown })?.value) : []),
    defaultModel,
  ].filter((id): id is string => typeof id === 'string');
  const cloud = ids.find(isCloudModelId);
  if (cloud) {
    throw refuse(
      'PROVIDER_CLOUD_MODEL',
      `model "${cloud}" is an Ollama cloud model; a local provider runs only models served on its own runner`,
    );
  }
}

/** The scope a new provider is created with, after every rule a create is held to. */
export interface CreateScope {
  scope: ProviderScope;
  authMode: ProviderAuthMode;
  runnerId: string | null;
}

/**
 * Decide and check a new provider's scope, auth mode and runner. The defaults follow the preset: a local
 * preset is runner-scoped with no key, everything else is what every provider was before. The rules:
 *
 *   * runner scope goes with authMode `none`, and only there (the database holds the same pair);
 *   * a runner-scoped provider is a personal one, made from a local preset, on Claude Code, bound to one of
 *     the caller's own runners, with no key and no Ollama cloud model;
 *   * every other provider is account-scoped, names no runner, and needs its key exactly as before.
 */
export async function createScope(
  db: Pick<Prisma.TransactionClient, 'runner'>,
  ownerId: string | null,
  dto: { scope?: string; authMode?: string; runnerId?: string; apiKey?: string; runtime?: string; models?: unknown; defaultModel?: string },
  preset: ProviderPreset | undefined,
): Promise<CreateScope> {
  const scope: ProviderScope = (dto.scope as ProviderScope | undefined) ?? (preset?.runnerScoped ? 'runner' : 'account');
  const authMode: ProviderAuthMode = (dto.authMode as ProviderAuthMode | undefined) ?? (scope === 'runner' ? 'none' : 'bearer');
  if ((scope === 'runner') !== (authMode === 'none')) {
    throw refuse(
      'PROVIDER_SCOPE_AUTH_MISMATCH',
      'a provider with no API key must be bound to a runner, and a runner-scoped provider takes no API key',
    );
  }
  if (scope === 'account') {
    if (preset?.runnerScoped) {
      throw refuse('PROVIDER_RUNNER_REQUIRED', `${preset.label} runs on one of your runners; choose the runner it is on`);
    }
    if (dto.runnerId) throw refuse('PROVIDER_RUNNER_NOT_SCOPED', 'only a runner-scoped provider is bound to a runner');
    // The same refusal an empty key always met, now that the field may be omitted for a local server.
    if (!dto.apiKey) throw refuse('PROVIDER_API_KEY_REQUIRED', 'apiKey is required');
    return { scope, authMode, runnerId: null };
  }
  if (ownerId === null) {
    throw refuse('PROVIDER_RUNNER_SHARED', 'a shared provider cannot be bound to a runner; connect it as your own');
  }
  if (!preset?.runnerScoped) {
    throw refuse('PROVIDER_RUNNER_PRESET', 'only a local model server (Ollama) can be bound to a runner');
  }
  if ((dto.runtime ?? preset.runtime ?? AgentProvider.CLAUDE) !== AgentProvider.CLAUDE) {
    throw refuse('PROVIDER_RUNNER_RUNTIME', `${preset.label} runs on Claude Code`);
  }
  if (dto.apiKey !== undefined && dto.apiKey !== '') {
    throw refuse('PROVIDER_API_KEY_UNUSED', `${preset.label} takes no API key; leave it empty`);
  }
  if (!dto.runnerId) throw refuse('PROVIDER_RUNNER_REQUIRED', `${preset.label} runs on one of your runners; choose the runner it is on`);
  await assertOwnedRunner(db, ownerId, dto.runnerId);
  assertNoCloudModels(dto.models, dto.defaultModel);
  return { scope, authMode, runnerId: dto.runnerId };
}

/** The columns a runner's probe wrote, cleared when what it probed is no longer what the row points at. */
export const CLEARED_PROBE = {
  probeState: null,
  probeVersion: null,
  probeMessage: null,
  probedAt: null,
  probeLatencyMs: null,
  instanceModels: Prisma.DbNull,
} as const;

/**
 * The rules an edit of a runner-scoped provider is held to, and what it changes beyond the fields it names:
 * its scope and auth mode are fixed for life; it takes no key; it stays on Claude Code; it names no cloud
 * model; it follows no catalogue; and a new runner or endpoint is one nothing has probed yet.
 */
export async function updateScope(
  db: Pick<Prisma.TransactionClient, 'runner'>,
  current: { ownerId: string | null; scope: string; authMode: string; runnerId: string | null; baseUrl: string; label: string },
  dto: { runnerId?: string; apiKey?: string; runtime?: string; baseUrl?: string; models?: unknown; defaultModel?: string; followsPreset?: boolean },
): Promise<Prisma.ModelProviderUpdateInput> {
  if (current.scope !== 'runner') {
    if (dto.runnerId) throw refuse('PROVIDER_RUNNER_NOT_SCOPED', 'only a runner-scoped provider is bound to a runner');
    return {};
  }
  if (dto.apiKey) throw refuse('PROVIDER_API_KEY_UNUSED', `"${current.label}" takes no API key`);
  if (dto.runtime && dto.runtime !== AgentProvider.CLAUDE) {
    throw refuse('PROVIDER_RUNNER_RUNTIME', `"${current.label}" runs on Claude Code`);
  }
  if (dto.followsPreset) {
    throw refuse('PROVIDER_RUNNER_CATALOGUE', `"${current.label}" lists the models its runner finds; it follows no catalogue`);
  }
  assertNoCloudModels(dto.models, dto.defaultModel);
  const data: Prisma.ModelProviderUpdateInput = {};
  const runnerMoves = !!dto.runnerId && dto.runnerId !== current.runnerId;
  if (runnerMoves) {
    await assertOwnedRunner(db, current.ownerId!, dto.runnerId!);
    data.runner = { connect: { id: dto.runnerId } };
  }
  if (runnerMoves || (!!dto.baseUrl && dto.baseUrl !== current.baseUrl)) Object.assign(data, CLEARED_PROBE);
  return data;
}
