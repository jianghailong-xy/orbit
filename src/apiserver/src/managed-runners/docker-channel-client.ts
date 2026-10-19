import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';

import type { DockerRunnerProfile } from './managed-runner-profile';

/**
 * The apiserver's side of the restricted Docker channel (deploy/managed-runner/docker-channel): JSON
 * over HTTP on the channel's unix socket, or on a loopback port, with its bearer token. This process
 * never opens Docker's own socket; the channel holds it and answers only for resources labelled with
 * its instance, built from its own template.
 *
 * A request that could not be sent or answered (no socket, refused, reset, timed out) is
 * DockerChannelUnreachable: it may or may not have been carried out, so a caller reads the object back
 * by name before trying again. Any answer at or above 400 is a DockerChannelError with the channel's
 * own code. A read of something the channel does not have is null.
 */

/** A volume the channel holds for this instance. */
export interface ChannelVolume {
  name: string;
  uid: string;
  ownerId: string | null;
  runnerId: string | null;
  limitBytes: number | null;
  createdAt: string | null;
  usageBytes: number | null;
}

/** A runner credential, kept by the channel until its generation's container starts. */
export interface ChannelCredential {
  uid: string;
  ownerId: string | null;
  runnerId: string | null;
  generation: number | null;
  token: string | null;
  createdAt: string | null;
}

/** A runner container, as Docker reports it to the channel. */
export interface ChannelContainer {
  name: string;
  /** The instance UID the channel gave it: a canonical UUID, never reused. */
  uid: string;
  ownerId: string | null;
  runnerId: string | null;
  generation: number | null;
  /** The data volume UID it was authorized for. */
  volumeUid: string | null;
  volume: string | null;
  node: string | null;
  /** Docker's own state: created, running, paused, restarting, removing, exited or dead. */
  status: string;
  running: boolean;
  neverStarted: boolean;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  oomKilled: boolean;
  stopping: boolean;
  /** Why the channel stopped it, when it did: its volume over its disk limit. */
  evicted: { reason: string; volume: string; usageBytes: number; limitBytes: number; at: string } | null;
}

/** What holds a volume: this instance's containers by name, anything else only counted. */
export interface ChannelHolder {
  name?: string;
  managed: boolean;
}

/** The host, as the channel reads it: what a capacity budget is derived from. */
export interface ChannelHost {
  name: string | null;
  cpus: number;
  memoryBytes: number;
  serverVersion: string | null;
  /** The filesystem Docker's volumes live on, when the channel can see it. */
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  /** What this instance's data volumes hold now, by Docker's measure. */
  managedVolumeBytes: number;
}

export interface ChannelInfo {
  schemaVersion: number;
  instanceId: string;
  image: string;
  network: { name: string; internal: boolean; interContainer: boolean } | null;
  limits: Record<string, number>;
  stopGraceSeconds: number;
  diskCheckSeconds: number;
  host: ChannelHost;
}

/** What a container is made from: identities and amounts only. The channel's template does the rest. */
export interface ChannelContainerRequest {
  name: string;
  image: string;
  ownerId: string;
  runnerId: string;
  generation: number;
  volume: { name: string; uid: string };
  resources: { cpuMillis: number; memoryBytes: number; pids: number; tmpBytes: number };
  runner: { serverUrl: string; maxConcurrent: number };
  dryRun?: boolean;
}

export class DockerChannelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DockerChannelError';
  }
}

/**
 * The channel could not be reached, or did not answer: whatever was asked may or may not have happened.
 * `connected` false: no connection to the channel was made at all — its socket missing or refusing —
 * so nothing was asked of it.
 */
export class DockerChannelUnreachable extends Error {
  constructor(
    message: string,
    readonly connected = true,
  ) {
    super(message);
    this.name = 'DockerChannelUnreachable';
  }
}

export type DockerChannelTarget = { socketPath: string } | { url: string };

/** What the Docker backend asks of the channel (DockerChannelClient; a test can stand in for it). */
export type DockerChannel = Pick<
  DockerChannelClient,
  | 'info' | 'readVolume' | 'ensureVolume' | 'volumeHolders' | 'readCredential' | 'putCredential' | 'deleteCredential'
  | 'createContainer' | 'dryRunContainer' | 'readContainer' | 'stopContainer' | 'removeContainer' | 'fencingReceipt'
>;

export class DockerChannelClient {
  constructor(
    private readonly target: DockerChannelTarget,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  /** One request; the answer's status and JSON body, or DockerChannelUnreachable. */
  call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string | number> = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': payload.length });
    const where = 'socketPath' in this.target
      ? { socketPath: this.target.socketPath, path }
      : (() => {
        const url = new URL(path, `${this.target.url}/`);
        return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port), path: url.pathname + url.search };
      })();
    return new Promise((resolve, reject) => {
      let connected = false;
      const req = request({ ...where, method, headers, agent: false, timeout: this.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) => reject(new DockerChannelUnreachable(`the Docker channel's answer broke off: ${error.message}`)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            reject(new DockerChannelUnreachable(`the Docker channel answered ${res.statusCode} with a body that is not JSON`));
            return;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T | null });
        });
      });
      req.on('socket', (socket) => socket.once('connect', () => (connected = true)));
      req.on('timeout', () => req.destroy(new Error(`no answer within ${this.timeoutMs} ms`)));
      req.on('error', (error) => reject(new DockerChannelUnreachable(`the Docker channel could not be reached: ${error.message}`, connected)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** The answer's body, or the channel's refusal as a DockerChannelError; 404 is null where `missing` allows it. */
  private async expect<T>(method: string, path: string, body?: unknown, missing = false): Promise<T | null> {
    const answer = await this.call<T & { code?: string; message?: string }>(method, path, body);
    if (answer.status === 404 && missing) return null;
    if (answer.status >= 400) {
      const refusal = (answer.body ?? {}) as { code?: string; message?: string };
      throw new DockerChannelError(answer.status, refusal.code ?? `HTTP_${answer.status}`, refusal.message ?? `the Docker channel answered ${answer.status}`);
    }
    return answer.body as T | null;
  }

  info(): Promise<ChannelInfo> {
    return this.expect<ChannelInfo>('GET', '/v1/info') as Promise<ChannelInfo>;
  }

  readVolume(name: string): Promise<ChannelVolume | null> {
    return this.expect<ChannelVolume>('GET', `/v1/volumes/${encodeURIComponent(name)}`, undefined, true);
  }

  async ensureVolume(name: string, volume: { ownerId: string; runnerId: string; limitBytes: number }): Promise<ChannelVolume> {
    return (await this.expect<ChannelVolume>('PUT', `/v1/volumes/${encodeURIComponent(name)}`, volume))!;
  }

  async volumeHolders(name: string): Promise<ChannelHolder[]> {
    return (await this.expect<{ holders: ChannelHolder[] }>('GET', `/v1/volumes/${encodeURIComponent(name)}/holders`))!.holders;
  }

  readCredential(runnerId: string): Promise<ChannelCredential | null> {
    return this.expect<ChannelCredential>('GET', `/v1/credentials/${encodeURIComponent(runnerId)}`, undefined, true);
  }

  async putCredential(runnerId: string, credential: { ownerId: string; generation: number; token: string }): Promise<ChannelCredential> {
    return (await this.expect<ChannelCredential>('PUT', `/v1/credentials/${encodeURIComponent(runnerId)}`, credential))!;
  }

  /** Removed by the UID it was read with; already gone is done. */
  async deleteCredential(runnerId: string, uid: string): Promise<void> {
    await this.expect('DELETE', `/v1/credentials/${encodeURIComponent(runnerId)}?uid=${encodeURIComponent(uid)}`, undefined, true);
  }

  async createContainer(container: ChannelContainerRequest): Promise<ChannelContainer> {
    return (await this.expect<ChannelContainer>('POST', '/v1/containers', container))!;
  }

  /** A dry run of a create: answers the channel's status and code without making anything. */
  async dryRunContainer(container: ChannelContainerRequest): Promise<{ status: number; code: string | null; message: string | null }> {
    const answer = await this.call<{ code?: string; message?: string }>('POST', '/v1/containers', { ...container, dryRun: true });
    return { status: answer.status, code: answer.body?.code ?? null, message: answer.body?.message ?? null };
  }

  readContainer(name: string): Promise<ChannelContainer | null> {
    return this.expect<ChannelContainer>('GET', `/v1/containers/${encodeURIComponent(name)}`, undefined, true);
  }

  /** Asks the container with this UID to stop (the channel's grace, then a kill). Gone already: null. */
  stopContainer(name: string, uid: string): Promise<ChannelContainer | null> {
    return this.expect<ChannelContainer>('POST', `/v1/containers/${encodeURIComponent(name)}/stop?uid=${encodeURIComponent(uid)}`, undefined, true);
  }

  /** Removes the stopped container with this UID; already gone is done. */
  async removeContainer(name: string, uid: string): Promise<void> {
    await this.expect('DELETE', `/v1/containers/${encodeURIComponent(name)}?uid=${encodeURIComponent(uid)}`, undefined, true);
  }

  fencingReceipt(runnerId: string): Promise<unknown | null> {
    return this.expect<unknown>('GET', `/v1/fencing-receipts/${encodeURIComponent(runnerId)}`, undefined, true);
  }
}

/** The channel a Docker profile names, with the token from its file (which nobody else may read). */
export function dockerChannelFromProfile(profile: DockerRunnerProfile): DockerChannelClient {
  const file = profile.docker.tokenFile;
  const info = statSync(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`the Docker channel token file ${file} must be a file only its owner can read`);
  const token = readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new Error(`the Docker channel token file ${file} holds no token of at least 32 characters`);
  return new DockerChannelClient(profile.docker.channel, token, profile.lifecycle.requestTimeoutSeconds * 1000);
}
