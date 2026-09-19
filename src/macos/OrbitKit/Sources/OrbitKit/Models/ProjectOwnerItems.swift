import Foundation

/// The two owner cards a project draws in its coordinator's conversation: the merge waiting to be
/// confirmed (`GET /projects/:id/promotions/current`, contract §3.6) and the question the
/// coordinator put to its owner (`GET /projects/:id/open-items`, §4.8 / §5.2).
///
/// Mirrors `@orbit/shared`'s `project-progress.ts`, the one declaration both clients read (§7.0),
/// and decodes only the fields these cards draw — every unknown key is ignored, so a server that
/// adds one does not stop a card from rendering.

/// What opened an exception item (§4.2). A kind this build does not know decodes as ``unknown``
/// rather than failing the read that carried it.
public enum ProjectOpenItemKind: String, Codable, Sendable {
    case integrationConflict = "INTEGRATION_CONFLICT"
    case integrationCheckFailed = "INTEGRATION_CHECK_FAILED"
    case integrationError = "INTEGRATION_ERROR"
    case taskFailed = "TASK_FAILED"
    case promotionApproval = "PROMOTION_APPROVAL"
    case coordinatorQuestion = "COORDINATOR_QUESTION"
    case fusePaused = "FUSE_PAUSED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectOpenItemKind(rawValue: raw) ?? .unknown
    }
}

/// What a coordinator asked its owner to decide (§5.2 R7).
public struct CoordinatorQuestion: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Sendable {
        public let label: String
        /// Why this one, in the asker's words. Absent when it asked with labels alone.
        public let description: String?
        public init(label: String, description: String? = nil) {
            self.label = label
            self.description = description
        }
    }

    public let question: String
    /// Empty when the coordinator asked for prose rather than a choice.
    public let options: [Option]
    /// Index into ``options``; nil when it recommended nothing.
    public let recommendedOption: Int?
    public let blocksTaskIds: [String]
    /// What happens if nobody answers, in the asker's own words.
    public let ifUnanswered: String?

    public init(question: String, options: [Option] = [], recommendedOption: Int? = nil,
                blocksTaskIds: [String] = [], ifUnanswered: String? = nil) {
        self.question = question
        self.options = options
        self.recommendedOption = recommendedOption
        self.blocksTaskIds = blocksTaskIds
        self.ifUnanswered = ifUnanswered
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        options = try c.decodeIfPresent([Option].self, forKey: .options) ?? []
        recommendedOption = try c.decodeIfPresent(Int.self, forKey: .recommendedOption)
        blocksTaskIds = try c.decodeIfPresent([String].self, forKey: .blocksTaskIds) ?? []
        ifUnanswered = try c.decodeIfPresent(String.self, forKey: .ifUnanswered)
    }
}

/// One exception item as `GET /projects/:id/open-items` serves it (§4.8).
public struct ProjectOpenItemRow: Codable, Equatable, Sendable, Identifiable {
    public let itemId: String
    public let kind: ProjectOpenItemKind
    public let title: String
    /// The server's own sentence about the fact that opened it. Drawn rather than re-derived: a
    /// card that composed its own would be free to disagree with the row beside it on the web.
    public let detailLine: String
    public let waitingSince: String
    /// What was asked, for a `COORDINATOR_QUESTION`; nil for every other kind.
    public let question: CoordinatorQuestion?

    public var id: String { itemId }

    public init(itemId: String, kind: ProjectOpenItemKind, title: String, detailLine: String = "",
                waitingSince: String, question: CoordinatorQuestion? = nil) {
        self.itemId = itemId
        self.kind = kind
        self.title = title
        self.detailLine = detailLine
        self.waitingSince = waitingSince
        self.question = question
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        kind = try c.decodeIfPresent(ProjectOpenItemKind.self, forKey: .kind) ?? .unknown
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        detailLine = try c.decodeIfPresent(String.self, forKey: .detailLine) ?? ""
        waitingSince = try c.decodeIfPresent(String.self, forKey: .waitingSince) ?? ""
        question = try c.decodeIfPresent(CoordinatorQuestion.self, forKey: .question)
    }
}

/// The project's open exceptions, split by who is expected to act (§4.8).
public struct ProjectOpenItemsView: Codable, Equatable, Sendable {
    public let needsYou: [ProjectOpenItemRow]
    public let withCoordinator: [ProjectOpenItemRow]

    public init(needsYou: [ProjectOpenItemRow] = [], withCoordinator: [ProjectOpenItemRow] = []) {
        self.needsYou = needsYou
        self.withCoordinator = withCoordinator
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        needsYou = try c.decodeIfPresent([ProjectOpenItemRow].self, forKey: .needsYou) ?? []
        withCoordinator = try c.decodeIfPresent([ProjectOpenItemRow].self, forKey: .withCoordinator) ?? []
    }
}

/// `POST /projects/:id/open-items/:itemId/answer` — the item is closed, and where the answer went
/// (§5.2 R10). `delivery` is nil when no conversation coordinates the project: the answer waits for
/// the next one.
public struct OwnerAnswerReceipt: Codable, Equatable, Sendable {
    public struct Delivery: Codable, Equatable, Sendable {
        public let sessionId: String
        public let turnId: String
    }
    public let itemId: String
    public let delivery: Delivery?

    public init(itemId: String, delivery: Delivery? = nil) {
        self.itemId = itemId
        self.delivery = delivery
    }
}

/// The owner's answer, as the door takes it: an option, free text, or both.
public struct OwnerAnswerRequest: Codable, Sendable {
    public let option: Int?
    public let text: String?
    public init(option: Int? = nil, text: String? = nil) {
        self.option = option
        self.text = text
    }
}

/// Where a merge candidate is (§3.3). Terminal states are `MERGED`, `DECLINED`, `CANCELLED`,
/// `SUPERSEDED`; the card draws the live ones.
public enum PromotionState: String, Codable, Sendable {
    case checking = "CHECKING"
    case ready = "READY"
    case confirmed = "CONFIRMED"
    case rechecking = "RECHECKING"
    case merged = "MERGED"
    case blocked = "BLOCKED"
    case declined = "DECLINED"
    case cancelled = "CANCELLED"
    case superseded = "SUPERSEDED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PromotionState(rawValue: raw) ?? .unknown
    }
}

/// One check the combined tree was held to (§2.3).
public struct IntegrationCheckResult: Codable, Equatable, Sendable {
    public let name: String
    public let command: String
    public let expectedExitCode: Int?
    public let exitCode: Int?
    public let timedOut: Bool?
    public let durationMs: Int?

    public init(name: String, command: String, expectedExitCode: Int? = 0, exitCode: Int? = 0,
                timedOut: Bool? = false, durationMs: Int? = nil) {
        self.name = name
        self.command = command
        self.expectedExitCode = expectedExitCode
        self.exitCode = exitCode
        self.timedOut = timedOut
        self.durationMs = durationMs
    }

    /// Whether this one passed: the exit code the check declared, and not a timeout.
    public var passed: Bool {
        timedOut != true && exitCode != nil && exitCode == (expectedExitCode ?? 0)
    }
}

/// What the confirmation card is drawn from (§3.6).
public struct ProjectPromotionView: Codable, Equatable, Sendable {
    public let promotionId: String
    public let state: PromotionState
    public let sourceRef: String
    public let sourceSha: String
    public let upstreamRef: String
    public let commitsAhead: Int?
    public let filesChanged: Int?
    public let taskIds: [String]
    public let checks: [IntegrationCheckResult]
    public let conflicts: [String]
    /// `MERGE_COMMIT` for a project branch, `FAST_FORWARD` for a single task's branch (M6).
    public let landsAs: String?
    public let askedAt: String?
    public let recheckedAt: String?
    public let merged: Merged?

    public struct Merged: Codable, Equatable, Sendable {
        public let sha: String
        public let at: String
    }

    public init(promotionId: String, state: PromotionState, sourceRef: String, sourceSha: String,
                upstreamRef: String, commitsAhead: Int? = nil, filesChanged: Int? = nil,
                taskIds: [String] = [], checks: [IntegrationCheckResult] = [],
                conflicts: [String] = [], landsAs: String? = "MERGE_COMMIT",
                askedAt: String? = nil, recheckedAt: String? = nil, merged: Merged? = nil) {
        self.promotionId = promotionId
        self.state = state
        self.sourceRef = sourceRef
        self.sourceSha = sourceSha
        self.upstreamRef = upstreamRef
        self.commitsAhead = commitsAhead
        self.filesChanged = filesChanged
        self.taskIds = taskIds
        self.checks = checks
        self.conflicts = conflicts
        self.landsAs = landsAs
        self.askedAt = askedAt
        self.recheckedAt = recheckedAt
        self.merged = merged
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        promotionId = try c.decode(String.self, forKey: .promotionId)
        state = try c.decodeIfPresent(PromotionState.self, forKey: .state) ?? .unknown
        sourceRef = try c.decodeIfPresent(String.self, forKey: .sourceRef) ?? ""
        sourceSha = try c.decodeIfPresent(String.self, forKey: .sourceSha) ?? ""
        upstreamRef = try c.decodeIfPresent(String.self, forKey: .upstreamRef) ?? ""
        commitsAhead = try c.decodeIfPresent(Int.self, forKey: .commitsAhead)
        filesChanged = try c.decodeIfPresent(Int.self, forKey: .filesChanged)
        taskIds = try c.decodeIfPresent([String].self, forKey: .taskIds) ?? []
        checks = try c.decodeIfPresent([IntegrationCheckResult].self, forKey: .checks) ?? []
        conflicts = try c.decodeIfPresent([String].self, forKey: .conflicts) ?? []
        landsAs = try c.decodeIfPresent(String.self, forKey: .landsAs)
        askedAt = try c.decodeIfPresent(String.self, forKey: .askedAt)
        recheckedAt = try c.decodeIfPresent(String.self, forKey: .recheckedAt)
        merged = try c.decodeIfPresent(Merged.self, forKey: .merged)
    }
}

/// `POST /projects/:id/promotions/:promotionId/confirm` — the candidate the card was drawn from,
/// so a merge confirmed after a new candidate superseded it is refused rather than merging
/// whatever is on the branch now (M-T4).
public struct ConfirmPromotionRequest: Codable, Sendable {
    public let sourceSha: String?
    public init(sourceSha: String?) { self.sourceSha = sourceSha }
}
