import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   "IS THIS PROJECT DONE?" — THIS CLIENT'S HALF OF WEB'S `lib/projectDone.ts` AND THE DONE PATH OF
   `ProjectSettlementCard.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   ASKED BY THE COORDINATOR, RECORDED BY THE OWNER
   -----------------------------------------------
   A coordinator asks its owner to record the project done (`project_request_done`) once Orbit's
   close-out check passed: the open `DONE_REQUEST` item, which the open-items read serves beside the
   project's other items (`ProjectOpenItemsView.doneRequest`) and which carries the coordinator's
   call and every gap Orbit cannot prove (`DoneRequest`). The owner answers it on one card — Record
   as done, or Not yet… with a sentence — and a press is one write at `POST /projects/:id/done`:
   the seal the request was made about, and the gaps accepted. The owner may also open the same
   card without being asked (the project page's Record as done…); Orbit then fills in the facts.

   EVERY NUMBER IS THE SERVER'S
   ----------------------------
   The counts are read from `derivedDone.counts` and nothing here counts tasks or receipts: one
   place counts, and the met / on main / nothing-to-land numbers add up the same on every surface.
   Why a criterion is not on main is the server's own reason (`CriterionLandingReason`), and the
   Why-not-done card groups by it without deciding anything.

   EVERY WORD IS THE BROWSER'S
   ---------------------------
   `lib/projectDone.ts` declares each word once, and `ProjectDoneCopyParityTests` reads that file —
   and the sentences `ProjectSettlementCard.tsx` builds from those words — back against the ones
   below: the two clients share no compiler, so a sentence re-worded at one end only turns nothing
   else red. The derivations are held to the browser's own examples by `ProjectDoneTests`.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire

/// Why a criterion is not on main by work of its own (D4) — `@orbit/shared`'s
/// `CriterionLandingReason`, as the apiserver's `criterion-landing-reason.ts` reads it. A reason
/// this build does not know decodes as ``unknown``, which no group claims.
public enum CriterionLandingReason: String, Codable, Sendable {
    /// A landing of its work, or a merge of the project branch into main, is queued or running.
    case inFlight = "IN_FLIGHT"
    /// Its work is on the project branch, and nothing is taking it to main.
    case onProjectBranch = "ON_PROJECT_BRANCH"
    /// Its work ran a branch and the line found no commit of its own on it.
    case nothingToLand = "NOTHING_TO_LAND"
    /// No receipt puts its work on either branch: merged outside Orbit, or not merged.
    case noReceipt = "NO_RECEIPT"
    /// Its work has no branch to land.
    case codeless = "CODELESS"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CriterionLandingReason(rawValue: raw) ?? .unknown
    }
}

/// Who recorded a project's DONE (`project.done_by`): the account owner in person, or Orbit's
/// projection from committed facts — `@orbit/shared`'s `ProjectDoneBy`.
public enum ProjectDoneBy: String, Codable, Sendable {
    case owner = "OWNER"
    case derived = "DERIVED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProjectDoneBy(rawValue: raw) ?? .unknown
    }
}

/// Every number a card prints about a project's criteria, counted once by the server
/// (`DerivedDoneCounts`): `onMain` and the reasons partition the criteria.
public struct ProjectDoneCounts: Codable, Equatable, Sendable {
    public let criteria: Int
    public let met: Int
    public let landed: Int
    public let onMain: Int
    /// By the server's own spelling of each reason, so a reason this build does not know is still
    /// carried rather than dropped.
    public let byReason: [String: Int]

    public init(criteria: Int, met: Int, landed: Int, onMain: Int,
                byReason: [CriterionLandingReason: Int] = [:]) {
        self.criteria = criteria
        self.met = met
        self.landed = landed
        self.onMain = onMain
        var raw: [String: Int] = [:]
        for (reason, count) in byReason { raw[reason.rawValue] = count }
        self.byReason = raw
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        criteria = try c.decodeIfPresent(Int.self, forKey: .criteria) ?? 0
        met = try c.decodeIfPresent(Int.self, forKey: .met) ?? 0
        landed = try c.decodeIfPresent(Int.self, forKey: .landed) ?? 0
        onMain = try c.decodeIfPresent(Int.self, forKey: .onMain) ?? 0
        byReason = (try? c.decodeIfPresent([String: Int].self, forKey: .byReason)) ?? [:]
    }

    /// How many criteria carry `reason`.
    public func count(_ reason: CriterionLandingReason) -> Int {
        byReason[reason.rawValue] ?? 0
    }
}

/// One criterion as the projection answers for it (`DerivedDoneCriterion`), narrowed to what the
/// cards read.
public struct ProjectDoneCriterion: Codable, Equatable, Sendable, Identifiable {
    public let definitionId: String
    public let satisfied: Bool
    /// `LANDED`, `ON_INTEGRATION_LINE` or `UNKNOWN`.
    public let landing: String
    /// Nil exactly when its work is on main by work of its own.
    public let landingReason: CriterionLandingReason?
    /// The clauses this criterion trips — what the Ask-the-coordinator message names.
    public let withheld: [String]

    public var id: String { definitionId }

    public init(definitionId: String, satisfied: Bool, landing: String = "LANDED",
                landingReason: CriterionLandingReason? = nil, withheld: [String] = []) {
        self.definitionId = definitionId
        self.satisfied = satisfied
        self.landing = landing
        self.landingReason = landingReason
        self.withheld = withheld
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        definitionId = try c.decode(String.self, forKey: .definitionId)
        satisfied = try c.decodeIfPresent(Bool.self, forKey: .satisfied) ?? false
        landing = try c.decodeIfPresent(String.self, forKey: .landing) ?? "UNKNOWN"
        landingReason = try c.decodeIfPresent(CriterionLandingReason.self, forKey: .landingReason)
        withheld = (try? c.decodeIfPresent([String].self, forKey: .withheld)) ?? []
    }
}

/// `derivedDone`, as the project document serves it: the status the committed facts project, what
/// withholds it, each criterion's answer, and the counts.
public struct ProjectDerivedDone: Codable, Equatable, Sendable {
    public let status: String
    public let done: Bool
    public let withheld: [String]
    public let criteria: [ProjectDoneCriterion]
    /// `UNCONFIRMED`, `CONFIRMED` or `STALE`.
    public let confirmation: String?
    /// The unified read (D4). Nil from a server that predates it, which draws none of these cards.
    public let counts: ProjectDoneCounts?

    public init(status: String = "OPEN", done: Bool = false, withheld: [String] = [],
                criteria: [ProjectDoneCriterion] = [], confirmation: String? = "CONFIRMED",
                counts: ProjectDoneCounts? = nil) {
        self.status = status
        self.done = done
        self.withheld = withheld
        self.criteria = criteria
        self.confirmation = confirmation
        self.counts = counts
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "OPEN"
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        withheld = (try? c.decodeIfPresent([String].self, forKey: .withheld)) ?? []
        criteria = try c.decodeIfPresent([ProjectDoneCriterion].self, forKey: .criteria) ?? []
        confirmation = try c.decodeIfPresent(String.self, forKey: .confirmation)
        counts = try? c.decodeIfPresent(ProjectDoneCounts.self, forKey: .counts)
    }
}

/// One gap: a criterion Orbit could not prove, and what was checked instead — `@orbit/shared`'s
/// `AcceptedGap`, which a `DoneRequest` carries and the owner's press sends back.
///
/// Kept as the object it arrived as: the server stores what the owner accepted as it was sent, and
/// a gap may carry keys this build has no words for. The fields the cards draw are read off it.
public struct AcceptedGap: Codable, Equatable, Sendable {
    public let fields: [String: JSONValue]

    /// The criterion's `key`, as `project_get` gives it.
    public var criterionKey: String { fields["criterionKey"]?.stringValue ?? "" }
    /// A few words naming the gap — the card's headline for it.
    public var title: String? { fields["title"]?.stringValue }
    /// Why Orbit cannot prove the criterion.
    public var whyNotProven: String? { fields["whyNotProven"]?.stringValue }
    /// What the coordinator checked instead.
    public var coordinatorChecked: String? { fields["coordinatorChecked"]?.stringValue }
    /// Where that evidence is.
    public var evidenceRefs: [String] {
        guard case .array(let refs)? = fields["evidenceRefs"] else { return [] }
        return refs.compactMap(\.stringValue)
    }

    public init(criterionKey: String, title: String? = nil, whyNotProven: String? = nil,
                coordinatorChecked: String? = nil, evidenceRefs: [String]? = nil) {
        var fields: [String: JSONValue] = ["criterionKey": .string(criterionKey)]
        if let title { fields["title"] = .string(title) }
        if let whyNotProven { fields["whyNotProven"] = .string(whyNotProven) }
        if let coordinatorChecked { fields["coordinatorChecked"] = .string(coordinatorChecked) }
        if let evidenceRefs { fields["evidenceRefs"] = .array(evidenceRefs.map(JSONValue.string)) }
        self.fields = fields
    }

    public init(from decoder: Decoder) throws {
        let object = try decoder.singleValueContainer().decode([String: JSONValue].self)
        guard object["criterionKey"]?.stringValue != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath,
                                                    debugDescription: "a gap names no criterion"))
        }
        fields = object
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(fields)
    }
}

/// A coordinator's request that its owner record the project done: the `DONE_REQUEST` open item's
/// payload (`ProjectOpenItemRow.doneRequest`), and what "Is this project done?" is drawn from.
///
/// `criteriaDigest` is the seal of the criteria the request was made about — the one the owner's
/// press sends, so a request whose criteria moved since is refused rather than recorded.
public struct DoneRequest: Codable, Equatable, Sendable {
    public let criteriaDigest: String
    /// The coordinator's call, in a sentence or two.
    public let judgment: String
    /// What Orbit cannot prove: the gaps, each naming its criterion.
    public let gaps: [AcceptedGap]
    public let stateDigest: String?

    public init(criteriaDigest: String, judgment: String, gaps: [AcceptedGap] = [],
                stateDigest: String? = nil) {
        self.criteriaDigest = criteriaDigest
        self.judgment = judgment
        self.gaps = gaps
        self.stateDigest = stateDigest
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        criteriaDigest = try c.decode(String.self, forKey: .criteriaDigest)
        judgment = try c.decodeIfPresent(String.self, forKey: .judgment) ?? ""
        gaps = try c.decodeIfPresent([AcceptedGap].self, forKey: .gaps) ?? []
        stateDigest = try c.decodeIfPresent(String.self, forKey: .stateDigest)
    }
}

/// `POST /projects/:id/done`: the request the press answers (nil when the owner records it done
/// without being asked), the seal the owner read, and the gaps accepted — `ProjectDoneRequestBody`.
/// Encoded by hand: the door reads an absent request and a null one the same, and the browser
/// sends null.
public struct ProjectDoneRequestBody: Encodable, Equatable, Sendable {
    public let requestId: String?
    public let criteriaDigest: String
    public let acceptedGaps: [AcceptedGap]

    public init(requestId: String?, criteriaDigest: String, acceptedGaps: [AcceptedGap]) {
        self.requestId = requestId
        self.criteriaDigest = criteriaDigest
        self.acceptedGaps = acceptedGaps
    }

    enum CodingKeys: String, CodingKey {
        case requestId, criteriaDigest, acceptedGaps
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let requestId {
            try c.encode(requestId, forKey: .requestId)
        } else {
            try c.encodeNil(forKey: .requestId)
        }
        try c.encode(criteriaDigest, forKey: .criteriaDigest)
        try c.encode(acceptedGaps, forKey: .acceptedGaps)
    }
}

/// What `POST /projects/:id/done` answers: the record it wrote — `ProjectDoneRecord`.
public struct ProjectDoneRecord: Codable, Equatable, Sendable {
    public let projectId: String
    public let status: String
    public let doneBy: ProjectDoneBy
    public let doneAt: String
    public let criteriaDigest: String
    public let acceptedGaps: [AcceptedGap]
    public let requestId: String?

    public init(projectId: String, status: String = "DONE", doneBy: ProjectDoneBy = .owner,
                doneAt: String, criteriaDigest: String, acceptedGaps: [AcceptedGap] = [],
                requestId: String? = nil) {
        self.projectId = projectId
        self.status = status
        self.doneBy = doneBy
        self.doneAt = doneAt
        self.criteriaDigest = criteriaDigest
        self.acceptedGaps = acceptedGaps
        self.requestId = requestId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "DONE"
        doneBy = try c.decodeIfPresent(ProjectDoneBy.self, forKey: .doneBy) ?? .owner
        doneAt = try c.decodeIfPresent(String.self, forKey: .doneAt) ?? ""
        criteriaDigest = try c.decodeIfPresent(String.self, forKey: .criteriaDigest) ?? ""
        acceptedGaps = (try? c.decodeIfPresent([AcceptedGap].self, forKey: .acceptedGaps)) ?? []
        requestId = try c.decodeIfPresent(String.self, forKey: .requestId)
    }
}

/// `POST /projects/:id/done-requests/:itemId/decline` — the owner's "Not yet…" and what is still
/// missing, in their words (`ProjectDoneRequestDeclineBody`).
public struct ProjectDoneDeclineBody: Codable, Equatable, Sendable {
    public let note: String

    public init(note: String) { self.note = note }
}

/// The request ended by "Not yet…", and where the note went (`ProjectDoneRequestDeclined`). Only
/// the item is read: what the card says afterwards is drawn from the reads that follow.
public struct ProjectDoneRequestDeclined: Codable, Equatable, Sendable {
    public let itemId: String

    public init(itemId: String) { self.itemId = itemId }
}

// MARK: - the project, as these cards read it

/// As much of a project document as the done cards read: its words, its status, the projection
/// and its record — read off the project page's document and the coordinator conversation's alike.
public struct ProjectDoneSubject: Equatable, Sendable {
    /// One stated criterion, as a gap or a row names it.
    public struct Criterion: Equatable, Sendable, Identifiable {
        public let id: String
        public let key: String?
        public let ordinal: Int
        public let text: String

        public init(id: String, key: String? = nil, ordinal: Int, text: String) {
            self.id = id
            self.key = key
            self.ordinal = ordinal
            self.text = text
        }
    }

    public let title: String
    /// `OPEN`, `DONE`, `CANCELLED`, or nil for a read that did not say.
    public let status: String?
    public let criteria: [Criterion]
    public let derivedDone: ProjectDerivedDone?
    public let doneBy: ProjectDoneBy?
    public let doneAt: String?
    public let acceptedGaps: [AcceptedGap]

    public init(title: String, status: String?, criteria: [Criterion] = [],
                derivedDone: ProjectDerivedDone? = nil, doneBy: ProjectDoneBy? = nil,
                doneAt: String? = nil, acceptedGaps: [AcceptedGap] = []) {
        self.title = title
        self.status = status
        self.criteria = criteria
        self.derivedDone = derivedDone
        self.doneBy = doneBy
        self.doneAt = doneAt
        self.acceptedGaps = acceptedGaps
    }

    /// The counts, which is what a current server's read carries and an older one's does not: no
    /// card is drawn from a projection without them.
    public var counts: ProjectDoneCounts? { derivedDone?.counts }

    /// The criterion a gap or an answer names — by its id or by its key, which the browser's
    /// `criterionForGap` reads the same.
    public func criterion(_ key: String) -> Criterion? {
        criteria.first { $0.id == key || $0.key == key }
    }
}

// MARK: - the words

public enum ProjectDone {

    // The owner card, in `lib/projectDone.ts`'s order. Each is one of that file's declarations,
    // word for word.

    /// `DONE_CARD_HEADING` — the card's question, and the title of the open item that asks it.
    public static let heading = "Is this project done?"
    /// `DONE_CARD_COORDINATOR_CALL`.
    public static let coordinatorCall = "Coordinator’s call"
    /// `DONE_CARD_DONE_WHEN`.
    public static let doneWhen = "Done when"
    /// `DONE_CARD_WHAT_ORBIT_CANT_PROVE`.
    public static let whatOrbitCantProve = "What Orbit can’t prove"
    /// `DONE_CARD_COORDINATOR_CHECKED`.
    public static let coordinatorChecked = "Coordinator checked"
    /// `DONE_CARD_ORBIT_CHECKED`.
    public static let orbitChecked = "Orbit checked"
    /// `DONE_CARD_RECORD`.
    public static let recordAsDone = "Record as done"
    /// `DONE_CARD_RECORD_ANYWAY` — while some criterion is still not met.
    public static let recordAsDoneAnyway = "Record as done anyway"
    /// `DONE_CARD_NOT_YET`.
    public static let notYet = "Not yet…"
    /// `DONE_CARD_MISSING` — what "Not yet…" asks for.
    public static let missingBeforeDone = "What’s missing before it’s done?"
    /// `DONE_CARD_RECEIPT`.
    public static let receipt = "You recorded this project done"
    /// `DONE_CARD_GAPS_ACCEPTED`.
    public static let gapsAccepted = "gaps accepted"
    /// `DONE_CARD_SEE_ACCEPTED`.
    public static let seeWhatAccepted = "See what you accepted"
    /// `DONE_CARD_REOPEN`.
    public static let reopenProject = "Reopen project"
    /// `DONE_CARD_EXPLANATION` — the one paragraph the card keeps.
    public static let recordingExplanation =
        "Recording it done is yours. Orbit keeps your record — a later check won’t reopen the project "
        + "unless the criteria change or one of their tasks is reopened."
    /// `DONE_CARD_NOT_YET_HINT` — what sending the note does.
    public static let notYetHint =
        "Sends your note and this card’s facts to the coordinator. The card closes; it asks again "
        + "when it has more."
    /// `DONE_CARD_ASKED_BY_COORDINATOR`.
    public static let askedByCoordinator = "asked by the coordinator"
    /// `DONE_CARD_SHOW_ALL`.
    public static let showAll = "Show all"
    /// `DONE_CARD_SHOW_LESS`.
    public static let showLess = "Show less"
    /// `DONE_CARD_SEND_TO_COORDINATOR`.
    public static let sendToCoordinator = "Send to coordinator"
    /// `DONE_CARD_BACK`.
    public static let back = "Back"
    /// `DONE_CARD_THIS_PROJECT_IS_DONE` (and `WHY_NOT_DONE_THIS_PROJECT_IS_DONE`).
    public static let thisProjectIsDone = "This project is done"

    // The Why-not-done card.

    /// `WHY_NOT_DONE_HEADING`.
    public static let whyHeading = "Why is this project not done?"
    /// `WHY_NOT_DONE_WAITING_ON_WORK`.
    public static let waitingOnWork = "Waiting on work"
    /// `WHY_NOT_DONE_NEEDS_YOUR_CALL`.
    public static let needsYourCall = "Needs your call"
    /// `WHY_NOT_DONE_ON_MAIN`.
    public static let onMain = "on main"
    /// `WHY_NOT_DONE_REVIEW`.
    public static let reviewDoneRequest = "Review “Is this project done?”"
    /// `WHY_NOT_DONE_COORDINATOR_IS_ON_IT`.
    public static let coordinatorIsOnIt = "the coordinator is on it"
    /// `WHY_NOT_DONE_ON_PROJECT_BRANCH`.
    public static let onProjectBranch = "On the project branch"
    /// `WHY_NOT_DONE_MERGED_OUTSIDE_ORBIT`.
    public static let mergedOutsideOrbit = "Merged outside Orbit"
    /// `WHY_NOT_DONE_NOTHING_TO_LAND`.
    public static let nothingToLand = "nothing to land"
    /// `WHY_NOT_DONE_ASK_COORDINATOR`.
    public static let askCoordinator = "Ask the coordinator to handle it"
    /// `WHY_NOT_DONE_WAITING_DETAIL`.
    public static let waitingDetail =
        "Goes to main after the merge check — the coordinator is handling it."
    /// `WHY_NOT_DONE_NEEDS_CALL_DETAIL`.
    public static let needsCallDetail =
        "Orbit saw no merge for it. The coordinator checked main has it and asked you to record the "
        + "project done."
    /// `WHY_NOT_DONE_NOT_MET_YET` — an unmet criterion's state: its work has not happened, so its
    /// landing lane (no receipt, no code) says nothing yet.
    public static let notMetYet = "Not met yet"
    /// `WHY_NOT_DONE_NOT_MET_DETAIL`.
    public static let notMetDetail = "Its work has not met this criterion yet."

    // Status, rows and the project page.

    /// `PROJECT_DONE_RECORDED_BY_YOU`.
    public static let recordedByYou = "recorded by you"
    /// `PROJECT_DONE_RECORDED_BY_ORBIT`.
    public static let recordedByOrbit = "recorded by Orbit"
    /// `READY_TO_CLOSE` — what the coordinator's session row, the request's row and the page say
    /// while the card is waiting.
    public static let readyToClose = "Ready to close"
    /// `PROJECT_DONE_COORDINATOR_ASKED`.
    public static let coordinatorAsked = "The coordinator asked"
    /// `PROJECT_DONE_GAPS_IT_COULDNT_PROVE`.
    public static let gapsItCouldntProve = "gaps it couldn’t prove"
    /// `PROJECT_DONE_NOT_ASKED_YET`.
    public static let notAskedYet = "not asked yet"
    /// `PROJECT_DONE_RECORD_AS_DONE_ROW` — the owner's own row, and the row of a coordinator session
    /// whose project looks finished and was not asked about in time.
    public static let recordAsDoneRow = "Record as done…"

    // Words `PROJECT_DONE_COPY` and the card spell inline.

    /// `PROJECT_DONE_COPY.noRequestMeta` — the meta line of a card nobody asked for.
    public static let noRequestMeta = "record as done anyway"
    /// `PROJECT_DONE_COPY.landedOnMain`.
    public static let landedOnMain = "landed on main"
    /// The card's provenance badge (`FROM ORBIT`).
    public static let provenance = "FROM ORBIT"
    /// What the gaps section says when Orbit has none.
    public static let noGaps = "Orbit has no gaps to report."
    /// What a press the door did not take says, over the door's own message.
    public static let notRecorded = "Project was not recorded done"
    /// …and the two presses beside it.
    public static let notDeclined = "That answer was not sent"
    public static let notReopened = "The project was not reopened"

    // MARK: the counts, in words

    /// The order the reasons are said in (`REASON_ORDER`).
    public static let reasonOrder: [CriterionLandingReason] = [
        .inFlight, .onProjectBranch, .noReceipt, .nothingToLand, .codeless,
    ]

    /// A reason as a tally says it (`REASON_LABELS`).
    public static func reasonLabel(_ reason: CriterionLandingReason) -> String {
        switch reason {
        case .inFlight:        return "in flight"
        case .onProjectBranch: return "on the project branch"
        case .nothingToLand:   return nothingToLand
        case .noReceipt:       return "merged outside Orbit"
        case .codeless:        return "no code to land"
        case .unknown:         return reason.rawValue
        }
    }

    /// Each reason any criterion carries, in order: "1 in flight · 1 nothing to land".
    static func reasonParts(_ counts: ProjectDoneCounts) -> [String] {
        reasonOrder.compactMap { reason in
            let count = counts.count(reason)
            return count > 0 ? "\(count) \(reasonLabel(reason))" : nil
        }
    }

    /// CODELESS says the same thing to a reader as a zero-commit task: there is nothing to land.
    static func nothingToLandCount(_ counts: ProjectDoneCounts) -> Int {
        counts.count(.nothingToLand) + counts.count(.codeless)
    }

    /// `projectDoneTally`: "2 criteria · 2 met · 1 landed on main · 1 nothing to land".
    public static func tally(_ counts: ProjectDoneCounts?) -> String {
        guard let counts else { return "" }
        return (["\(counts.criteria) criteria", "\(counts.met) met",
                 "\(counts.onMain) \(landedOnMain)"] + reasonParts(counts))
            .joined(separator: " · ")
    }

    /// `projectDoneCardTally` — the request card's three counts; its head already says how many
    /// criteria there are.
    public static func cardTally(_ counts: ProjectDoneCounts?) -> String {
        guard let counts else { return "" }
        return ["\(counts.met) met", "\(counts.onMain) \(landedOnMain)",
                "\(nothingToLandCount(counts)) \(nothingToLand)"].joined(separator: " · ")
    }

    /// `projectDoneReceiptTally` — the receipt's: how many were met, then the same three.
    public static func receiptTally(_ counts: ProjectDoneCounts?, acceptedGaps: Int) -> String {
        guard let counts else { return "\(acceptedGaps) \(gapsAccepted)" }
        return ["\(counts.criteria) criteria met", "\(counts.onMain) \(landedOnMain)",
                "\(nothingToLandCount(counts)) \(nothingToLand)", "\(acceptedGaps) \(gapsAccepted)"]
            .joined(separator: " · ")
    }

    /// `projectWhyNotDoneTally` — the shorter "on main".
    public static func whyNotDoneTally(_ counts: ProjectDoneCounts?) -> String {
        guard let counts else { return "" }
        return (["\(counts.criteria) criteria", "\(counts.met) met", "\(counts.onMain) \(onMain)"]
            + reasonParts(counts)).joined(separator: " · ")
    }

    /// `landingReasonLabel` — one criterion's reason, as a row says it. Nil is on main.
    public static func landingReasonLabel(_ reason: CriterionLandingReason?) -> String {
        switch reason {
        case .inFlight?:        return "In flight"
        case .onProjectBranch?: return onProjectBranch
        case .noReceipt?:       return mergedOutsideOrbit
        case .nothingToLand?:   return nothingToLand
        case .codeless?:        return "No code to land"
        default:                return "Landed on main"
        }
    }

    /// `isWaitingOnWork`.
    public static func isWaitingOnWork(_ reason: CriterionLandingReason?) -> Bool {
        reason == .inFlight || reason == .onProjectBranch
    }

    /// `isNeedsYourCall`.
    public static func isNeedsYourCall(_ reason: CriterionLandingReason?) -> Bool {
        reason == .noReceipt
    }

    /// `doneProvenance` — who recorded it: "recorded by you · 2 gaps accepted", or Orbit.
    public static func provenance(doneBy: ProjectDoneBy?, acceptedGaps: Int) -> String {
        doneBy == .owner ? "\(recordedByYou) · \(acceptedGaps) \(gapsAccepted)" : recordedByOrbit
    }

    // MARK: dates, the browser's way

    /// `formatDoneDate` — "Oct 1", in the reader's own time zone.
    public static func date(_ iso: String?, timeZone: TimeZone = .current) -> String? {
        guard let iso, let date = RelativeTime.parse(iso) else { return nil }
        return formatter("MMM d", timeZone).string(from: date)
    }

    /// `formatDoneDateTime` — "Oct 1, 01:40".
    public static func dateTime(_ iso: String?, timeZone: TimeZone = .current) -> String? {
        guard let iso, let date = RelativeTime.parse(iso) else { return nil }
        return formatter("MMM d, HH:mm", timeZone).string(from: date)
    }

    private static func formatter(_ format: String, _ timeZone: TimeZone) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = format
        return f
    }

    // MARK: the owner card

    /// "Done when · 7 criteria" (the browser says criteria for any count).
    public static func doneWhenHead(_ count: Int) -> String {
        "\(doneWhen) · \(count) criteria"
    }

    /// "What Orbit can’t prove · 2".
    public static func gapsHead(_ count: Int) -> String {
        "\(whatOrbitCantProve) · \(count)"
    }

    /// "Show all 7".
    public static func showAll(_ count: Int) -> String {
        "\(showAll) \(count)"
    }

    /// How long the coordinator's request has waited, from its own `waitingSince`: "waiting 25m"
    /// (`doneRequestWaiting`, in `formatSpan`'s words — `RelativeTime.span`). Nil for an instant
    /// this build cannot read.
    public static func requestWaiting(_ waitingSince: String?, now: Date = Date()) -> String? {
        guard let waitingSince, let at = RelativeTime.parse(waitingSince) else { return nil }
        return "waiting \(RelativeTime.span(now.timeIntervalSince(at)))"
    }

    /// The card's meta line: which project, and who asked and how long it has waited — or that
    /// nobody asked: "Aurora · asked by the coordinator · waiting 25m".
    public static func meta(projectTitle: String, asked: Bool, waiting: String?) -> String {
        guard asked else { return "\(projectTitle) · \(noRequestMeta)" }
        return ([projectTitle, askedByCoordinator] + [waiting].compactMap { $0 }).joined(separator: " · ")
    }

    /// What the record press says: anyway while some criterion is not met.
    public static func recordLabel(_ counts: ProjectDoneCounts?) -> String {
        if let counts, counts.met < counts.criteria { return recordAsDoneAnyway }
        return recordAsDone
    }

    /// One criterion's line in Done when's list: "met · Landed on main".
    public static func criterionState(_ criterion: ProjectDoneCriterion) -> String {
        "\(criterion.satisfied ? "met" : "not met") · \(landingReasonLabel(criterion.landingReason))"
    }

    /// What the coordinator checked for a gap, and where the evidence is: "main contains the release
    /// files · evidence run-42".
    public static func checkedLine(_ gap: AcceptedGap) -> String? {
        guard let checked = gap.coordinatorChecked else { return nil }
        let refs = gap.evidenceRefs
        return refs.isEmpty ? checked : "\(checked) · evidence \(refs.joined(separator: ", "))"
    }

    /// The gaps a card nobody asked for carries (`syntheticDoneGaps`): every criterion that is not
    /// met, or not on main for a reason that is a gap — nothing to land and no code to land are
    /// outcomes, not gaps to paper over.
    public static func syntheticGaps(_ subject: ProjectDoneSubject) -> [AcceptedGap] {
        (subject.derivedDone?.criteria ?? [])
            .filter { criterion in
                let reason = criterion.landingReason
                let gap = reason != nil && reason != .nothingToLand && reason != .codeless
                return gap || !criterion.satisfied
            }
            .map { criterion in
                let item = subject.criteria.first { $0.id == criterion.definitionId }
                let reason = landingReasonLabel(criterion.landingReason)
                return AcceptedGap(
                    criterionKey: item?.key ?? item?.id ?? criterion.definitionId,
                    title: item?.text ?? criterion.definitionId,
                    whyNotProven: criterion.satisfied
                        ? "Orbit cannot prove this criterion is on main: \(reason)."
                        : "Orbit cannot prove this criterion is met by its work yet.")
            }
    }

    /// The gaps the card shows: the request's, or the ones Orbit fills in when nobody asked.
    public static func gaps(_ subject: ProjectDoneSubject, request: DoneRequest?) -> [AcceptedGap] {
        request?.gaps ?? syntheticGaps(subject)
    }

    /// The Orbit checked line (`orbitCheckedText`): whether every criterion is met, what is running,
    /// what is open, and when the owner confirmed the criteria.
    public static func orbitCheckedLine(counts: ProjectDoneCounts?, confirmedAt: String?,
                                        openItems: Int, running: Int,
                                        timeZone: TimeZone = .current) -> String {
        let allMet = counts.map { $0.met == $0.criteria } ?? false
        let lead = allMet
            ? "every criterion is met by its work"
            : "\(counts?.met ?? 0) of \(counts?.criteria ?? 0) criteria are met by their work"
        let runningWords = running == 0 ? "nothing running" : "\(running) item\(running == 1 ? "" : "s") running"
        let open = openItems == 0 ? "no open items" : "\(openItems) open item\(openItems == 1 ? "" : "s")"
        var line = "\(orbitChecked): \(lead) · \(runningWords) · \(open)"
        if let on = date(confirmedAt, timeZone: timeZone) {
            line += " · criteria confirmed by you on \(on)"
        }
        return line
    }

    /// How many items the Orbit checked line counts as open: every open item — the owner's, the
    /// coordinator's, a request to start the project or to record it done — except the one request
    /// the card itself is answering (`reviewing`, its item id). The close check refuses a request
    /// while any other item is open, so a card the coordinator asked for says "no open items", as
    /// the mock does; counting the request would make every such card say "1 open item" about
    /// itself. Anything else stays counted, wherever the read lists it.
    public static func openItemsCount(_ items: ProjectOpenItemsView?, reviewing requestID: String?) -> Int {
        guard let items else { return 0 }
        let reviewed: (ProjectOpenItemRow) -> Bool = { row in requestID != nil && row.itemId == requestID }
        return items.needsYou.filter { !reviewed($0) }.count
            + items.withCoordinator.filter { !reviewed($0) }.count
            + [items.startRequest, items.doneRequest].compactMap { $0 }.filter { !reviewed($0) }.count
    }

    /// How many criteria are still landing — what the Orbit checked line calls running.
    public static func runningCount(_ subject: ProjectDoneSubject) -> Int {
        subject.counts?.count(.inFlight) ?? 0
    }

    // MARK: the receipt

    /// Whether the project is recorded done right now, which is when the card is its receipt: its
    /// status says DONE — by whoever recorded it — or a press here has just recorded it and the read
    /// has not caught up. Not who recorded it once: `doneBy` outlives a reopen, and a project
    /// reopened since is asked again, not shown a receipt (the coordinator's ruling, 2026-10-06).
    public static func recorded(_ subject: ProjectDoneSubject, record: ProjectDoneRecord?) -> Bool {
        subject.status == "DONE" || record != nil
    }

    /// Whether the owner recorded it — what the receipt line says it in.
    public static func ownerRecorded(_ subject: ProjectDoneSubject, record: ProjectDoneRecord?) -> Bool {
        record != nil || subject.doneBy == .owner
    }

    /// The gaps the record accepted.
    public static func accepted(_ subject: ProjectDoneSubject, record: ProjectDoneRecord?) -> [AcceptedGap] {
        record?.acceptedGaps ?? subject.acceptedGaps
    }

    /// The receipt's meta: "Project · recorded by you · 2 gaps accepted · Oct 1".
    public static func receiptMeta(_ subject: ProjectDoneSubject, record: ProjectDoneRecord?,
                                   timeZone: TimeZone = .current) -> String {
        let words = provenance(doneBy: record?.doneBy ?? subject.doneBy,
                               acceptedGaps: accepted(subject, record: record).count)
        let on = date(record?.doneAt ?? subject.doneAt, timeZone: timeZone)
        return "\(subject.title) · \(words)" + (on.map { " · \($0)" } ?? "")
    }

    /// The receipt's own line: "You recorded this project done · Oct 1, 01:40", or Orbit's.
    public static func receiptLine(_ subject: ProjectDoneSubject, record: ProjectDoneRecord?,
                                   timeZone: TimeZone = .current) -> String {
        guard ownerRecorded(subject, record: record) else {
            return "\(thisProjectIsDone) · \(recordedByOrbit)"
        }
        let at = dateTime(record?.doneAt ?? subject.doneAt, timeZone: timeZone)
        return receipt + (at.map { " · \($0)" } ?? "")
    }

    /// The receipt's tally.
    public static func receiptTally(_ subject: ProjectDoneSubject, record: ProjectDoneRecord?) -> String {
        receiptTally(subject.counts, acceptedGaps: accepted(subject, record: record).count)
    }

    // MARK: the press

    /// The body a press sends: the request it answers, the seal — the request's own, or the one
    /// standing now when nobody asked — and the gaps the card showed.
    public static func body(subject: ProjectDoneSubject, requestID: String?, request: DoneRequest?,
                            currentDigest: String?) -> ProjectDoneRequestBody? {
        guard let digest = request?.criteriaDigest ?? currentDigest else { return nil }
        return ProjectDoneRequestBody(requestId: requestID, criteriaDigest: digest,
                                      acceptedGaps: gaps(subject, request: request))
    }

    /// The note "Not yet…" sends, or nil while there is nothing in it.
    public static func declineNote(_ text: String) -> String? {
        let note = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return note.isEmpty ? nil : note
    }

    // MARK: whether it is asked

    /// The request this project is asked about right now: its open `DONE_REQUEST`, with a request
    /// this build can read, while the project is OPEN. Nil otherwise — including while the read has
    /// not answered, which is not a request.
    public static func live(openItems: ProjectOpenItemsView?, status: String?) -> ProjectOpenItemRow? {
        guard status == "OPEN", let row = openItems?.doneRequest, row.doneRequest != nil else { return nil }
        return row
    }

    /// The request's row on the project page: who asked, and how many gaps it could not prove —
    /// "The coordinator asked · 2 gaps it couldn’t prove".
    public static func requestRowDetail(_ row: ProjectOpenItemRow) -> String {
        guard let request = row.doneRequest else { return row.detailLine }
        return "\(coordinatorAsked) · \(request.gaps.count) \(gapsItCouldntProve)"
    }

    /// What the done row in a project's Open items is: the coordinator's request, the owner's own
    /// Record as done…, or nothing. The owner's own row needs a current server's projection (its
    /// counts) — on an older one the page keeps the status door it had — and the open-items read to
    /// have answered: a request still on its way is not a project nobody asked about.
    public enum PageRow: Equatable, Sendable {
        case asked(ProjectOpenItemRow)
        case own

        /// The coordinator's request, when the row is one — what Open items counts as needing you.
        public var request: ProjectOpenItemRow? {
            if case .asked(let row) = self { return row }
            return nil
        }
    }

    public static func pageRow(status: ProjectStatus, derivedDone: ProjectDerivedDone?,
                               openItems: ProjectOpenItemsView?) -> PageRow? {
        guard status == .open, derivedDone?.counts != nil, let openItems else { return nil }
        if let row = openItems.doneRequest, row.doneRequest != nil { return .asked(row) }
        return .own
    }

    /// Whether the page says Ready to close beside the status: an OPEN project its coordinator has
    /// asked to have recorded done.
    public static func readyToClose(status: ProjectStatus, openItems: ProjectOpenItemsView?) -> Bool {
        live(openItems: openItems, status: status.rawValue) != nil
    }

    // MARK: which card a coordinator conversation draws

    /// The one settlement card a coordinator conversation draws for its project — web's
    /// `SessionProjectSettlementCard`, read off the same reads.
    public enum Slot: Equatable, Sendable {
        /// Nothing: not this project's coordinator, a read that has not answered, or a server whose
        /// projection carries no counts.
        case none
        /// "Why is this project not done?" — an OPEN, started project with criteria to be done
        /// against, that the projection does not call done and nobody has asked to record
        /// (`asksWhyNotDone`).
        case notDone
        /// "Is this project done?" — asked by the request named (nil when the owner is reminded
        /// without one) — or, once it is recorded, its receipt.
        case done(requestID: String?)
    }

    public static func slot(subject: ProjectDoneSubject?, request: ProjectOpenItemRow?,
                            waitingKind: SessionWaitingKind?, record: ProjectDoneRecord?,
                            started: Bool?) -> Slot {
        guard let subject, subject.counts != nil else { return .none }
        if request != nil || waitingKind == .recordAsDone || recorded(subject, record: record) {
            return .done(requestID: request?.itemId)
        }
        guard subject.status == "OPEN", started == true,
              !(subject.derivedDone?.criteria ?? []).isEmpty else { return .none }
        return .notDone
    }

    // MARK: the Why-not-done card

    /// The card's two groups, read off each criterion's own answer: what is still work, and what
    /// only the owner can call (`ProjectWhyNotDoneCard`).
    public struct WhyNotDone: Equatable, Sendable {
        /// What the card's button is.
        public enum Action: Equatable, Sendable {
            /// The coordinator asked: open "Is this project done?".
            case review
            /// Nobody has the work: hand the card's facts to the coordinator.
            case askCoordinator
        }

        /// Unmet criteria, and met ones whose work is still on its way to main.
        public let waiting: [ProjectDoneCriterion]
        /// Met criteria Orbit saw no merge for.
        public let needsCall: [ProjectDoneCriterion]
        /// Whether somebody is already on the work: a landing in flight, or the coordinator holding
        /// open items.
        public let coordinatorOnIt: Bool
        /// Whether the coordinator has asked to record the project done.
        public let requested: Bool

        public init(subject: ProjectDoneSubject, withCoordinator: Int, requested: Bool) {
            let criteria = subject.derivedDone?.criteria ?? []
            // An unmet criterion is still work even when its landing says CODELESS or
            // NOTHING_TO_LAND: those are outcomes only once the criterion itself is met.
            waiting = criteria.filter { !$0.satisfied || ProjectDone.isWaitingOnWork($0.landingReason) }
            needsCall = criteria.filter { $0.satisfied && ProjectDone.isNeedsYourCall($0.landingReason) }
            // An in-flight landing already has an owner in the integration lane.
            let onlyInFlight = !waiting.isEmpty && waiting.allSatisfy { $0.landingReason == .inFlight }
            coordinatorOnIt = onlyInFlight || withCoordinator > 0
            self.requested = requested
        }

        public var hasGaps: Bool { !waiting.isEmpty || !needsCall.isEmpty }

        /// Whether the card is the settled one: no gap left, and the projection says done.
        public func settled(_ subject: ProjectDoneSubject) -> Bool {
            !hasGaps && subject.derivedDone?.done == true
        }

        /// The one button: Review while asked, Ask the coordinator while work has nobody on it.
        public var action: Action? {
            if requested { return .review }
            if !waiting.isEmpty && !coordinatorOnIt { return .askCoordinator }
            return nil
        }

        /// Whether the actions row says who has the work instead.
        public var saysCoordinatorIsOnIt: Bool { !waiting.isEmpty && coordinatorOnIt }
    }

    /// The Needs your call group's aside: "the coordinator asked · waiting 25m".
    public static func askedAside(waiting: String?) -> String {
        ([coordinatorAsked.lowercased()] + [waiting].compactMap { $0 }).joined(separator: " · ")
    }

    /// One Why-not-done row's state: the landing reason of a met criterion, and "Not met yet" for
    /// one whose work has not met it — not its landing lane, which for unfinished work describes
    /// nothing that happened (no receipt, no code to land).
    public static func rowState(_ criterion: ProjectDoneCriterion) -> String {
        criterion.satisfied ? landingReasonLabel(criterion.landingReason) : notMetYet
    }

    /// …and its detail, by the group it is in.
    public static func rowDetail(_ criterion: ProjectDoneCriterion, waitingOnWork: Bool) -> String {
        guard criterion.satisfied else { return notMetDetail }
        return waitingOnWork ? waitingDetail : needsCallDetail
    }

    /// The settled card's badge: who recorded it.
    public static func settledBadge(_ doneBy: ProjectDoneBy?) -> String {
        doneBy == .owner ? recordedByYou : recordedByOrbit
    }

    // MARK: Ask the coordinator to handle it

    /// The rule the projection holds the project to (`SETTLEMENT_RULE` in `ProjectSettlementCard.tsx`).
    public static let settlementRule =
        "Orbit records a project done by itself — no press, no agent — when every stated criterion is "
        + "met by work that has landed and counts, under a criteria set you have confirmed."

    /// `settlementExplains`: the rule, and how many of its clauses do not hold.
    public static func settlementExplains(_ withheld: [String]) -> String {
        let n = withheld.count
        return "\(settlementRule) \(n == 1 ? "One of those does not hold here." : "\(n) of those do not hold here.")"
    }

    /// `settlementCriterionFacts`: "Settled · No receipt".
    public static func settlementCriterionFacts(_ criterion: ProjectDoneCriterion) -> String {
        let settlement = criterion.satisfied ? "Settled" : "Not settled"
        let landing: String
        switch criterion.landing {
        case "LANDED":              landing = "Landed"
        case "ON_INTEGRATION_LINE": landing = "On the integration line"
        default:                    landing = "No receipt"
        }
        return "\(settlement) · \(landing)"
    }

    /// `settlementClearsIt`: what would clear a clause, where there is a sentence for it.
    public static func settlementClearsIt(_ clause: String) -> String? {
        switch clause {
        case "NO_CRITERIA_STATED":
            return "state what this project is for, as criteria the work can be measured against"
        case "CRITERION_UNSATISFIED":
            return "finish the work each criterion is measured by, and let it settle in its own session"
        case "CRITERION_UNLANDED":
            return "land the branch, or record the merge with merge_receipt where it happened outside "
                + "Orbit"
        default:
            return nil
        }
    }

    /// `projectSettlementContext`: the card's own facts, as the one turn "Ask the coordinator to
    /// handle it" sends — the blocked criteria, what each is waiting on, and what would clear them.
    public static func settlementContext(_ subject: ProjectDoneSubject) -> String {
        let projection = subject.derivedDone
        let items = subject.criteria.sorted { $0.ordinal < $1.ordinal }.map { "\($0.ordinal). \($0.text)" }
        let blocked: [String] = (projection?.criteria ?? []).compactMap { criterion in
            guard !criterion.withheld.isEmpty else { return nil }
            let ordinal = subject.criteria.first { $0.id == criterion.definitionId }?.ordinal ?? 0
            let words = items.first { $0.hasPrefix("\(ordinal).") }
            return "- \(words ?? criterion.definitionId) — \(settlementCriterionFacts(criterion))"
                + " (blocked by \(criterion.withheld.joined(separator: ", ")))"
        }
        let clears = (projection?.withheld ?? []).compactMap(settlementClearsIt)
        let blockedLines = blocked.isEmpty ? "(no criterion is individually blocked)"
                                           : blocked.joined(separator: "\n")
        let clearLines = clears.isEmpty ? "(see the card)"
                                        : clears.map { "- \($0)" }.joined(separator: "\n")
        return "About “\(subject.title)” — Orbit has not recorded it done. "
            + "\(settlementExplains(projection?.withheld ?? []))\n\nBlocked:\n\(blockedLines)\n\n"
            + "What Orbit says would clear it:\n\(clearLines)"
    }
}
