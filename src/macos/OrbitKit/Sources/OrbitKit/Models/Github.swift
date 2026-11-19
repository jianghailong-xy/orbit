import Foundation

// The wire shapes of GitHub-backed workspaces (docs/github-workspace-design.md §5.2; shared `github.ts`): what the
// account's GitHub routes answer. Every field a newer server may leave out decodes as absent rather than failing.

/// One installation of Orbit's GitHub App the person can reach.
public struct GithubInstallation: Codable, Equatable, Sendable, Identifiable {
    public let id: Int64
    /// The GitHub account the App is installed on.
    public let account: String
    /// `User` | `Organization`.
    public let type: String
    /// `all` | `selected`.
    public let repositorySelection: String
    public let repositoryCount: Int

    public init(id: Int64, account: String, type: String, repositorySelection: String, repositoryCount: Int) {
        self.id = id
        self.account = account
        self.type = type
        self.repositorySelection = repositorySelection
        self.repositoryCount = repositoryCount
    }
}

/// One of `GithubIntegration.workspaces`: a workspace cloned from GitHub and the credential its clone used.
public struct GithubWorkspace: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// The machine it is on, by the name the person sees.
    public let machine: String?
    /// `owner/name`.
    public let repository: String?
    public let cloneState: String?
    /// `machine` (the machine's own Git credential) or `github-app` (Orbit's GitHub App); nil until reported.
    public let credential: String?

    public init(id: String, name: String, machine: String? = nil, repository: String? = nil,
                cloneState: String? = nil, credential: String? = nil) {
        self.id = id
        self.name = name
        self.machine = machine
        self.repository = repository
        self.cloneState = cloneState
        self.credential = credential
    }
}

/// `GET /integrations/github` (and the answer of `DELETE`).
public struct GithubIntegration: Codable, Equatable, Sendable {
    /// An administrator set up the App and it is on.
    public let available: Bool
    public let connected: Bool
    public let login: String?
    public let connectedAt: String?
    /// GitHub no longer takes the connection's tokens: Reconnect.
    public let needsReconnect: Bool
    /// Nil when GitHub could not be asked.
    public let installations: [GithubInstallation]?
    public let installUrl: String?
    /// The account's workspaces cloned from GitHub.
    public let workspaceCount: Int
    /// Those workspaces, newest first. Absent from a server that predates it.
    public let workspaces: [GithubWorkspace]?

    public init(available: Bool, connected: Bool, login: String? = nil, connectedAt: String? = nil,
                needsReconnect: Bool = false, installations: [GithubInstallation]? = [], installUrl: String? = nil,
                workspaceCount: Int = 0, workspaces: [GithubWorkspace]? = nil) {
        self.available = available
        self.connected = connected
        self.login = login
        self.connectedAt = connectedAt
        self.needsReconnect = needsReconnect
        self.installations = installations
        self.installUrl = installUrl
        self.workspaceCount = workspaceCount
        self.workspaces = workspaces
    }

    private enum CodingKeys: String, CodingKey {
        case available, connected, login, connectedAt, needsReconnect, installations, installUrl, workspaceCount, workspaces
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        connected = try c.decodeIfPresent(Bool.self, forKey: .connected) ?? false
        login = try c.decodeIfPresent(String.self, forKey: .login)
        connectedAt = try c.decodeIfPresent(String.self, forKey: .connectedAt)
        needsReconnect = try c.decodeIfPresent(Bool.self, forKey: .needsReconnect) ?? false
        installations = try c.decodeIfPresent([GithubInstallation].self, forKey: .installations)
        installUrl = try c.decodeIfPresent(String.self, forKey: .installUrl)
        workspaceCount = try c.decodeIfPresent(Int.self, forKey: .workspaceCount) ?? 0
        workspaces = try c.decodeIfPresent([GithubWorkspace].self, forKey: .workspaces)
    }

    /// Connected, and GitHub still takes the connection: the repositories can be listed.
    public var usable: Bool { connected && !needsReconnect }

    /// How many repositories the App reaches for this person, over every installation; nil when GitHub wasn't asked.
    public var repositoryCount: Int? {
        installations.map { $0.reduce(0) { $0 + $1.repositoryCount } }
    }
}

/// One of `GET /integrations/github/repos`.
public struct GithubRepository: Codable, Equatable, Sendable, Identifiable {
    public let id: Int64
    public let fullName: String
    public let `private`: Bool
    public let defaultBranch: String
    public let installationId: Int64
    public let pushedAt: String?

    public init(id: Int64, fullName: String, private isPrivate: Bool, defaultBranch: String, installationId: Int64,
                pushedAt: String? = nil) {
        self.id = id
        self.fullName = fullName
        self.private = isPrivate
        self.defaultBranch = defaultBranch
        self.installationId = installationId
        self.pushedAt = pushedAt
    }

    /// `orbit-labs/` — dimmed in the picker, before the name.
    public var owner: String {
        guard let slash = fullName.firstIndex(of: "/") else { return "" }
        return String(fullName[...slash])
    }

    /// `orbit-web`.
    public var name: String {
        guard let slash = fullName.firstIndex(of: "/") else { return fullName }
        return String(fullName[fullName.index(after: slash)...])
    }
}

public struct GithubRepositoryPage: Codable, Equatable, Sendable {
    public let repositories: [GithubRepository]
    public let nextCursor: String?

    public init(repositories: [GithubRepository], nextCursor: String? = nil) {
        self.repositories = repositories
        self.nextCursor = nextCursor
    }
}

/// `GET /integrations/github/repos/:id/branches`.
public struct GithubBranches: Codable, Equatable, Sendable {
    public let defaultBranch: String
    public let branches: [String]

    public init(defaultBranch: String, branches: [String]) {
        self.defaultBranch = defaultBranch
        self.branches = branches
    }
}

/// `GET /integrations/github/start`: where the person signs in to GitHub.
public struct GithubStart: Codable, Equatable, Sendable {
    public let authorizationUrl: String
}

/// `POST /workspaces/:id/clone/retry`.
public struct CloneRetryAnswer: Codable, Equatable, Sendable {
    public let id: String
    public let cloneState: String
}

/// The GitHub sign-in's round trip from these apps: the callback comes back to the web's Settings → GitHub (which says
/// whether it worked), and the app reads the connection again as it comes back to the front.
public enum GithubFlow {
    public static let returnPath = "/settings/integrations/github"
}
