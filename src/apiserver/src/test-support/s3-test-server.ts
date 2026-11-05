import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import type { S3FilesConfig } from '../files/file-store';
import { sigV4Authorization } from '../files/s3-file-store';

/** The S3-compatible server the s3 store is held against: VersityGW 1.10.0 (Apache-2.0), on Docker Hub. */
const S3_IMAGE = 'versity/versitygw:v1.10.0';

async function s3Request(config: S3FilesConfig, method: 'PUT', requestPath: string): Promise<number> {
  const endpoint = new globalThis.URL(config.endpoint);
  const empty = createHash('sha256').digest('hex');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers = { host: endpoint.host, 'x-amz-content-sha256': empty, 'x-amz-date': amzDate };
  const authorization = sigV4Authorization(
    { method, path: requestPath, headers, payloadSha256: empty },
    { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, service: 's3' },
    amzDate,
  );
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: endpoint.hostname, port: endpoint.port, method, path: requestPath, headers: { ...headers, authorization },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

/** VersityGW on Docker, on a port of its own, with a bucket of its own; removed when the test ends. */
export async function startS3(after: (fn: () => void) => void): Promise<S3FilesConfig> {
  const run = randomUUID().slice(0, 8);
  const name = `orbit-files-s3-${run}`;
  const accessKeyId = `orbitfiles${run}`;
  const secretAccessKey = randomBytes(24).toString('hex');
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::7070', '--tmpfs', '/data',
    S3_IMAGE, '--access', accessKeyId, '--secret', secretAccessKey, 'posix', '/data',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  after(() => {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  });
  const port = execFileSync('docker', ['port', name, '7070/tcp'], { encoding: 'utf8' }).split('\n')[0].split(':').pop();
  const config: S3FilesConfig = {
    endpoint: `http://127.0.0.1:${port}`, bucket: `orbit-files-${run}`, accessKeyId, secretAccessKey, region: 'us-east-1',
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    // The bucket is the readiness probe: a refused connection or an error before the gateway serves is retried.
    const status = await s3Request(config, 'PUT', `/${config.bucket}`).catch(() => 0);
    if (status === 200) return config;
    if (Date.now() > deadline) assert.fail(`${S3_IMAGE} did not create the bucket within 60 s (last answer ${status})`);
    await sleep(250);
  }
}
