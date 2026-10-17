import { readFileSync } from 'node:fs';
import https from 'node:https';
import { isAbsolute } from 'node:path';

import {
  KubeAmbiguousError,
  KubeApiError,
  type ConfigMap,
  type KubeObject,
  type KubeResource,
  type KubeWatch,
  type KubeWatchEvent,
  type ManagedKubeClient,
  type PersistentVolume,
  type PersistentVolumeClaim,
  type Pod,
  type Secret,
  type VolumeAttachment,
} from './kube-client';
import type { ManagedRunnerProfile } from './managed-runner-profile';

/**
 * The real Kubernetes client: plain HTTPS to one API server, for one namespace.
 *
 * Constructed only by `kubeClientFromProfile`, which the managed runner module calls only when the
 * feature is enabled and a valid profile names the kubeconfig file, the context, the API server and
 * the namespace. It never reads KUBECONFIG, ~/.kube, a kubeconfig's `current-context`, the context's
 * own namespace as a fallback, or the in-cluster service account files and environment; it refuses
 * exec and auth-provider plugins (they would run commands), basic auth and disabled TLS checks.
 *
 * Every request goes through a `KubeTransport`, so the unit tests stub the HTTP layer and no test
 * ever reaches a cluster. A timeout or a broken connection is a `KubeAmbiguousError`: a write that
 * ends that way may have been applied, and the manager reads it back before it tries again.
 */

export interface KubeTransportRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: URL;
  headers: Record<string, string>;
  body?: string;
  /** 0: no deadline (a watch). */
  timeoutMs: number;
  tls: KubeTls;
}

export interface KubeTls {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
}

export interface KubeTransportResponse {
  status: number;
  body: string;
}

export interface KubeTransport {
  request(request: KubeTransportRequest): Promise<KubeTransportResponse>;
  /** A long GET whose 2xx body is handed over chunk by chunk; any other answer's body is collected. */
  stream(
    request: KubeTransportRequest,
    onChunk: (chunk: string) => void,
  ): { abort(): void; done: Promise<KubeTransportResponse> };
}

export interface KubeHttpClientOptions {
  /** `https://host[:port]`, compared with the profile before this is constructed. */
  server: string;
  namespace: string;
  tls: KubeTls;
  /** A bearer token, read again for every request so a rotated token file is followed. */
  token?: () => string;
  requestTimeoutMs: number;
  transport?: KubeTransport;
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

function objectName(name: string): string {
  if (name.length > 253 || !DNS_SUBDOMAIN.test(name)) throw new Error(`not a Kubernetes object name: ${JSON.stringify(name)}`);
  return name;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The API's answer, refused: its Status object's reason and message when it sent one. */
function apiError(response: KubeTransportResponse, what: string): KubeApiError {
  let reason = '';
  let message = `${what}: HTTP ${response.status}`;
  try {
    const status = JSON.parse(response.body) as { reason?: string; message?: string };
    reason = status.reason ?? '';
    if (status.message) message = `${what}: ${status.message}`;
  } catch {
    // Not a Status object; the HTTP code says enough.
  }
  return new KubeApiError(response.status, reason, message);
}

export class KubeHttpClient implements ManagedKubeClient {
  readonly namespace: string;
  readonly persistentVolumeClaims: KubeResource<PersistentVolumeClaim>;
  readonly secrets: KubeResource<Secret>;
  readonly pods: KubeResource<Pod>;
  readonly configMaps: Pick<KubeResource<ConfigMap>, 'get'>;
  private readonly server: URL;
  private readonly transport: KubeTransport;

  constructor(private readonly options: KubeHttpClientOptions) {
    this.server = new URL(options.server);
    if (this.server.protocol !== 'https:') throw new Error('the Kubernetes API server must be reached over https');
    if (this.server.pathname !== '/' || this.server.search || this.server.username) throw new Error('the Kubernetes API server URL must be a bare origin');
    if (!DNS_LABEL.test(options.namespace)) throw new Error(`not a namespace: ${JSON.stringify(options.namespace)}`);
    this.namespace = options.namespace;
    this.transport = options.transport ?? httpsTransport;
    this.persistentVolumeClaims = this.resource<PersistentVolumeClaim>('persistentvolumeclaims');
    this.secrets = this.resource<Secret>('secrets');
    this.pods = this.resource<Pod>('pods');
    // Read only: the manager can be shown a fencing receipt, and cannot write one.
    const configMaps = this.resource<ConfigMap>('configmaps');
    this.configMaps = { get: configMaps.get };
  }

  async getPersistentVolume(name: string): Promise<PersistentVolume | null> {
    const response = await this.send('GET', `/api/v1/persistentvolumes/${objectName(name)}`);
    if (response.status === 404) return null;
    return this.parse<PersistentVolume>(response, `GET persistentvolume ${name}`);
  }

  async listVolumeAttachments(): Promise<VolumeAttachment[]> {
    const response = await this.send('GET', '/apis/storage.k8s.io/v1/volumeattachments');
    return this.parse<{ items?: VolumeAttachment[] }>(response, 'LIST volumeattachments').items ?? [];
  }

  private resource<T extends KubeObject>(plural: string): KubeResource<T> {
    const base = `/api/v1/namespaces/${this.namespace}/${plural}`;
    return {
      get: async (name) => {
        const response = await this.send('GET', `${base}/${objectName(name)}`);
        if (response.status === 404) return null;
        return this.parse<T>(response, `GET ${plural} ${name}`);
      },
      create: async (object, options) => {
        if (object.metadata.namespace && object.metadata.namespace !== this.namespace) {
          throw new Error(`refusing to create ${plural} ${object.metadata.name} outside namespace ${this.namespace}`);
        }
        objectName(object.metadata.name);
        const response = await this.send('POST', `${base}${query({ dryRun: options?.dryRun ? 'All' : undefined })}`, JSON.stringify(object));
        return this.parse<T>(response, `POST ${plural} ${object.metadata.name}`);
      },
      delete: async (name, options) => {
        const body = {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          ...(options?.uid ? { preconditions: { uid: options.uid } } : {}),
        };
        const response = await this.send('DELETE', `${base}/${objectName(name)}`, JSON.stringify(body));
        if (response.status === 404) return;
        if (response.status < 200 || response.status >= 300) throw apiError(response, `DELETE ${plural} ${name}`);
      },
      list: async (options) => {
        const response = await this.send('GET', `${base}${query({ labelSelector: options?.labelSelector })}`);
        return this.parse<{ items?: T[] }>(response, `LIST ${plural}`).items ?? [];
      },
      watch: (options, onEvent) =>
        this.watch<T>(
          `${base}${query({
            watch: 'true',
            allowWatchBookmarks: 'true',
            labelSelector: options.labelSelector,
            resourceVersion: options.resourceVersion,
          })}`,
          onEvent,
        ),
    };
  }

  private request(method: KubeTransportRequest['method'], path: string, body: string | undefined, timeoutMs: number): KubeTransportRequest {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = this.options.token?.();
    if (token) headers.authorization = `Bearer ${token}`;
    return { method, url: new URL(path, this.server), headers, body, timeoutMs, tls: this.options.tls };
  }

  private send(method: KubeTransportRequest['method'], path: string, body?: string): Promise<KubeTransportResponse> {
    return this.transport.request(this.request(method, path, body, this.options.requestTimeoutMs));
  }

  private parse<T>(response: KubeTransportResponse, what: string): T {
    if (response.status < 200 || response.status >= 300) throw apiError(response, what);
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new KubeAmbiguousError(`${what}: the answer was not JSON`);
    }
  }

  private watch<T>(path: string, onEvent: (event: KubeWatchEvent<T>) => void): KubeWatch {
    let pending = '';
    const stream = this.transport.stream(this.request('GET', path, undefined, 0), (chunk) => {
      pending += chunk;
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) onEvent(JSON.parse(line) as KubeWatchEvent<T>);
      }
    });
    return {
      stop: () => stream.abort(),
      done: stream.done.then((response) => {
        if (response.status < 200 || response.status >= 300) throw apiError(response, `WATCH ${path}`);
      }),
    };
  }
}

/** node:https, with the deadline as a timer of its own: the socket timeout alone is an idle timeout. */
export const httpsTransport: KubeTransport = {
  request(request) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        request.url,
        { method: request.method, headers: request.headers, ...request.tls, agent: false },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk: Buffer) => parts.push(chunk));
          res.on('end', () => {
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') });
          });
          res.on('error', (error) => req.destroy(error));
        },
      );
      const timer = setTimeout(() => req.destroy(new KubeAmbiguousError(`${request.method} ${request.url.pathname} timed out`)), request.timeoutMs);
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof KubeAmbiguousError ? error : new KubeAmbiguousError(`${request.method} ${request.url.pathname} failed: ${error.message}`));
      });
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
  },
  stream(request, onChunk) {
    let req: ReturnType<typeof https.request> | undefined;
    const done = new Promise<KubeTransportResponse>((resolve, reject) => {
      req = https.request(request.url, { method: request.method, headers: request.headers, ...request.tls, agent: false }, (res) => {
        const status = res.statusCode ?? 0;
        const parts: Buffer[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (status >= 200 && status < 300 ? onChunk(chunk) : parts.push(Buffer.from(chunk))));
        res.on('end', () => resolve({ status, body: Buffer.concat(parts).toString('utf8') }));
        res.on('close', () => resolve({ status, body: '' }));
      });
      req.on('error', (error) => {
        // Stopping a watch is how it normally ends; anything else broke it.
        if (aborted) resolve({ status: 200, body: '' });
        else reject(new KubeAmbiguousError(`watch failed: ${error.message}`));
      });
      req.end();
    });
    let aborted = false;
    return {
      abort: () => {
        aborted = true;
        req?.destroy();
      },
      done,
    };
  },
};

/** The entry of a kubeconfig list called `name`, exactly; never a default, never the current one. */
function named(list: unknown, key: 'cluster' | 'user' | 'context', name: string): Record<string, unknown> {
  const found = (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []).filter((entry) => entry?.name === name);
  if (found.length !== 1) throw new Error(`the kubeconfig has ${found.length === 0 ? 'no' : 'more than one'} ${key} named ${JSON.stringify(name)}`);
  const body = found[0][key];
  if (!body || typeof body !== 'object') throw new Error(`the kubeconfig ${key} ${JSON.stringify(name)} is empty`);
  return body as Record<string, unknown>;
}

export interface KubeClientDependencies {
  readFile?: (path: string) => Buffer;
  transport?: KubeTransport;
}

/**
 * The real client for an enabled, valid profile: reads the one kubeconfig file the profile names
 * (JSON — `kubectl config view --raw --flatten -o json` writes it), takes the one context it names,
 * and checks that context against the profile's API server and namespace before anything is sent.
 */
export function kubeClientFromProfile(profile: ManagedRunnerProfile, deps: KubeClientDependencies = {}): KubeHttpClient {
  const read = deps.readFile ?? ((path: string) => readFileSync(path));
  const file = (path: unknown, what: string): Buffer => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`the kubeconfig's ${what} must be an absolute path`);
    return read(path);
  };
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(read(profile.kubernetes.kubeconfig).toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`the kubeconfig ${profile.kubernetes.kubeconfig} is not readable JSON: ${(error as Error).message}`);
  }
  const context = named(config.contexts, 'context', profile.kubernetes.context);
  const cluster = named(config.clusters, 'cluster', String(context.cluster ?? ''));
  const user = named(config.users, 'user', String(context.user ?? ''));

  const server = String(cluster.server ?? '').replace(/\/+$/, '');
  if (server !== profile.kubernetes.apiServer) {
    throw new Error(`context ${profile.kubernetes.context} points at ${server || 'no server'}, not the profile's ${profile.kubernetes.apiServer}`);
  }
  if (context.namespace !== undefined && context.namespace !== profile.kubernetes.namespace) {
    throw new Error(`context ${profile.kubernetes.context} names namespace ${String(context.namespace)}, not the profile's ${profile.kubernetes.namespace}`);
  }
  if (cluster['insecure-skip-tls-verify'] === true) throw new Error('a context that skips TLS verification is refused');
  for (const unsupported of ['exec', 'auth-provider', 'username', 'password']) {
    if (user[unsupported] !== undefined) throw new Error(`the kubeconfig user uses ${unsupported}, which the managed runner manager does not support`);
  }

  const tls: KubeTls = {};
  if (typeof cluster['certificate-authority-data'] === 'string') tls.ca = Buffer.from(cluster['certificate-authority-data'], 'base64');
  else if (cluster['certificate-authority'] !== undefined) tls.ca = file(cluster['certificate-authority'], 'certificate-authority');

  if (typeof user['client-certificate-data'] === 'string') tls.cert = Buffer.from(user['client-certificate-data'], 'base64');
  else if (user['client-certificate'] !== undefined) tls.cert = file(user['client-certificate'], 'client-certificate');
  if (typeof user['client-key-data'] === 'string') tls.key = Buffer.from(user['client-key-data'], 'base64');
  else if (user['client-key'] !== undefined) tls.key = file(user['client-key'], 'client-key');
  if (!!tls.cert !== !!tls.key) throw new Error('a client certificate needs its key, and a key its certificate');

  let token: (() => string) | undefined;
  if (typeof user.token === 'string' && user.token) {
    const fixed = user.token;
    token = () => fixed;
  } else if (user.tokenFile !== undefined) {
    const tokenFile = user.tokenFile;
    file(tokenFile, 'tokenFile');
    token = () => file(tokenFile, 'tokenFile').toString('utf8').trim();
  }
  if (!token && !tls.cert) throw new Error(`the kubeconfig user of context ${profile.kubernetes.context} has no token or client certificate`);

  return new KubeHttpClient({
    server,
    namespace: profile.kubernetes.namespace,
    tls,
    token,
    requestTimeoutMs: profile.lifecycle.requestTimeoutSeconds * 1000,
    transport: deps.transport,
  });
}
