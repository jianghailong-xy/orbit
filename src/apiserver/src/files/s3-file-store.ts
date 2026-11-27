import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { SHA256_NAME, assertRange, removeTempFile, type ByteRange, type FileStore, type S3FilesConfig, type StoredObject } from './file-store';

/**
 * An S3-compatible bucket as a file store (`ORBIT_DRIVE_BACKEND=s3`, docs/drive-design.md §2.10):
 * `files/<sha256[0:2]>/<sha256>`, addressed path-style (`<endpoint>/<bucket>/<key>`), which AWS S3, MinIO,
 * Ceph, R2 and the other S3-compatible services all answer.
 *
 * Four requests and a signature, on node:http and node:crypto, rather than an S3 SDK: the AWS SDK brings
 * dozens of packages for what is here HEAD, PUT, GET and DELETE of one object, and the smaller signing libraries
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
    const body = createReadStream(tempPath);
    try {
      // The payload's sha256 is the one signed, so the service checks the bytes it receives against it
      // and refuses a body that arrives changed.
      const response = await this.send('PUT', this.keyOf(sha256), { body, sizeBytes, sha256 });
      if (response.statusCode !== 200) throw await failure(response, 'PUT', this.keyOf(sha256));
      response.resume();
    } catch (error) {
      // A service that refuses need not read the rest of the body. Only then: one that keeps it has answered with the
      // body's last read still to come, and that read is what ends the request and frees the connection.
      body.destroy();
      throw error;
    } finally {
      await removeTempFile(tempPath);
    }
  }

  async open(sha256: string, range?: ByteRange): Promise<Readable | null> {
    if (range) assertRange(range);
    const response = await this.send('GET', this.keyOf(sha256), undefined, range ? { range: `bytes=${range.start}-${range.end}` } : {});
    if (response.statusCode === (range ? 206 : 200)) return response;
    if (response.statusCode === 404) {
      response.resume();
      return null;
    }
    if (range && response.statusCode === 416) {
      response.resume();
      throw new RangeError(`the range ${range.start}-${range.end} starts past the end of ${this.keyOf(sha256)}`);
    }
    throw await failure(response, 'GET', this.keyOf(sha256));
  }

  async remove(sha256: string): Promise<void> {
    const response = await this.send('DELETE', this.keyOf(sha256));
    // 204 whether or not the object was there, on AWS S3; a 404 from a service that says so is the same answer.
    if (response.statusCode !== 204 && response.statusCode !== 200 && response.statusCode !== 404) {
      throw await failure(response, 'DELETE', this.keyOf(sha256));
    }
    response.resume();
  }

  /** Every `files/<xx>/<sha256>` object in the bucket, a page of ListObjectsV2 at a time. */
  async *list(): AsyncIterable<StoredObject> {
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: 'files/', 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const response = await this.send('GET', '', undefined, {}, query);
      if (response.statusCode !== 200) throw await failure(response, 'GET', 'files/ (list)');
      let body = '';
      for await (const chunk of response) body += String(chunk);
      for (const item of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(item[1]!)?.[1] ?? '';
        const name = key.split('/')[2];
        if (!name || key !== this.keyOf(name) || !SHA256_NAME.test(name)) continue;
        yield {
          sha256: name,
          sizeBytes: Number(/<Size>(\d+)<\/Size>/.exec(item[1]!)?.[1] ?? 0),
          modifiedAt: new Date(/<LastModified>([^<]*)<\/LastModified>/.exec(item[1]!)?.[1] ?? 0),
        };
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(body) ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1] : undefined;
    } while (token);
  }

  /** One signed request; resolves with the response once its headers have arrived. */
  private send(
    method: 'HEAD' | 'GET' | 'PUT' | 'DELETE',
    key: string,
    upload?: { body: Readable; sizeBytes: number; sha256: string },
    extraHeaders: Record<string, string> = {},
    query: Record<string, string> = {},
  ): Promise<IncomingMessage> {
    const base = this.endpoint.pathname.replace(/\/+$/, '');
    const requestPath = `${base}/${[this.config.bucket, ...(key ? key.split('/') : [])].map(sigV4Encode).join('/')}`;
    const queryString = Object.entries(query)
      .map(([name, value]) => [sigV4Encode(name), sigV4Encode(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    const amzDate = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadSha256 = upload?.sha256 ?? EMPTY_PAYLOAD_SHA256;
    const headers: Record<string, string> = {
      host: this.endpoint.host,
      'x-amz-content-sha256': payloadSha256,
      'x-amz-date': amzDate,
      ...extraHeaders,
      ...(upload ? { 'content-length': String(upload.sizeBytes), 'content-type': 'application/octet-stream' } : {}),
    };
    const authorization = sigV4Authorization(
      { method, path: requestPath, query: queryString, headers, payloadSha256 },
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
          path: queryString ? `${requestPath}?${queryString}` : requestPath,
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
      // A body given up before its end leaves a request that can never finish, holding its connection.
      upload.body.once('close', () => {
        if (!upload.body.readableEnded) request.destroy();
      });
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
  /** The query string, already encoded and sorted by name; none when empty or absent. */
  query?: string;
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
 * The Authorization header of an AWS Signature Version 4 request signed at `amzDate`
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
    request.query ?? '',
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
