import Foundation

/// A landing's pull request, as the landing view, a task's landing row, a project's in-flight job and a
/// session's merge row carry it — `@orbit/shared`'s `LandingPullRequestView`
/// (docs/design/protected-branch-landing.md §8). `number` and `url` are nil only while the row is `OPENING`.
public struct LandingPullRequestView: Codable, Equatable, Sendable {
    public struct Failed: Codable, Equatable, Sendable {
        public let name: String
        public let url: String?
        public init(name: String, url: String? = nil) {
            self.name = name
            self.url = url
        }
    }

    /// The required checks on the head: how many passed, how many there are, and the ones that failed.
    public struct Checks: Codable, Equatable, Sendable {
        public let passed: Int
        public let required: Int
        public let failed: [Failed]
        public init(passed: Int = 0, required: Int = 0, failed: [Failed] = []) {
            self.passed = passed
            self.required = required
            self.failed = failed
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            passed = try c.decodeIfPresent(Int.self, forKey: .passed) ?? 0
            required = try c.decodeIfPresent(Int.self, forKey: .required) ?? 0
            failed = try c.decodeIfPresent([Failed].self, forKey: .failed) ?? []
        }
    }

    /// The direct push GitHub refused before this pull request, in GitHub's words.
    public struct Refusal: Codable, Equatable, Sendable {
        /// `PULL_REQUEST` or `PUSH_AS_ME`.
        public let via: String
        public let message: String
        public init(via: String, message: String) {
            self.via = via
            self.message = message
        }
    }

    public let number: Int?
    public let url: String?
    /// `OPENING`, `OPEN`, `MERGED` or `CLOSED`.
    public let state: String
    /// `CHECKS_PENDING`, `CHECK_FAILED`, `REVIEW_REQUIRED`, `CHANGES_REQUESTED`, `BEHIND`, `CONFLICTING`,
    /// `MERGEABLE`, `MERGE_QUEUE` or `UNKNOWN`; nil once the pull request has ended.
    public let condition: String?
    public let checks: Checks
    public let mergeMethod: String?
    /// The commit GitHub's merge put on the target.
    public let mergedSha: String?
    public let refusal: Refusal?
    /// The workspace the pull request was opened for: clients read its landing setting and link to it.
    /// Absent from an older server.
    public let workspaceId: String?

    public init(number: Int? = nil, url: String? = nil, state: String = "OPEN", condition: String? = nil,
                checks: Checks = Checks(), mergeMethod: String? = nil, mergedSha: String? = nil,
                refusal: Refusal? = nil, workspaceId: String? = nil) {
        self.number = number
        self.url = url
        self.state = state
        self.condition = condition
        self.checks = checks
        self.mergeMethod = mergeMethod
        self.mergedSha = mergedSha
        self.refusal = refusal
        self.workspaceId = workspaceId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try? c.decodeIfPresent(Int.self, forKey: .number)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "OPEN"
        condition = try? c.decodeIfPresent(String.self, forKey: .condition)
        checks = (try? c.decodeIfPresent(Checks.self, forKey: .checks)) ?? Checks()
        mergeMethod = try? c.decodeIfPresent(String.self, forKey: .mergeMethod)
        mergedSha = try? c.decodeIfPresent(String.self, forKey: .mergedSha)
        refusal = try? c.decodeIfPresent(Refusal.self, forKey: .refusal)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
    }
}

/// A workspace's `landing` block (§8), on `GET /workspaces/:id`. `mode` is nil for a workspace not cloned from
/// GitHub, which has no choice: its landings push with the machine's Git credential.
public struct WorkspaceLandingView: Codable, Equatable, Sendable {
    public struct PushAsMe: Codable, Equatable, Sendable {
        public let available: Bool
        /// `WORKSPACE_NOT_FROM_GITHUB` or `GITHUB_NOT_CONNECTED`.
        public let reason: String?
        public init(available: Bool, reason: String? = nil) {
            self.available = available
            self.reason = reason
        }
    }

    public struct Refusal: Codable, Equatable, Sendable {
        public let at: String
        /// The target branch, without `refs/heads/`.
        public let branch: String
        public let message: String
        public init(at: String, branch: String, message: String) {
            self.at = at
            self.branch = branch
            self.message = message
        }
    }

    /// The installation has not accepted the permissions landing through a pull request needs: the account
    /// that must accept, and the GitHub page where it does.
    public struct PermissionsPending: Codable, Equatable, Sendable {
        public let account: String
        public let reviewUrl: String
        public init(account: String, reviewUrl: String) {
            self.account = account
            self.reviewUrl = reviewUrl
        }
    }

    /// `PULL_REQUEST` or `PUSH_AS_ME`; nil for a workspace not from GitHub.
    public let mode: String?
    public let pushAsMe: PushAsMe
    public let lastRefusal: Refusal?
    public let permissionsPending: PermissionsPending?

    public init(mode: String?, pushAsMe: PushAsMe, lastRefusal: Refusal? = nil,
                permissionsPending: PermissionsPending? = nil) {
        self.mode = mode
        self.pushAsMe = pushAsMe
        self.lastRefusal = lastRefusal
        self.permissionsPending = permissionsPending
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = try? c.decodeIfPresent(String.self, forKey: .mode)
        pushAsMe = (try? c.decodeIfPresent(PushAsMe.self, forKey: .pushAsMe)) ?? PushAsMe(available: false)
        lastRefusal = try? c.decodeIfPresent(Refusal.self, forKey: .lastRefusal)
        permissionsPending = try? c.decodeIfPresent(PermissionsPending.self, forKey: .permissionsPending)
    }
}
