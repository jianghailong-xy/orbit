/**
 * GitHub-backed workspaces (docs/github-workspace-design.md §5.1, §5.2): what the admin and user routes answer.
 */

/** `GET` and `PUT /admin/integrations/github`. Says whether a secret is saved, never what it is. */
export interface GithubAppSettings {
  enabled: boolean;
  /** A decimal string; null before the first save. */
  appId: string | null;
  /** What GitHub's GET /app answered at the last save. */
  slug: string | null;
  clientId: string;
  secretSaved: boolean;
  keySaved: boolean;
  /** The client secret or the private key no longer decrypts with this server's PROVIDER_SECRET_KEY. */
  secretUnreadable: boolean;
  callbackUrl: string;
  connectedUsers: number;
  clonedWorkspaces: number;
  /** What to enter as the App's webhook URL on GitHub (docs/design/protected-branch-landing.md §8). Absent from a server
   *  that predates it. */
  webhookUrl?: string;
  /** A webhook secret is saved; it is never read back. */
  webhookSecretSaved?: boolean;
  /** When GitHub's last delivery arrived. */
  lastDeliveryAt?: string | null;
}

/** `PUT /admin/integrations/github`. A secret or key left out keeps the saved one. */
export interface GithubAppChange {
  enabled: boolean;
  appId: string;
  clientId: string;
  clientSecret?: string;
  privateKey?: string;
  /** The webhook secret; left out, the saved one stays. */
  webhookSecret?: string;
}

export interface GithubInstallation {
  id: number;
  /** The GitHub account the App is installed on. */
  account: string;
  /** `User` | `Organization`. */
  type: string;
  /** `all` | `selected`. */
  repositorySelection: string;
  repositoryCount: number;
}

/** `GET /integrations/github`. */
export interface GithubIntegration {
  /** An administrator set up the App and it is on. */
  available: boolean;
  connected: boolean;
  login: string | null;
  connectedAt: string | null;
  /** GitHub no longer takes the connection's tokens: Reconnect. */
  needsReconnect: boolean;
  /** Null when GitHub could not be asked. */
  installations: GithubInstallation[] | null;
  installUrl: string | null;
  /** The account's workspaces cloned from GitHub. */
  workspaceCount: number;
  /** Those workspaces, newest first (board 02, "Workspaces from GitHub"). Absent from a server that predates it. */
  workspaces?: GithubWorkspace[];
}

/** One of `GithubIntegration.workspaces`: a workspace cloned from GitHub and the credential its clone used. */
export interface GithubWorkspace {
  id: string;
  name: string;
  /** The machine it is on, by the name the person sees. */
  machine: string | null;
  /** `owner/name`. */
  repository: string | null;
  cloneState: string | null;
  /** `machine` (the machine's own Git credential) or `github-app` (Orbit's GitHub App); null until reported. */
  credential: 'machine' | 'github-app' | null;
}

/** One of `GET /integrations/github/repos`. */
export interface GithubRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  pushedAt: string | null;
}

export interface GithubRepositoryPage {
  repositories: GithubRepository[];
  nextCursor: string | null;
}

/** `GET /integrations/github/repos/:id/branches`. */
export interface GithubBranches {
  defaultBranch: string;
  branches: string[];
}
