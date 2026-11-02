import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { removeTempFile, type FileStore, type S3FilesConfig } from './file-store';

/**
 * An S3-compatible bucket as a file store (`ORBIT_FILES_BACKEND=s3`, docs/orbit-files-design.md §2.10):
 * `files/<sha256[0:2]>/<sha256>`, addressed path-style (`<endpoint>/<bucket>/<key>`), which AWS S3, MinIO,
 * Ceph, R2 and the other S3-compatible services all answer.
 *
 * Three requests and a signature, on node:http and node:crypto, rather than an S3 SDK: the AWS SDK brings
 * dozens of packages for what is here HEAD, PUT and GET of one object, and the smaller signing libraries
 * sign `fetch` requests, whose streamed bodies cannot carry the Content-Length a PUT needs. The signing is
 * held to AWS's published examples (s3-file-store.spec.ts) and the store to a real S3-compatible server
 * (files.pg.spec.ts).
 */
export class S3FileStore implements FileStore {
  readonly storage = 's3' as const;
  private readonly endpoint: URL;

  constructor(
    private readonly config: S3FilesConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.endpoint = new URL(config.endpoint);
  }

  keyOf(sha256: string): string {
    return `files/${sha256.slice(0, 2)}/${sha256}`;
  }

  async has(sha256: string): Promise<boolean> {
    const response = await this.send('HEAD', this.keyOf(sha256));
    response.resume();
    if (response.statusCode === 200) return true;
    if (response.statusCode === 404) return false;
    throw new Error(`S3 HEAD ${this.keyOf(sha256)} answered ${response.statusCode}`);
  }

  async put(sha256: string, tempPath: string, sizeBytes: number): Promise<void> {
    try {
      // The payload's sha256 is the one signed, so the service checks the bytes it receives against it
      // and refuses a body that arrives changed.
      const response = await this.send('PUT', this.keyOf(sha256), { body: createReadStream(tempPath), sizeBytes, sha256 });
      if (response.statusCode !== 200) throw await failure(response, 'PUT', this.keyOf(sha256));
      response.resume();
    } finally {
      await removeTempFile(tempPath);
    }
  }

  async open(sha256: string): Promise<Readable | null> {
    const response = await this.send('GET', this.keyOf(sha256));
    if (response.statusCode === 200) return response;
    if (response.statusCode === 404) {
      response.resume();
      return null;
    }
    throw await failure(response, 'GET', this.keyOf(sha256));
  }

  /** One signed request; resolves with the response once its headers have arrived. */
  private send(
    method: 'HEAD' | 'GET' | 'PUT',
    key: string,
    upload?: { body: Readable; sizeBytes: number; sha256: string },
  ): Promise<IncomingMessage> {
    const base = this.endpoint.pathname.replace(/\/+$/, '');
    const requestPath = `${base}/${[this.config.bucket, ...key.split('/')].map(sigV4Encode).join('/')}`;
    const amzDate = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadSha256 = upload?.sha256 ?? EMPTY_PAYLOAD_SHA256;
    const headers: Record<string, string> = {
      host: this.endpoint.host,
      'x-amz-content-sha256': payloadSha256,
      'x-amz-date': amzDate,
      ...(upload ? { 'content-length': String(upload.sizeBytes), 'content-type': 'application/octet-stream' } : {}),
    };
    const authorization = sigV4Authorization(
      { method, path: requestPath, headers, payloadSha256 },
      { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey, region: this.config.region, service: 's3' },
      amzDate,
    );
    const transport = this.endpoint.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(
        {
          hostname: this.endpoint.hostname,
          port: this.endpoint.port || undefined,
          method,
          path: requestPath,
          headers: { ...headers, authorization },
        },
        (response) => {
          // The timeout covers reaching the service and sending to it. Once it answers, the body is read
          // at the pace of whoever it is going to, and a client that leaves ends it (streamable()).
          request.setTimeout(0);
          resolve(response);
        },
      );
      request.on('error', (error) => {
        upload?.body.destroy();
        reject(error);
      });
      request.setTimeout(S3_SEND_TIMEOUT_MS, () => request.destroy(new Error(`S3 ${method} ${key} timed out`)));
      if (!upload) {
        request.end();
        return;
      }
      upload.body.on('error', (error) => request.destroy(error));
      upload.body.pipe(request);
    });
  }
}

/** How long a request may go without progress before it is given up, until the service answers. */
const S3_SEND_TIMEOUT_MS = 60_000;

/** sha256 of no bytes: the payload hash of a request without a body. */
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Percent-encoding as Signature Version 4 spells it: everything but A–Z a–z 0–9 - . _ ~, one path segment at a time. */
export function sigV4Encode(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SigV4Request {
  method: string;
  /** The path exactly as it is sent, already encoded. */
  path: string;
  /** Every header to sign, `host` among them. */
  headers: Record<string, string>;
  /** The payload's sha256 in hex, as `x-amz-content-sha256` states it. */
  payloadSha256: string;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

/**
 * The Authorization header of an AWS Signature Version 4 request with no query string, signed at `amzDate`
 * (`YYYYMMDDTHHMMSSZ`): the canonical request, the string to sign over its hash, and the key derived from the
 * secret through the date, region and service.
 */
export function sigV4Authorization(request: SigV4Request, credentials: SigV4Credentials, amzDate: string): string {
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`;
  const headers = Object.entries(request.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(';');
  const canonicalRequest = [
    request.method,
    request.path,
    '',
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    request.payloadSha256,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  let key = createHmac('sha256', `AWS4${credentials.secretAccessKey}`).update(date).digest();
  for (const part of [credentials.region, credentials.service, 'aws4_request']) {
    key = createHmac('sha256', key).update(part).digest();
  }
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** An error naming what the service answered, with the code its XML body gives. */
async function failure(response: IncomingMessage, method: string, key: string): Promise<Error> {
  let body = '';
  for await (const chunk of response) {
    if (body.length < 4096) body += String(chunk);
  }
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  return new Error(`S3 ${method} ${key} answered ${response.statusCode}${code ? ` ${code}` : ''}`);
}
