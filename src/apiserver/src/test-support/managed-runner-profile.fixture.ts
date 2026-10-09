import { createHash } from 'node:crypto';

import type { ManagedRunnerProfile } from '../managed-runners/managed-runner-profile';

/** The Kubernetes identity the fake cluster gives the manager's client, and the profile admits. */
export const TEST_MANAGER_USERNAME = 'system:serviceaccount:orbit-managed-test:orbit-runner-manager';
/** The bearer token a test plays the API server with when it calls the admission webhook. */
export const TEST_ADMISSION_WEBHOOK_TOKEN = 'test-admission-webhook-token';

/**
 * A complete, valid managed runner profile for tests. Every host is under `.invalid`, which never
 * resolves, and the kubeconfig path names nothing: a test that reached a real client would fail at
 * once rather than find a cluster.
 */
export function testManagedRunnerProfile(overrides: { lifecycle?: Partial<ManagedRunnerProfile['lifecycle']> } = {}): ManagedRunnerProfile {
  return {
    schemaVersion: 1,
    valueKind: 'actual',
    environmentId: 'orbit-mr-fake',
    clusterKey: 'fake-cluster',
    resourceProfileId: 'invited-test-v1',
    kubernetes: {
      kubeconfig: '/nonexistent/orbit-managed-runner-test/kubeconfig.json',
      context: 'orbit-fake',
      apiServer: 'https://kube.invalid:6443',
      namespace: 'orbit-managed-test',
    },
    storage: { className: 'runner-data', capacity: '20Gi' },
    runner: {
      image: `registry.invalid/orbit-managed-runner@sha256:${'a'.repeat(64)}`,
      serverUrl: 'https://orbit.invalid',
      maxConcurrent: 2,
      tmpSizeLimit: '2Gi',
      resources: {
        runner: { requests: { cpu: '1000m', memory: '2Gi' }, limits: { cpu: '2000m', memory: '4Gi' } },
        init: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
      },
    },
    admission: {
      managerUsername: TEST_MANAGER_USERNAME,
      webhookTokenSha256: createHash('sha256').update(TEST_ADMISSION_WEBHOOK_TOKEN).digest('hex'),
    },
    lifecycle: {
      maxAttempts: 3,
      backoffBaseSeconds: 5,
      backoffMaxSeconds: 60,
      startupDeadlineSeconds: 600,
      requestTimeoutSeconds: 10,
      leaseSeconds: 30,
      pollIntervalSeconds: 5,
      heartbeatFreshSeconds: 90,
      ...overrides.lifecycle,
    },
  };
}
