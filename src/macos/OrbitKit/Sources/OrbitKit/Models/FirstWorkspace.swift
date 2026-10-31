import Foundation

// The wire shapes of a machine's first workspace (docs/first-workspace-contract.md, shared `DirProbe`,
// `DirProbeAnswer`, `NewWorkspaceRequest`).

/// What a runner found at a path (§2.4). `error` is a look that failed, which is not the same as
/// `exists: false`: that is an answer.
public struct DirProbe: Codable, Equatable, Sendable {
    /// What the runner looked at: `~` expanded, absolute.
    public let path: String
    public let exists: Bool
    public let isDir: Bool
    /// Inside a git work tree.
    public let isGit: Bool
    /// The checked-out branch; nil outside a repository and on a detached HEAD.
    public let branch: String?
    /// It is the runner user's home directory.
    public let isHome: Bool
    public let freeBytes: Int64?
    public let error: String?

    private enum CodingKeys: String, CodingKey {
        case path, exists, isDir, isGit, branch, isHome, freeBytes, error
    }

    public init(path: String, exists: Bool, isDir: Bool, isGit: Bool = false, branch: String? = nil,
                isHome: Bool = false, freeBytes: Int64? = nil, error: String? = nil) {
        self.path = path
        self.exists = exists
        self.isDir = isDir
        self.isGit = isGit
        self.branch = branch
        self.isHome = isHome
        self.freeBytes = freeBytes
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        exists = try c.decode(Bool.self, forKey: .exists)
        isDir = try c.decode(Bool.self, forKey: .isDir)
        isGit = try c.decode(Bool.self, forKey: .isGit)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        isHome = try c.decode(Bool.self, forKey: .isHome)
        freeBytes = c.flexibleInt64(forKey: .freeBytes)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// POST /runners/:id/dir-probe.
struct DirProbeQuestion: Encodable {
    let path: String
}

/// GET /runners/:id/dir-probe?path= (§2.2). `status` stays raw so a newer control plane can't make the
/// answer unreadable: anything but `pending` or `done` reads as nothing to wait for.
public struct DirProbeAnswer: Codable, Equatable, Sendable {
    public let path: String
    public let status: String
    public let result: DirProbe?

    public init(path: String, status: String, result: DirProbe? = nil) {
        self.path = path
        self.status = status
        self.result = result
    }
}

/// `POST /sessions`' folder for the workspace a machine's first session makes (§3): exactly one of the
/// two. `workDir` is a folder the runner has confirmed, as it resolved it; `newFolder` is one path
/// segment the server joins to the runner's Repos Folder.
public struct NewWorkspaceRequest: Codable, Equatable, Sendable {
    public let workDir: String?
    public let newFolder: String?

    public init(workDir: String? = nil, newFolder: String? = nil) {
        self.workDir = workDir
        self.newFolder = newFolder
    }
}
