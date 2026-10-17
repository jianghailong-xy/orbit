import type { DockerRunnerProfile } from '../managed-runners/managed-runner-profile';
import { testManagedRunnerProfile } from './managed-runner-profile.fixture';

/**
 * A complete, valid Docker backend profile for tests. The channel's socket and token file name
 * nothing, so a test that reached the real channel client would fail at once; the lifecycle is the
 * Kubernetes fixture's.
 */
export function testDockerRunnerProfile(overrides: {
  lifecycle?: Partial<DockerRunnerProfile['lifecycle']>;
  capacity?: DockerRunnerProfile['capacity'];
  /** Another cluster key is another capacity pool. */
  clusterKey?: string;
  instanceId?: string;
} = {}): DockerRunnerProfile {
  return {
    schemaVersion: 1,
    valueKind: 'actual',
    backend: 'docker',
    environmentId: 'orbit-mr-docker-fake',
    clusterKey: overrides.clusterKey ?? 'docker-fake',
    resourceProfileId: 'docker-test-v1',
    docker: {
      instanceId: overrides.instanceId ?? 'orbit-docker-fake',
      channel: { socketPath: '/nonexistent/orbit-docker-channel/channel.sock' },
      tokenFile: '/nonexistent/orbit-docker-channel/token',
    },
    storage: { capacity: '10Gi' },
    runner: {
      image: `sha256:${'d'.repeat(64)}`,
      serverUrl: 'http://172.30.0.1:3000',
      maxConcurrent: 2,
      tmpSizeLimit: '512Mi',
      resources: { cpu: '1', memory: '2Gi', pids: 1024 },
    },
    ...(overrides.capacity ? { capacity: overrides.capacity } : {}),
    lifecycle: { ...testManagedRunnerProfile().lifecycle, ...overrides.lifecycle },
  };
}
