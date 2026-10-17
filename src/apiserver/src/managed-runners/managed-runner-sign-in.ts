/**
 * What a sign-in asks of managed runners (docs/managed-runner-design.md, "Default disabled gate" and
 * "Provisioning retry wake and sleep" 1). AuthService.completeLogin — the one exit the password, the
 * first-user bootstrap and a Google ticket all leave by (docs/google-sign-in-design.md §9.2) — calls
 * it after the tokens are issued, and nothing else calls it: a refresh, a sign-out, a password change
 * and a capability read are not sign-ins. ManagedRunnerService provides it; a module graph without
 * ManagedRunnerModule has nothing here, which is the feature off.
 */
export interface ManagedRunnerSignIn {
  /** Records the owner's provisioning intent when the switch is on. Never throws, never waits for the
   *  runner's instance and never calls Kubernetes. */
  signedIn(user: { id: string }): Promise<void>;
}

/** The DI token AuthService injects it by. */
export const MANAGED_RUNNER_SIGN_IN = Symbol('MANAGED_RUNNER_SIGN_IN');
