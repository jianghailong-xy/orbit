import Foundation

/// The owner cards a project draws in its coordinator's conversation: the merge waiting to be
/// confirmed (`GET /projects/:id/promotions/current`, contract §3.6), the question the coordinator
/// put to its owner, and the exceptions that became the owner's without anybody asking
/// (`GET /projects/:id/open-items`, §4.8 / §5.2 / §7.5).
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

/// Who the item is expected to act (§4.3).
public enum ProjectOpenItemAssignee: String, Codable, Sendable {
    case coordinator = "COORDINATOR"
    case owner = "OWNER"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectOpenItemAssignee(rawValue: raw) ?? .unknown
    }
}

/// WHY it has that assignee — the difference between the ordinary route and every way an item ends
/// up with a person (§7.1 V1). `default` is the ordinary one, and an item carrying it was the
/// person's from the start rather than having become theirs.
public enum ProjectOpenItemAssigneeReason: String, Codable, Sendable {
    case defaultReason = "DEFAULT"
    case noCoordinator = "NO_COORDINATOR"
    case coordinatorEnded = "COORDINATOR_ENDED"
    case chainLimit = "CHAIN_LIMIT"
    case escalated = "ESCALATED"
    case handedOver = "HANDED_OVER"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectOpenItemAssigneeReason(rawValue: raw) ?? .unknown
    }

    /// The five ways an item BECAME somebody's (`OPEN_ITEM_ESCALATION_REASONS` on the server), which
    /// is exactly the set `ownerItemKind` folds into `ESCALATED` — so an item the needs-you banner
    /// named as an escalation is one this card has a heading for.
    public var isEscalation: Bool {
        switch self {
        case .noCoordinator, .coordinatorEnded, .chainLimit, .escalated, .handedOver: return true
        case .defaultReason, .unknown: return false
        }
    }
}

/// One press an item offers. The server lists only doors that exist today, and the client draws
/// only the ones it knows — an action it cannot name is not a button (`ExceptionCards`).
public enum ProjectOpenItemAction: String, Codable, Sendable {
    case review = "REVIEW"
    case openCoordinator = "OPEN_COORDINATOR"
    case openTaskSession = "OPEN_TASK_SESSION"
    case retry = "RETRY"
    case cancelTask = "CANCEL_TASK"
    case askCoordinatorAgain = "ASK_COORDINATOR_AGAIN"
    case resume = "RESUME"
    case answer = "ANSWER"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectOpenItemAction(rawValue: raw) ?? .unknown
    }
}

/// One exception item as `GET /projects/:id/open-items` serves it (§4.8).
public struct ProjectOpenItemRow: Codable, Equatable, Sendable, Identifiable {
    /// Where this item is on its way to the coordinator (§4.4), which is the address `Open
    /// coordinator` reaches. Read for the same reason as every other field here: a press is drawn
    /// only where this row carries what it would need.
    public struct Delivery: Codable, Equatable, Sendable {
        public let state: String
        public let sessionId: String?
        public let at: String?

        public init(state: String, sessionId: String? = nil, at: String? = nil) {
            self.state = state
            self.sessionId = sessionId
            self.at = at
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
            sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
            at = try c.decodeIfPresent(String.self, forKey: .at)
        }
    }

    public let itemId: String
    public let kind: ProjectOpenItemKind
    public let title: String
    /// The server's own sentence about the fact that opened it. Drawn rather than re-derived: a
    /// card that composed its own would be free to disagree with the row beside it on the web.
    public let detailLine: String
    public let waitingSince: String
    public let assignee: ProjectOpenItemAssignee
    /// Read by the card's heading, which is the owner's one sentence about how the item got here.
    public let assigneeReason: ProjectOpenItemAssigneeReason
    /// When it stops being the coordinator's, frozen at creation; null once it is the owner's.
    public let escalateAt: String?
    /// When the clock handed it to the owner. Part of the escalated card's heading, which says how
    /// long the coordinator had it before that.
    public let escalatedAt: String?
    /// The task the item is about; nil for the kinds that are about something else.
    public let taskId: String?
    /// The attempt this item is about, when one is recorded: the run whose failure opened it.
    public let sessionId: String?
    /// The merge candidate this item is about, for a `PROMOTION_APPROVAL`; the address `Review`
    /// reaches. Nil for every other kind.
    public let promotionId: String?
    /// The pause this item is, for a `FUSE_PAUSED`; nil for every other kind.
    public let fuseEpisodeId: String?
    /// Where this item is on its way to the coordinator, or that it is not owed to one.
    public let delivery: Delivery?
    /// The presses the server offers on this item.
    public let actions: [ProjectOpenItemAction]
    /// What was asked, for a `COORDINATOR_QUESTION`; nil for every other kind.
    public let question: CoordinatorQuestion?
    /// What the item's payload holds, as the rows its card draws (§7.5); nil when the payload is
    /// not a shape this build reads — an item an older build opened, a pause, a question — which
    /// leaves the card drawing the server's own sentence, as it did before the rows existed.
    public let facts: OpenItemFacts?

    public var id: String { itemId }

    public init(itemId: String, kind: ProjectOpenItemKind, title: String, detailLine: String = "",
                waitingSince: String, assignee: ProjectOpenItemAssignee = .owner,
                assigneeReason: ProjectOpenItemAssigneeReason = .defaultReason,
                escalateAt: String? = nil, escalatedAt: String? = nil, taskId: String? = nil,
                sessionId: String? = nil, promotionId: String? = nil,
                fuseEpisodeId: String? = nil, delivery: Delivery? = nil,
                actions: [ProjectOpenItemAction] = [], question: CoordinatorQuestion? = nil,
                facts: OpenItemFacts? = nil) {
        self.itemId = itemId
        self.kind = kind
        self.title = title
        self.detailLine = detailLine
        self.waitingSince = waitingSince
        self.assignee = assignee
        self.assigneeReason = assigneeReason
        self.escalateAt = escalateAt
        self.escalatedAt = escalatedAt
        self.taskId = taskId
        self.sessionId = sessionId
        self.promotionId = promotionId
        self.fuseEpisodeId = fuseEpisodeId
        self.delivery = delivery
        self.actions = actions
        self.question = question
        self.facts = facts
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        kind = try c.decodeIfPresent(ProjectOpenItemKind.self, forKey: .kind) ?? .unknown
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        detailLine = try c.decodeIfPresent(String.self, forKey: .detailLine) ?? ""
        waitingSince = try c.decodeIfPresent(String.self, forKey: .waitingSince) ?? ""
        assignee = try c.decodeIfPresent(ProjectOpenItemAssignee.self, forKey: .assignee) ?? .unknown
        assigneeReason = try c.decodeIfPresent(ProjectOpenItemAssigneeReason.self,
                                               forKey: .assigneeReason) ?? .unknown
        escalateAt = try c.decodeIfPresent(String.self, forKey: .escalateAt)
        escalatedAt = try c.decodeIfPresent(String.self, forKey: .escalatedAt)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        promotionId = try c.decodeIfPresent(String.self, forKey: .promotionId)
        fuseEpisodeId = try c.decodeIfPresent(String.self, forKey: .fuseEpisodeId)
        delivery = try c.decodeIfPresent(Delivery.self, forKey: .delivery)
        actions = try c.decodeIfPresent([ProjectOpenItemAction].self, forKey: .actions) ?? []
        question = try c.decodeIfPresent(CoordinatorQuestion.self, forKey: .question)
        facts = try c.decodeIfPresent(OpenItemFacts.self, forKey: .facts)
    }
}

/// What an open item's payload holds, as the rows its card draws (§7.5), mirroring `@orbit/shared`'s
/// `OpenItemFacts` — which is the server's own reading of the item's `payload` column, the same one
/// the browser draws (`ProjectProgressStatus.tsx`'s `ItemFactRows`).
///
/// Every field is the reading's own answer, absence included: a key the payload did not carry is nil
/// or empty here rather than defaulted to something plausible, and the row that would have drawn it
/// is skipped. That is what lets an item an older build opened draw the card it was, instead of a
/// card with blanks in it — and it is why nothing here is re-derived from `detailLine`: two
/// renderings of one fact are two things free to disagree.
public struct OpenItemFacts: Codable, Equatable, Sendable {
    /// The task the item is about, when it names one: the card's first row.
    public struct Task: Codable, Equatable, Sendable {
        public let id: String
        public let title: String
        public init(id: String, title: String) {
            self.id = id
            self.title = title
        }
    }

    /// Why an attempt failed and where its chain stands (§4.3, §4.5). Both counts absent rather
    /// than defaulted: a row that guessed "attempt 1 of 3" would be describing a chain nobody read.
    public struct Failure: Codable, Equatable, Sendable {
        public let how: String?
        public let exitCode: Int?
        public let expectedExitCode: Int?
        public let attempt: Int?
        public let limit: Int?

        public init(how: String? = nil, exitCode: Int? = nil, expectedExitCode: Int? = nil,
                    attempt: Int? = nil, limit: Int? = nil) {
            self.how = how
            self.exitCode = exitCode
            self.expectedExitCode = expectedExitCode
            self.attempt = attempt
            self.limit = limit
        }
    }

    public let task: Task?
    /// The branch an integration was moving work into, and the tip it was moving (INTEGRATION_*).
    public let targetRef: String?
    public let targetSha: String?
    /// The paths a conflicting merge could not reconcile (INTEGRATION_CONFLICT).
    public let files: [String]
    /// Whether the target branch is where it was — the first thing a reader asks a conflict.
    public let nothingLanded: Bool
    /// The check that disagreed on the combined tree (INTEGRATION_CHECK_FAILED).
    public let check: IntegrationCheckResult?
    /// Whether the task's own branch passed — the check failed only combined with it.
    public let branchUnchanged: Bool
    /// The code an integration job ended with (INTEGRATION_ERROR).
    public let errorCode: String?
    /// Why a task's attempt failed, and where its chain stands (TASK_FAILED).
    public let failure: Failure?

    public init(task: Task? = nil, targetRef: String? = nil, targetSha: String? = nil,
                files: [String] = [], nothingLanded: Bool = false,
                check: IntegrationCheckResult? = nil, branchUnchanged: Bool = false,
                errorCode: String? = nil, failure: Failure? = nil) {
        self.task = task
        self.targetRef = targetRef
        self.targetSha = targetSha
        self.files = files
        self.nothingLanded = nothingLanded
        self.check = check
        self.branchUnchanged = branchUnchanged
        self.errorCode = errorCode
        self.failure = failure
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        task = try c.decodeIfPresent(Task.self, forKey: .task)
        targetRef = try c.decodeIfPresent(String.self, forKey: .targetRef)
        targetSha = try c.decodeIfPresent(String.self, forKey: .targetSha)
        files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
        nothingLanded = try c.decodeIfPresent(Bool.self, forKey: .nothingLanded) ?? false
        check = try c.decodeIfPresent(IntegrationCheckResult.self, forKey: .check)
        branchUnchanged = try c.decodeIfPresent(Bool.self, forKey: .branchUnchanged) ?? false
        errorCode = try c.decodeIfPresent(String.self, forKey: .errorCode)
        failure = try c.decodeIfPresent(Failure.self, forKey: .failure)
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

/// `POST /projects/:id/open-items/:itemId/return-to-coordinator` — the item is the coordinator's
/// again, with the project's clock for it restarted (§4.7, mock 5).
public struct OpenItemReturned: Codable, Equatable, Sendable {
    public let itemId: String
    public let assignee: ProjectOpenItemAssignee
    /// The wait starts over, which is the whole of what "ask again" gives the coordinator.
    public let waitingSince: String
    /// When it comes back to the owner if nobody acts on it this time.
    public let escalateAt: String?

    public init(itemId: String, assignee: ProjectOpenItemAssignee = .coordinator,
                waitingSince: String, escalateAt: String? = nil) {
        self.itemId = itemId
        self.assignee = assignee
        self.waitingSince = waitingSince
        self.escalateAt = escalateAt
    }
}

/// `POST /projects/:id/fuse/:episodeId/resume` — the pause is lifted (§6.3 F-T4). Only the instant
/// is read: what else the door answers is the held work it released, and the card's business is
/// that the press was taken, which the item list then says by no longer carrying the pause.
public struct FuseResumed: Codable, Equatable, Sendable {
    public let resumedAt: String

    public init(resumedAt: String) { self.resumedAt = resumedAt }
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

/// The owner's reason, as `POST /projects/:id/open-items/:itemId/resolve` takes it (§4.7). The
/// reason is required by the door (`ResolveOpenItemDto.note`), so there is no request without one —
/// `ExceptionCards.markHandledRequest` is the only place one is built.
public struct OpenItemResolveRequest: Codable, Sendable {
    public let note: String
    public init(note: String) { self.note = note }
}

/// An item its assignee closed by hand, and what that ending is called (§4.7).
public struct OpenItemResolved: Codable, Equatable, Sendable {
    public let itemId: String
    public let state: String
    /// `HANDLED` for an exception the owner dealt with themselves, `WITHDRAWN` for a question its
    /// asker took back. The card draws the press for the first and none for the second.
    public let resolution: String

    public init(itemId: String, state: String = "RESOLVED", resolution: String = "HANDLED") {
        self.itemId = itemId
        self.state = state
        self.resolution = resolution
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
    /// The last 16 KB of combined output — what a person reads to know why it is red. Absent on the
    /// merge card's checks, which draw the measurement and not the log; the exception card's fact
    /// block draws it, so it is read here rather than re-declared for one caller.
    public let outputTail: String?

    public init(name: String, command: String, expectedExitCode: Int? = 0, exitCode: Int? = 0,
                timedOut: Bool? = false, durationMs: Int? = nil, outputTail: String? = nil) {
        self.name = name
        self.command = command
        self.expectedExitCode = expectedExitCode
        self.exitCode = exitCode
        self.timedOut = timedOut
        self.durationMs = durationMs
        self.outputTail = outputTail
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
