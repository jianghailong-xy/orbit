import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE TWO CARDS A PROJECT'S RULER IS MOVED FROM — THE OTHER HALF OF WEB'S
   `CriteriaDecisionCard.tsx` AND OF `AcceptanceConfirmationCard.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   WHAT THESE TWO QUESTIONS ARE, AND WHY THEY ARE NOT APPROVALS
   ------------------------------------------------------------
   A project's acceptance criteria may only walk toward strictness on their own. A LOOSENING edit
   does not take effect: it is held as one proposal for the account owner to decide (the weakening
   card), and a project is not settled until the same person has confirmed that the set as it
   stands is what "done" means here (the confirmation card).

   Neither is an `Approval` row, so neither arrives through `PendingApproval` and neither stops a
   turn. They are STANDING QUESTIONS derived from the server on every read — which is the whole
   design and the reason this file exists at all:

     * `GET /projects/:id/acceptance/criteria-decisions/pending` publishes the proposals still
       waiting, each carrying the one-time `commitToken` that answers it. The token reaches the
       account owner's client and nothing else: the session that filed the proposal is never given
       it, which is what makes the button an authorisation rather than a claim.
     * `GET /projects/:id/acceptance/confirmation` publishes which version of the standard set was
       confirmed, and whether that is still the version in force.

   NOTHING IS FROZEN INTO THE CARD EXCEPT THE ADDRESS
   --------------------------------------------------
   A delivered card lives in a transcript for as long as the conversation does, and the question it
   was about can be answered in the browser, displaced by a newer proposal, or stranded by a ruler
   that moved underneath it. So a card keeps ONE thing across renders — the proposal's id — and
   re-derives everything else from the read. `CriteriaDecisions.standing` is the whole of that: the
   ways a card goes stale are conclusions about the derived read rather than local state somebody
   has to remember to clear. A consequence worth stating because it looks like a bug: a stale card
   shows NO diff. The read stops publishing a settled or displaced proposal and this card kept no
   copy, which is the property being bought. What the read does publish about an answered proposal
   is the answer (`settled`: the outcome and its two seals), so a card answered at another end says
   which answer it was given — still keeping nothing but the address.

   ONE SOURCE FOR TWO CLIENTS
   --------------------------
   The derivation, the standings and every visible word are here so macOS, iOS and the browser
   cannot come apart on them, and so they can be tested on Linux where no SwiftUI exists. The
   mirror is `src/web/src/components/CriteriaDecisionCard.tsx` (filed under the same project
   criterion as this file) — the strings below are copied from it deliberately, the way
   `EvidenceDecisions` copies `EvidenceDecisionCard`'s. That file is on main now, so the copy is no
   longer on trust: `CriteriaDecisionCopyParityTests` reads it and compares the headings, the two
   actions, the paragraphs — what a card answered at another end says among them — and the two
   refusal codes, and a counterpart it cannot find is a FAILURE rather than a skip. What it does not
   compare is the title, the badge and the spelling of the provenance mark: those differ by end on
   purpose, for the reason the next section gives.

   WHAT THE PHONE SAYS DIFFERENTLY, AND WHY
   ----------------------------------------
   Two things, both about width rather than about meaning. The card's TITLE is a short question
   ("Weaken this ruler?") where the browser's heading is a sentence: an iOS card header is one line
   beside a badge, and the sentence is on the card either way — as the state line under it. And the
   provenance mark rides the META line rather than the badge slot: the badge is what truncates when
   a header runs long (`ApprovalHeader` gives the title `layoutPriority(1)`, and truncates the
   badge in the MIDDLE), so `FROM ORBIT` would arrive as `FR…IT`, which says nothing at all.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire: held weakening proposals

/// One criterion as the proposal states it. `id` is null for one the proposal is ADDING.
///
/// This is the material the proposal's `actionDigest` is taken over, so it is the request VERBATIM
/// and has to stay recomputable from it — which is exactly why it cannot say what changed. The
/// answer to that question is `PendingCriteriaDecisionRow.diff` below.
public struct ProposedCriterion: Codable, Equatable, Sendable, Identifiable {
    public let id: String?
    public let ordinal: Int
    public let text: String
    public let verificationMethod: String
    /// The reason the proposer gave, when the edit carried one. Null far more often than not.
    public let completionCriterionOverrideReason: String?

    public init(id: String?, ordinal: Int, text: String, verificationMethod: String,
                completionCriterionOverrideReason: String? = nil) {
        self.id = id
        self.ordinal = ordinal
        self.text = text
        self.verificationMethod = verificationMethod
        self.completionCriterionOverrideReason = completionCriterionOverrideReason
    }
}

/// WHAT A PROPOSAL DOES TO ONE CRITERION — THE SERVER'S COMPARISON, NOT THIS CLIENT'S
///
/// A criteria edit is a whole-collection replacement, so a proposal that reworded three criteria
/// out of eight arrives stating all eight, and five of them are the words already on record. This
/// card used to lay out all eight; the three that moved were buried in the other five, and the
/// account owner's words after reading the first real one were "it should only show what changed".
///
/// The comparison is taken by `readPendingCriteriaDecisions`, inside the transaction that decided
/// which proposals are pending, against the definition rows the seal is computed from. A client
/// that fetched the criteria in force and diffed them itself would be making the card's central
/// claim a conclusion IT reached, from two reads taken at two moments, in every client separately.
public enum CriteriaProposalChange: String, Codable, Equatable, Sendable {
    case same = "SAME"
    case changed = "CHANGED"
    case new = "NEW"
    case removed = "REMOVED"
}

/// The fields a rewrite can move: all three a criterion carries, not just the assertion. An edit
/// that leaves `text` alone and rewrites `verificationMethod` has still changed what the project
/// has to prove.
public enum CriteriaProposalField: String, Codable, Equatable, Sendable {
    case text
    case verificationMethod
    case completionCriterionOverrideReason
}

/// One criterion's words, on either side of the comparison.
public struct CriterionWording: Codable, Equatable, Sendable {
    public let text: String
    public let verificationMethod: String?
    public let completionCriterionOverrideReason: String?

    public init(text: String, verificationMethod: String? = nil,
                completionCriterionOverrideReason: String? = nil) {
        self.text = text
        self.verificationMethod = verificationMethod
        self.completionCriterionOverrideReason = completionCriterionOverrideReason
    }
}

/// What a rewrite does with one run of a field it moved — the SERVER's cut of the two versions.
///
/// Saying which criteria moved was only half of it: a rewrite still arrived as two whole
/// paragraphs, and finding the clause that changed inside ninety characters of Chinese was left to
/// the reader. So the comparison is taken down to the level the change happened at, and it is
/// taken on the server for the same reason the criterion-level one is — a client cutting the two
/// texts itself would be reaching the card's central claim on its own, twice, in two languages.
///
/// The runs are in reading order and one merged sequence: the words ON RECORD are the `.kept` and
/// `.removed` runs, the words PROPOSED are the `.kept` and `.added` ones. One line renders both.
public enum CriterionSegmentSide: String, Codable, Equatable, Sendable {
    case kept = "KEPT"
    case removed = "REMOVED"
    case added = "ADDED"
}

public struct CriterionSegment: Codable, Equatable, Sendable {
    public let side: CriterionSegmentSide
    public let text: String

    public init(side: CriterionSegmentSide, text: String) {
        self.side = side
        self.text = text
    }
}

/// One field of a rewrite, cut up. One per entry in `changed`, in that same order.
public struct CriterionFieldRewrite: Codable, Equatable, Sendable {
    public let field: CriteriaProposalField
    public let segments: [CriterionSegment]

    public init(field: CriteriaProposalField, segments: [CriterionSegment]) {
        self.field = field
        self.segments = segments
    }
}

/// What this proposal does to one criterion: which one, which way, and both sets of words.
public struct CriteriaProposalChangeEntry: Codable, Equatable, Sendable {
    public let change: CriteriaProposalChange
    /// The definition this is about; nil for one the proposal is adding, which names none.
    public let definitionId: String?
    /// Its place in the proposed set — or, for one being dropped, in the set on record.
    public let ordinal: Int
    /// The proposal's words. Nil for `.removed`: the proposal states none.
    public let proposed: CriterionWording?
    /// THE WORDS IT REPLACES, off the definition in force. Nil for `.new`: it replaces nothing.
    public let onRecord: CriterionWording?
    /// Which fields differ. Empty except on `.changed`.
    public let changed: [CriteriaProposalField]
    /// Each of those fields cut into what the rewrite keeps, drops and adds, in `changed` order.
    public let rewrites: [CriterionFieldRewrite]

    public init(change: CriteriaProposalChange, definitionId: String? = nil, ordinal: Int,
                proposed: CriterionWording? = nil, onRecord: CriterionWording? = nil,
                changed: [CriteriaProposalField] = [],
                rewrites: [CriterionFieldRewrite] = []) {
        self.change = change
        self.definitionId = definitionId
        self.ordinal = ordinal
        self.proposed = proposed
        self.onRecord = onRecord
        self.changed = changed
        self.rewrites = rewrites
    }

    /// Decoded by hand for one field, so that a server WITHOUT the cut is an entry without one
    /// rather than a queue that fails to decode.
    ///
    /// This client and the API do not ship together — an App Store build outlives several
    /// deployments — so `rewrites` is absent from every response an apiserver older than it gives.
    /// A synthesised default is what keeps that a card drawn at coarse resolution
    /// (`changeRows` falls back to the two versions whole) instead of no card at all.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        change = try values.decode(CriteriaProposalChange.self, forKey: .change)
        definitionId = try values.decodeIfPresent(String.self, forKey: .definitionId)
        ordinal = try values.decode(Int.self, forKey: .ordinal)
        proposed = try values.decodeIfPresent(CriterionWording.self, forKey: .proposed)
        onRecord = try values.decodeIfPresent(CriterionWording.self, forKey: .onRecord)
        changed = try values.decodeIfPresent([CriteriaProposalField].self, forKey: .changed) ?? []
        rewrites = try values.decodeIfPresent(
            [CriterionFieldRewrite].self, forKey: .rewrites) ?? []
    }
}

/// The whole of what a proposal would do to the ruler, and how much of it it leaves alone.
///
/// `sameCount` is what licenses a card to fold the untouched ones away, and it is a number the
/// SERVER said rather than one a collapsed list implies — otherwise "5 unchanged" would be a claim
/// about how many rows this client chose not to draw.
public struct CriteriaProposalDiff: Codable, Equatable, Sendable {
    public let entries: [CriteriaProposalChangeEntry]
    public let sameCount: Int
    public let changedCount: Int
    public let newCount: Int
    public let removedCount: Int

    public init(entries: [CriteriaProposalChangeEntry] = [], sameCount: Int = 0,
                changedCount: Int = 0, newCount: Int = 0, removedCount: Int = 0) {
        self.entries = entries
        self.sameCount = sameCount
        self.changedCount = changedCount
        self.newCount = newCount
        self.removedCount = removedCount
    }

    /// What a proposal nothing could be read out of carries: no entries, and so no counts.
    public static let unreadable = CriteriaProposalDiff()
}

/// Whether the decision door would record an answer about this proposal right now — the SERVER's
/// answer, carried on the row so a client never decides for itself whether a button would work.
public struct CriteriaDecisionDecidability: Codable, Equatable, Sendable {
    public let decidable: Bool
    /// The door's own refusal code, nil when decidable.
    public let refusal: String?
    /// What would clear it, in the vocabulary the refusal carries.
    public let requiredAction: String?

    public init(decidable: Bool, refusal: String? = nil, requiredAction: String? = nil) {
        self.decidable = decidable
        self.refusal = refusal
        self.requiredAction = requiredAction
    }
}

/// One held proposal as the ACCOUNT OWNER reads it.
///
/// `commitToken` is on the owner's read of this row and on no other: it is the proposal's one-time
/// key, and the session that filed the proposal is never handed it.
public struct PendingCriteriaDecisionRow: Codable, Equatable, Sendable, Identifiable {
    public let intentId: String
    public let projectId: String
    public let commitToken: String
    public let actionDigest: String
    /// ISO-8601, as JSON carries it. Never parsed here — `ageSeconds` is the server's clock.
    public let filedAt: String
    public let ageSeconds: Int
    /// The seal of the standard set this proposal was composed against.
    public let baselineSeal: String
    /// The seal standing NOW. Equal to `baselineSeal` exactly when the proposal is decidable.
    public let currentSeal: String
    public let proposed: [ProposedCriterion]
    /// The same restatement read against the criteria in force — what the card is drawn from.
    public let diff: CriteriaProposalDiff
    /// The proposal this one displaced, or nil when it displaced nothing.
    public let supersededIntentId: String?
    public let decidability: CriteriaDecisionDecidability

    public var id: String { intentId }

    public init(intentId: String, projectId: String, commitToken: String, actionDigest: String,
                filedAt: String, ageSeconds: Int, baselineSeal: String, currentSeal: String,
                proposed: [ProposedCriterion], diff: CriteriaProposalDiff = .unreadable,
                supersededIntentId: String? = nil,
                decidability: CriteriaDecisionDecidability) {
        self.intentId = intentId
        self.projectId = projectId
        self.commitToken = commitToken
        self.actionDigest = actionDigest
        self.filedAt = filedAt
        self.ageSeconds = ageSeconds
        self.baselineSeal = baselineSeal
        self.currentSeal = currentSeal
        self.proposed = proposed
        self.diff = diff
        self.supersededIntentId = supersededIntentId
        self.decidability = decidability
    }
}

/// One proposal the read says WAS answered: which answer, and what it did to the seal.
///
/// Only the card whose button was pressed is handed the door's response. Every other card for the
/// same proposal went stale knowing only that somebody had answered — which is what the account
/// owner met on 2026-09-11, refusing in a browser and finding the phone's card dimmed with no way to
/// tell which answer it had been given. The answer is a committed row, so it arrives on the same
/// derived read as the rest of the card. It is the outcome and the two seals, never the proposal's
/// words: a stale card still shows no diff.
public struct SettledCriteriaDecision: Codable, Equatable, Sendable {
    public let intentId: String
    public let decision: CriteriaDecisionAnswer
    /// ISO-8601, as JSON carries it. Never parsed here.
    public let decidedAt: String
    /// The seal the answer was given against.
    public let baseSeal: String
    /// The seal standing afterwards: `baseSeal` again for a refusal, moved by an approval.
    public let resultingSeal: String

    public init(intentId: String, decision: CriteriaDecisionAnswer, decidedAt: String,
                baseSeal: String, resultingSeal: String) {
        self.intentId = intentId
        self.decision = decision
        self.decidedAt = decidedAt
        self.baseSeal = baseSeal
        self.resultingSeal = resultingSeal
    }
}

/// Every proposal of one project that is still a question, oldest first.
public struct PendingCriteriaDecisionQueue: Codable, Equatable, Sendable {
    public let readAt: String
    public let projectId: String
    public let count: Int
    public let oldestAgeSeconds: Int?
    /// How many of them a decision could actually be recorded on today.
    public let decidableCount: Int
    public let pending: [PendingCriteriaDecisionRow]
    /// The proposals most recently ANSWERED, newest first — what a card that stopped being a
    /// question says happened to it. Empty from a server older than this build.
    public let settled: [SettledCriteriaDecision]

    public init(readAt: String, projectId: String, count: Int, oldestAgeSeconds: Int? = nil,
                decidableCount: Int, pending: [PendingCriteriaDecisionRow],
                settled: [SettledCriteriaDecision] = []) {
        self.readAt = readAt
        self.projectId = projectId
        self.count = count
        self.oldestAgeSeconds = oldestAgeSeconds
        self.decidableCount = decidableCount
        self.pending = pending
        self.settled = settled
    }

    /// Decoded by hand for one field, for `CriteriaProposalChangeEntry`'s reason: this client and
    /// the API do not ship together, so `settled` is absent from every response an apiserver older
    /// than this build gives — and that is a card saying only that it was answered, never a queue
    /// that fails to decode.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        readAt = try values.decode(String.self, forKey: .readAt)
        projectId = try values.decode(String.self, forKey: .projectId)
        count = try values.decode(Int.self, forKey: .count)
        oldestAgeSeconds = try values.decodeIfPresent(Int.self, forKey: .oldestAgeSeconds)
        decidableCount = try values.decode(Int.self, forKey: .decidableCount)
        pending = try values.decode([PendingCriteriaDecisionRow].self, forKey: .pending)
        settled = try values.decodeIfPresent([SettledCriteriaDecision].self, forKey: .settled) ?? []
    }
}

/// The two answers the door takes. There is deliberately no third that leaves it pending.
public enum CriteriaDecisionAnswer: String, Codable, Equatable, Sendable {
    case approve = "APPROVE"
    case reject = "REJECT"
}

/// The body one press sends. Three bindings and they are not the same kind of thing: `commitToken`
/// says WHAT is being decided, the credential the request carries says WHO decided, and `baseSeal`
/// says WHEN — the version this answer was composed against, which the door refuses separately.
public struct CriteriaDecisionRequest: Codable, Equatable, Sendable {
    public let commitToken: String
    public let decision: CriteriaDecisionAnswer
    public let baseSeal: String

    public init(commitToken: String, decision: CriteriaDecisionAnswer, baseSeal: String) {
        self.commitToken = commitToken
        self.decision = decision
        self.baseSeal = baseSeal
    }
}

/// What the door returns once it has answered one — read back, never recomputed by a client.
public struct CriteriaDecisionResult: Codable, Equatable, Sendable {
    public let intentId: String
    public let decision: CriteriaDecisionAnswer
    public let decidedAt: String
    public let baseSeal: String
    public let resultingSeal: String
    /// True for an APPROVE and only an APPROVE: whether any criterion actually moved.
    public let applied: Bool

    public init(intentId: String, decision: CriteriaDecisionAnswer, decidedAt: String,
                baseSeal: String, resultingSeal: String, applied: Bool) {
        self.intentId = intentId
        self.decision = decision
        self.decidedAt = decidedAt
        self.baseSeal = baseSeal
        self.resultingSeal = resultingSeal
        self.applied = applied
    }
}

// MARK: - the wire: the owner's confirmation of the standard set

/// One criterion as a confirmation names it: the three values the set's digest is taken over.
public struct ConfirmedCriterionVersion: Codable, Equatable, Sendable {
    public let definitionId: String
    public let revision: Int
    public let contentHash: String

    public init(definitionId: String, revision: Int, contentHash: String) {
        self.definitionId = definitionId
        self.revision = revision
        self.contentHash = contentHash
    }
}

/// A version of the whole stated set: `digest` answers "is it still this one", `material` answers
/// "which one was it".
public struct StandardSetVersion: Codable, Equatable, Sendable {
    public let digest: String
    public let material: [ConfirmedCriterionVersion]

    public init(digest: String, material: [ConfirmedCriterionVersion]) {
        self.digest = digest
        self.material = material
    }
}

/// One recorded exercise of `CONFIRM_ACCEPTANCE_CRITERIA`.
public struct RecordedStandardSetConfirmation: Codable, Equatable, Sendable {
    public let criteriaDigest: String
    public let criteriaMaterial: [ConfirmedCriterionVersion]
    public let confirmedAt: String
    public let confirmedById: String

    public init(criteriaDigest: String, criteriaMaterial: [ConfirmedCriterionVersion],
                confirmedAt: String, confirmedById: String) {
        self.criteriaDigest = criteriaDigest
        self.criteriaMaterial = criteriaMaterial
        self.confirmedAt = confirmedAt
        self.confirmedById = confirmedById
    }
}

/// `GET /projects/:id/acceptance/confirmation`, as the server reports it. Three states rather than
/// a boolean because "nobody ever said this" and "somebody said it about wording that has since
/// changed" are different things to show, and only the second has a version to print.
public struct StandardSetConfirmationStanding: Codable, Equatable, Sendable {
    public enum State: String, Codable, Equatable, Sendable {
        case unconfirmed = "UNCONFIRMED"
        case confirmed = "CONFIRMED"
        case stale = "STALE"
    }

    public let state: State
    public let confirmed: Bool
    public let currentVersion: StandardSetVersion
    public let confirmation: RecordedStandardSetConfirmation?

    public init(state: State, confirmed: Bool, currentVersion: StandardSetVersion,
                confirmation: RecordedStandardSetConfirmation? = nil) {
        self.state = state
        self.confirmed = confirmed
        self.currentVersion = currentVersion
        self.confirmation = confirmation
    }
}

/// The parts of `GET /projects/:id` the confirmation card reads: the criteria it is asking about.
/// A narrow view of a wide document on purpose — this client has no project screen, and the card
/// must not become a reason to grow one.
public struct ProjectCriteriaDocument: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let ordinal: Int
        public let text: String
        /// Whether the WORK serving this criterion has met it. Absent when the read declined to
        /// answer, which is a third state and never merged with "no".
        public let satisfied: Bool?

        public init(id: String, ordinal: Int, text: String, satisfied: Bool? = nil) {
            self.id = id
            self.ordinal = ordinal
            self.text = text
            self.satisfied = satisfied
        }
    }

    public let id: String
    public let acceptanceCriteriaItems: [Item]?
    /// What the confirmation card's meta line names this project by. Optional: a server older than
    /// this build answers the same read without it, and the id is then what the card says.
    public let title: String?
    /// The status the confirmation card's own condition turns on — a project that is not OPEN is
    /// not one anybody is about to start.
    public let status: String?
    /// Whether Orbit is handing this project's tasks out: the one column that decides it, and what
    /// the confirmation card's meta line reads "started" off. This read is `GET /projects/:id`,
    /// which carries the column already, so that field costs the card no request of its own.
    /// Optional — a read that did not say is not a "no", which is the one thing it must never be
    /// read as.
    public let coordinatorEnabled: Bool?
    /// The endpoint's own `_count`, decoded under the name the other payloads give it.
    public let counts: ProjectTaskCounts?
    /// How many tasks the project holds — what the confirmation card's condition asks before it
    /// offers to start anything, because "Start the project" is a verb and this is its object.
    /// `_count.tasks` is everything filed under the project, settled work included: whether any of
    /// it MAY run is the dispatcher's question, and the card's is whether there is any at all.
    ///
    /// A read that did not say is read as NONE, which is where this parts company with
    /// `coordinatorEnabled` above: that one LABELS the project and has a third word for a read that
    /// did not answer, while this one GATES an action — and a gate nobody can establish stays shut,
    /// the same rule `AcceptanceConfirmations.answerable` keeps for a standing it does not have.
    public var taskCount: Int { counts?.tasks ?? 0 }

    public init(id: String, acceptanceCriteriaItems: [Item]? = nil,
                title: String? = nil, status: String? = nil,
                coordinatorEnabled: Bool? = nil, counts: ProjectTaskCounts? = nil) {
        self.id = id
        self.acceptanceCriteriaItems = acceptanceCriteriaItems
        self.title = title
        self.status = status
        self.coordinatorEnabled = coordinatorEnabled
        self.counts = counts
    }

    enum CodingKeys: String, CodingKey {
        case id, acceptanceCriteriaItems, title, status, coordinatorEnabled
        case counts = "_count"
    }
}

/// `_count` on the project document, decoded the way `TaskListSummary` decodes its own.
public struct ProjectTaskCounts: Codable, Equatable, Sendable {
    public let tasks: Int?

    public init(tasks: Int? = nil) {
        self.tasks = tasks
    }
}

// MARK: - where one delivered proposal stands right now

/// The five shapes a delivered proposal can be in. Four are states of the PROPOSAL, read off the
/// queue; `unread` is a state of this CLIENT and gets the same treatment for the same reason — a
/// card that cannot re-derive itself has no idea whether the door would accept anything.
public struct CriteriaDecisionStanding: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// The row is in the read and the server says the door would take an answer.
        case decidable(PendingCriteriaDecisionRow)
        /// The row is in the read and the server says it would not: the ruler this proposal was
        /// composed against is not the one in force. Returned precisely so it can be explained.
        case baseSealMoved(PendingCriteriaDecisionRow)
        /// The row is gone AND a proposal still pending names it as the one it displaced. Read off
        /// the supersession link rather than off timestamps, for the same reason the server does:
        /// two proposals can share a moment.
        case superseded(replacement: PendingCriteriaDecisionRow)
        /// The row is gone and somebody answered it — with the answer when the read names it, and
        /// nil when it does not (a server older than this build, or an answer older than the ones
        /// the read carries), which is a card that can say only that it was answered.
        case alreadySettled(SettledCriteriaDecision?)
        /// The read has not come back.
        case unread
    }

    public let intentId: String
    public let state: State

    public init(intentId: String, state: State) {
        self.intentId = intentId
        self.state = state
    }

    /// The row this card is rendering, or nil when the read no longer publishes one. A stale card
    /// has no proposal to show: see the file header.
    public var row: PendingCriteriaDecisionRow? {
        switch state {
        case .decidable(let row), .baseSealMoved(let row): return row
        case .superseded, .alreadySettled, .unread: return nil
        }
    }

    /// Whether the door would take an answer to this card: true for exactly one of the five.
    public var answerable: Bool {
        if case .decidable = state { return true }
        return false
    }
}

// MARK: - the logic and the words

public enum CriteriaDecisions {

    // MARK: copy

    /// The mark, and the reason it exists. The whole security argument is that THIS CARD IS NOT
    /// THE AGENT'S TYPING: a transcript is where an agent's words appear, and an agent can write a
    /// paragraph that reads exactly like a decision card. On a phone this rides the meta line —
    /// see the file header for why it may not ride the badge.
    public static let provenanceLabel = "From Orbit"
    public static let provenanceNote = "not the requesting agent"

    /// The card's title: a question, in one line, beside the badge. The browser's longer heading is
    /// carried by `stateLine` below, so nothing it says is lost.
    public static let title = "Weaken this ruler?"

    /// The badge slot. Short by construction — `ApprovalHeader` truncates the badge and never the
    /// title — and it says which of the five states the reader is looking at, because a card that
    /// looks identical whether or not it can be answered is the trap the disabled buttons exist to
    /// close.
    public static let liveBadge = "criteria"

    /// Web's three headings, said here as the line under the title.
    public static let liveHeading = "A weakening change to this project’s ruler needs your decision"
    public static let staleHeading = "This decision is no longer yours to make"
    public static let unreadHeading = "This card could not be re-read just now"
    /// The two that stand in for `staleHeading` once the read names the answer given at another
    /// end — the verdict first, because "which was it?" is the question a dimmed card was left
    /// unable to answer.
    public static let refusedHeading = "Refused at another end — the ruler did not move"
    public static let approvedHeading = "Approved at another end — the ruler moved"

    public static let approveLabel = "Approve & re-seal"
    public static let refuseLabel = "Refuse"

    /// What is NOT at stake, said on the card because it is the thing readers get wrong. A held
    /// proposal changes nothing while it is held, so refusing stops the ruler from moving and stops
    /// nothing else — which is what makes `Refuse` an ordinary answer rather than a way of blocking
    /// somebody's work.
    public static let nothingIsOnHold =
        "Nothing is on hold. The criteria on record are the ones in force and the session that "
        + "proposed this was told to keep working against them, so refusing stops the ruler from "
        + "moving, not the work."

    /// What a stale card has instead of the proposal it was asking about.
    public static let goneBody =
        "This card holds the proposal’s address and nothing else — what it was asking about is no "
        + "longer published by the pending read."

    /// The door's refusal codes, in the door's spelling, so a card can say which one it would meet.
    public static let baseSealMovedRefusal = "PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED"
    public static let alreadySettledRefusal = "PROJECT_CRITERIA_DECISION_ALREADY_SETTLED"

    // MARK: copy — the diff

    /// One vocabulary for the three things a proposal can do to a criterion, so the badge on a row
    /// and the one-line summary above the list say the same word about the same thing. Compared
    /// against the browser's declarations by `CriteriaDecisionCopyParityTests`.
    public static let rewordedWord = "reworded"
    public static let droppedWord = "dropped"
    public static let addedWord = "added"

    /// The badge on one row of the diff.
    public static let rewordedLabel = "reworded by this proposal"
    public static let addedLabel = "new in this proposal"
    public static let droppedLabel = "dropped by this proposal"

    /// WHAT THE TWO MARKS ON A REWRITTEN LINE MEAN, SPELLED OUT ONCE.
    ///
    /// A rewrite used to be two paragraphs, the second labelled `on record now`, and that label
    /// was the whole of how a reader knew which half was which. It is one line now — the words
    /// that stayed, with the dropped run struck through and the new run underlined in place — so
    /// the label has nothing left to point at and this legend takes its job. Without it the marks
    /// are decoration, and on a phone they are the only thing telling the two apart.
    public static let inlineDiffLegend = "struck through is dropped · underlined is added"
    /// The second field, shown only when the proposal moved it.
    public static let methodLabel = "how it is judged"

    /// The line that says how much of the ruler this proposal leaves alone.
    ///
    /// IT IS WHY THE UNTOUCHED ONES ARE FOLDED AND NOT HIDDEN. The question this card answers is
    /// not only "what changed" but "how much of the ruler is being rewritten" — three rows and
    /// nothing else cannot tell a proposal that reworded three criteria from one that replaced the
    /// whole set with three.
    public static let unchangedSuffixOne = "criterion is unchanged by this proposal"
    public static let unchangedSuffixMany = "criteria are unchanged by this proposal"

    /// What a proposal nothing could be read out of says instead of a diff, and what a restatement
    /// that moved nothing says — every criterion came back word for word.
    public static let changeSummaryUnreadable = "nothing this reader could read"
    public static let changeSummaryNothingMoves = "nothing moves"

    // MARK: derivation

    /// A seal as a reader compares it: enough to tell two apart, never the whole 64 characters.
    public static func shortSeal(_ seal: String) -> String {
        seal.isEmpty ? "(unreadable)" : String(seal.prefix(12))
    }

    /// Where one delivered card stands RIGHT NOW, derived from the read and from nothing else.
    /// A nil queue is the read not having come back, which is `unread` and not "nothing pending".
    ///
    /// An answer on record is looked for BEFORE the supersession link: the door takes an answer
    /// from a card that had not re-read yet, so a displaced proposal can still have been answered —
    /// and then the answer, not the displacement, is what happened to it.
    public static func standing(queue: PendingCriteriaDecisionQueue?,
                                intentId: String) -> CriteriaDecisionStanding {
        guard let queue else { return CriteriaDecisionStanding(intentId: intentId, state: .unread) }
        if let row = queue.pending.first(where: { $0.intentId == intentId }) {
            return CriteriaDecisionStanding(
                intentId: intentId,
                state: row.decidability.decidable ? .decidable(row) : .baseSealMoved(row))
        }
        if let answer = queue.settled.first(where: { $0.intentId == intentId }) {
            return CriteriaDecisionStanding(intentId: intentId, state: .alreadySettled(answer))
        }
        if let replacement = queue.pending.first(where: { $0.supersededIntentId == intentId }) {
            return CriteriaDecisionStanding(intentId: intentId,
                                            state: .superseded(replacement: replacement))
        }
        return CriteriaDecisionStanding(intentId: intentId, state: .alreadySettled(nil))
    }

    /// The line under the title: which of three things the reader is looking at — and, for a
    /// proposal answered at another end whose answer the read names, which answer.
    public static func heading(_ standing: CriteriaDecisionStanding) -> String {
        switch standing.state {
        case .decidable:    return liveHeading
        case .unread:       return unreadHeading
        case .alreadySettled(let answer?):
            return answer.decision == .approve ? approvedHeading : refusedHeading
        default:            return staleHeading
        }
    }

    /// The badge: the live one, or the one word that says why this card is dead — which, for an
    /// answer the read names, is the answer.
    public static func badge(_ standing: CriteriaDecisionStanding) -> String {
        switch standing.state {
        case .decidable:     return liveBadge
        case .baseSealMoved: return "seal moved"
        case .superseded:    return "replaced"
        case .alreadySettled(let answer):
            switch answer?.decision {
            case .approve?: return "approved"
            case .reject?:  return "refused"
            case nil:       return "settled"
            }
        case .unread:        return "unread"
        }
    }

    /// The meta line: who composed this card, and against which ruler. The provenance is here
    /// rather than in the badge because the badge is what gets truncated.
    public static func meta(_ standing: CriteriaDecisionStanding) -> String {
        let mark = "\(provenanceLabel) — \(provenanceNote)."
        guard let row = standing.row else { return mark }
        var against = "Composed against seal \(shortSeal(row.baselineSeal))"
        if row.baselineSeal == row.currentSeal {
            against += ", unchanged since it was drafted."
        } else {
            against += "; the set in force is now \(shortSeal(row.currentSeal))."
        }
        return "\(mark) \(against)"
    }

    /// Why this card cannot be answered, addressed to the reader looking at its dead buttons. Each
    /// sentence names the refusal the door would give, because that is the fact — a reader told
    /// only "you cannot" has been told the button is broken.
    public static func staleExplanation(_ standing: CriteriaDecisionStanding) -> String? {
        switch standing.state {
        case .decidable:
            return nil
        case .baseSealMoved(let row):
            let refusal = row.decidability.refusal ?? baseSealMovedRefusal
            let remedy = row.decidability.requiredAction ?? "a proposal against the current standard set"
            var out = "The base seal moved. This proposal was composed against "
            out += "\(shortSeal(row.baselineSeal)) and the standard set in force is now "
            out += "\(shortSeal(row.currentSeal)), so the decision door refuses every answer to it "
            out += "with \(refusal). Nothing was applied. What clears it is \(remedy) — by the "
            out += "party that proposed it, which is not you."
            return out
        case .superseded(let replacement):
            var out = "Superseded. A later proposal against this project replaced this one, and a "
            out += "project holds at most one pending proposal at a time, so what you would be "
            out += "approving here is not what anybody is asking for any more. Nothing was applied. "
            out += "The replacement is the proposal now waiting for a decision, composed against "
            out += "\(shortSeal(replacement.baselineSeal))."
            return out
        case .alreadySettled(let answer?) where answer.decision == .reject:
            var out = "Refused at another end. Nothing was applied: the criteria on record stayed as "
            out += "they were, and the seal stayed \(shortSeal(answer.baseSeal)). A decision sent "
            out += "from this card now would be refused with \(alreadySettledRefusal)."
            return out
        case .alreadySettled(let answer?):
            var out = "Approved at another end. The weakening was applied: the ruler moved, and the "
            out += "seal went from \(shortSeal(answer.baseSeal)) to "
            out += "\(shortSeal(answer.resultingSeal)). A decision sent from this card now would be "
            out += "refused with \(alreadySettledRefusal)."
            return out
        case .alreadySettled:
            var out = "Already answered. This proposal is no longer one of the project’s pending "
            out += "ones — the answer was recorded at another end, and a decision sent from this "
            out += "card now would be refused with \(alreadySettledRefusal). Nothing on this card "
            out += "was applied by you, and nothing here can change what was."
            return out
        case .unread:
            var out = "This card could not be re-read just now, so what it is asking about cannot "
            out += "be shown. It holds no copy of the proposal: everything on it is derived on each "
            out += "render, and an action nobody can say the door would accept is not offered. The "
            out += "proposal itself is untouched by this."
            return out
        }
    }

    /// Whether this card is still a QUESTION — which is not the same as whether it can be answered.
    ///
    /// The bar above the transcript counts by this and the buttons are gated by `answerable`, and
    /// the two differ in exactly one case, deliberately: a card this device could not re-derive is
    /// unanswerable (nobody can say the door would take it) and still open (nobody can say it was
    /// closed either). Declaring it closed would be the app deciding, from a failed read, that
    /// somebody's question had gone away.
    public static func isOpen(_ standing: CriteriaDecisionStanding) -> Bool {
        switch standing.state {
        case .decidable, .unread:                        return true
        case .baseSealMoved, .superseded, .alreadySettled: return false
        }
    }

    /// Whether the card is drawn dimmed, whole — the account owner's call on 2026-09-11, made
    /// looking at a settled card on a phone. It is exactly "no longer a question": keyed on `isOpen`
    /// rather than `answerable`, so `unread` stays bright, for `isOpen`'s reason — a card this
    /// device failed to re-read is not known to be dead.
    public static func isDimmed(_ standing: CriteriaDecisionStanding) -> Bool {
        !isOpen(standing)
    }

    // MARK: the receipt an answered proposal leaves

    /// What a receipt says it is, where the card asked a question. Web's
    /// `CRITERIA_DECISION_RECORDED_HEADING`, word for word — the same tripwire the rest of this
    /// file's copy is held to (`CriteriaDecisionCopyParityTests`).
    public static let recordedHeading = "Decision recorded"

    /// The receipt's line: which way it was answered, and the clock the door recorded it at.
    ///
    /// Web's `criteriaVerdictReceipt`, word for word, minus its reply clause: where the answer went
    /// is handed to the window that pressed the button and to nobody else, so a record read back
    /// later — on a phone that never saw the card, or after the page was reloaded — says what was
    /// decided rather than claiming a destination it never learned.
    public static func receiptLine(_ settled: SettledCriteriaDecision) -> String {
        let verdict = settled.decision == .approve ? "Approved" : "Refused"
        return "✓ \(verdict) by you at \(receiptClock(settled.decidedAt))"
    }

    /// A receipt's clock, in the reader's own locale — the browser's `toLocaleTimeString` with a
    /// two-digit hour and minute. Built once and reused, like `RelativeTime`'s formatters. An
    /// unparseable stamp is shown as it came rather than dropped: a record with no time on it is a
    /// record the reader cannot place.
    private static let receiptClockFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    public static func receiptClock(_ decidedAt: String) -> String {
        guard let date = ThinkingSummary.date(decidedAt) else { return decidedAt }
        return receiptClockFormatter.string(from: date)
    }

    /// One answer this console draws as a record.
    public struct Receipt: Equatable, Sendable, Identifiable {
        public let settled: SettledCriteriaDecision

        public init(settled: SettledCriteriaDecision) {
            self.settled = settled
        }

        /// The door's own clock — what the record is placed by. Read off the answer rather than
        /// captured beside it, so the value the console hands `TranscriptRows.build` and the value
        /// the card prints cannot be two different moments.
        public var moment: String { settled.decidedAt }

        /// The row id, beside the live card's rather than the same as it: both can be on screen at
        /// once for one intent (a question answered elsewhere is drawn as its receipt while the
        /// question it answers is still being let go of), and two rows sharing an id would cost the
        /// List its diff.
        public var id: String { "criteria-decision-receipt-\(settled.intentId)" }
    }

    /// The receipts this console draws for the answers the project's read publishes.
    ///
    /// WHY THIS IS NOT THE PRESSING WINDOW'S
    /// -------------------------------------
    /// A receipt used to be written by the window that pressed the button (`appendDecisionLine`) and
    /// kept in memory, so closing the app or opening the console again took the decision out of the
    /// conversation altogether — the account owner's report, 2026-09-16, on the web client, whose
    /// receipt was state in the page for the same reason. The answer is a committed row the read
    /// publishes (`settled`), so it is derived here like the standing of every card, and a device
    /// that never saw the question still shows what was decided. Web draws the same receipts in the
    /// same place, from the same array (`criteriaDecisionReceiptRows`).
    ///
    /// An answer older than everything this console holds is still drawn: as a ROW it carries the
    /// moment the door recorded (`decidedAt`), and `TranscriptRows.build` resolves that against the
    /// rows loaded at render time — inside the window it sits where the decision happened, above it
    /// it leads at the head (`ReceiptAnchor.Placement`). Nothing is captured here but the answer.
    public static func receipts(queue: PendingCriteriaDecisionQueue?) -> [Receipt] {
        guard let queue else { return [] }
        return queue.settled.map { Receipt(settled: $0) }
    }

    /// Whether the read says this proposal was answered — what makes its question card give way.
    public static func answered(_ queue: PendingCriteriaDecisionQueue?, intentID: String) -> Bool {
        queue?.settled.contains { $0.intentId == intentID } ?? false
    }

    // MARK: derivation — the diff

    /// The line that says how many criteria this proposal leaves alone.
    public static func unchangedLine(_ count: Int) -> String {
        "\(count) \(count == 1 ? unchangedSuffixOne : unchangedSuffixMany)"
    }

    /// The size of the decision in one line: what moves, and how much did not.
    public static func changeSummary(_ diff: CriteriaProposalDiff) -> String {
        if diff.entries.isEmpty { return changeSummaryUnreadable }
        var moved: [String] = []
        if diff.changedCount > 0 { moved.append("\(diff.changedCount) \(rewordedWord)") }
        if diff.removedCount > 0 { moved.append("\(diff.removedCount) \(droppedWord)") }
        if diff.newCount > 0 { moved.append("\(diff.newCount) \(addedWord)") }
        let head = moved.isEmpty ? changeSummaryNothingMoves : moved.joined(separator: ", ")
        return "\(head), \(diff.sameCount) unchanged"
    }

    /// The badge one row carries, or nil for the untouched ones, which carry none.
    public static func changeLabel(_ change: CriteriaProposalChange) -> String? {
        switch change {
        case .changed: return rewordedLabel
        case .new:     return addedLabel
        case .removed: return droppedLabel
        case .same:    return nil
        }
    }

    /// The entries a reader is shown by default: everything this proposal would move. Read off
    /// `change` rather than off the counts, so the list and the count cannot disagree about which
    /// rows they are talking about.
    public static func movedEntries(_ diff: CriteriaProposalDiff) -> [CriteriaProposalChangeEntry] {
        diff.entries.filter { $0.change != .same }
    }

    /// And the ones behind the fold.
    public static func unmovedEntries(_ diff: CriteriaProposalDiff) -> [CriteriaProposalChangeEntry] {
        diff.entries.filter { $0.change == .same }
    }

    /// One row of the diff, laid out for a view that only assembles.
    ///
    /// The numbering is the SERVER's ordinal and not this list's position, which is the whole point
    /// of showing three rows out of eight: `1.`, `2.`, `4.` tells a reader WHICH criteria moved,
    /// and a list renumbered `1. 2. 3.` would be inventing a set nobody proposed.
    ///
    /// A rewrite is ONE line here and not two. Laid out as the proposal's words followed by the
    /// record's, three rewrites of long Chinese criteria came to 483px of content in a card whose
    /// scroll box is 360px, and the clause that actually moved was still something a reader had to
    /// find by comparing two paragraphs. `words` is the server's cut of them, merged.
    public struct ChangeRow: Equatable, Sendable, Identifiable {
        public let id: String
        /// The number this row is drawn with: the server's ordinal.
        public let ordinal: Int
        /// The words this row is about, cut into what stayed, what goes and what arrives. For a
        /// criterion being added or dropped there is one version, so this is one `.kept` run.
        public let words: [CriterionSegment]
        public let badge: String
        /// The procedure, cut the same way. Nil unless the procedure is what moved.
        public let method: [CriterionSegment]?

        public init(id: String, ordinal: Int, words: [CriterionSegment], badge: String,
                    method: [CriterionSegment]? = nil) {
            self.id = id
            self.ordinal = ordinal
            self.words = words
            self.badge = badge
            self.method = method
        }
    }

    /// The runs one rewritten field is drawn from: the server's cut, or both versions whole.
    ///
    /// The fallback is not for a server that failed to cut — it is for one OLDER than this build,
    /// which is a shape that exists because the App Store release train outlives a deployment. An
    /// entry that says a field moved and carries no cut of it still has both versions on it, so it
    /// is drawn as one struck-through run and one added run: the same shape at the coarsest
    /// resolution, rather than a blank row or a second layout to keep working.
    public static func rewriteRuns(_ entry: CriteriaProposalChangeEntry,
                                   _ field: CriteriaProposalField) -> [CriterionSegment] {
        if let cut = entry.rewrites.first(where: { $0.field == field }), !cut.segments.isEmpty {
            return cut.segments
        }
        let dropped = wording(entry.onRecord, field)
        let added = wording(entry.proposed, field)
        return (dropped.isEmpty ? [] : [CriterionSegment(side: .removed, text: dropped)])
            + (added.isEmpty ? [] : [CriterionSegment(side: .added, text: added)])
    }

    private static func wording(_ words: CriterionWording?,
                                _ field: CriteriaProposalField) -> String {
        guard let words else { return "" }
        switch field {
        case .text: return words.text
        case .verificationMethod: return words.verificationMethod ?? ""
        case .completionCriterionOverrideReason:
            return words.completionCriterionOverrideReason ?? ""
        }
    }

    /// Every criterion this proposal would move, as rows. The untouched ones are not here — they
    /// are `unchangedRows` below, behind a fold, under a count that is always on screen.
    public static func changeRows(_ row: PendingCriteriaDecisionRow) -> [ChangeRow] {
        movedEntries(row.diff).enumerated().map { index, entry in
            let textMoved = entry.change == .changed && entry.changed.contains(.text)
            let plain = (entry.proposed ?? entry.onRecord)?.text ?? ""
            return ChangeRow(
                id: entry.definitionId ?? "added-\(index)-\(entry.ordinal)",
                ordinal: entry.ordinal,
                words: textMoved
                    ? rewriteRuns(entry, .text)
                    : [CriterionSegment(side: .kept, text: plain)],
                badge: changeLabel(entry.change) ?? "",
                method: entry.changed.contains(.verificationMethod)
                    ? rewriteRuns(entry, .verificationMethod) : nil
            )
        }
    }

    /// Whether anything on this card is drawn with the two marks, and so whether to explain them.
    /// A proposal that only adds and drops criteria has no struck-through words on it, and a
    /// legend for marks that are not there is a line of height spent on nothing.
    public static func hasRewrite(_ diff: CriteriaProposalDiff) -> Bool {
        diff.entries.contains { $0.change == .changed }
    }

    /// The criteria the proposal leaves word for word alone, numbered as the server numbers them.
    public static func unchangedRows(_ row: PendingCriteriaDecisionRow) -> [String] {
        unmovedEntries(row.diff).map { "\($0.ordinal). \($0.proposed?.text ?? "")" }
    }

    /// The request one press makes, as data, so what goes to the door can be asserted without a
    /// network — the same tactic the web card takes with `criteriaDecisionRequest`.
    public static func request(row: PendingCriteriaDecisionRow,
                               decision: CriteriaDecisionAnswer) -> CriteriaDecisionRequest {
        CriteriaDecisionRequest(commitToken: row.commitToken, decision: decision,
                                baseSeal: row.baselineSeal)
    }

}

// MARK: - the settlement confirmation

/// The confirmation card's words and states — this client's half of the card the browser draws as
/// `AcceptanceConfirmationCard.tsx`. Both ends draw it in the same place: the coordinator
/// conversation, which is where the question was delivered.
///
/// The question is asked BEFORE the work rather than after it: confirming the set is what starts
/// the project, so the one press says "this is what done means" and "go". Asked at the end — the
/// moment every criterion was already met — answering "no" annulled work already done, so the card
/// could only ever be agreed with.
public enum AcceptanceConfirmations {

    public static let title = "When is this project done?"
    /// The primary action for the project this card is normally asked about: one that is not
    /// running yet. One press records the confirmation AND starts it, because saying what would
    /// settle a project is what authorises work on it.
    public static let startLabel = "Start the project"
    /// …and what the SAME control says when the project is already handing work out. Two different
    /// facts are being answered, and the verb has to follow the fact: a project already running on
    /// an older version of its plan is not being started by this press, it is being re-confirmed —
    /// "start" would name an act that is not available and a state the project is not in. Web's
    /// `ACCEPTANCE_CONFIRM_LABEL`, word for word.
    public static let confirmLabel = "Confirm the criteria"
    /// The reading toggle once the criteria are shown whole.
    public static let showLessLabel = "Show less"

    /// What the primary action says, for the project the card is actually about: `started`, read
    /// off `coordinatorEnabled` and never inferred from the standing. A nil — a project document
    /// that did not answer — keeps the card's own word rather than guessing a tense for a project
    /// nobody has read, which is the rule the meta line's third field is under.
    public static func actionLabel(started: Bool?) -> String {
        started == true ? confirmLabel : startLabel
    }

    /// The reading toggle's label. It carries the count because the count is the thing confirmed: a
    /// person is agreeing that THESE N conditions, together, express the goal.
    public static func readLabel(count: Int) -> String {
        "Read all \(count) in full"
    }

    /// Where the project stands, as the meta line's third field says it: read off
    /// `coordinatorEnabled` — the column that decides whether Orbit hands this project's tasks out,
    /// and which the confirmation door writes by no other hand — and off nothing else. Confirming
    /// turns it on for a project started since that was wired, and says nothing whatever about one
    /// that was already dispatching work when it landed.
    public static let notStarted = "not started"
    public static let started = "started"
    /// …and what that field says when the project itself could not be read. A failed read is not an
    /// answer, and guessing "not started" at a project that is handing work out is the one thing
    /// this field was taken off the standing to stop saying.
    public static let startNotRead = "start not read"

    /// Where the CONFIRMATION stands, as the meta line's fourth field says it. The other question
    /// entirely, and the only one the standing answers: whether anybody has said what done means
    /// here, and whether that is still the plan.
    public static let confirmed = "confirmed"
    public static let changedSinceConfirmed = "changed since it was confirmed"
    public static let nobodySaidDone = "nobody has said what done means"

    /// Which project, how many conditions, whether it has been started, whether anybody has said
    /// what done means, and which version of them — in that order. The seal is last because it
    /// answers a question nobody has until they have read the rest: it names the version a press
    /// binds, and proves nothing about having read it.
    ///
    /// TWO FIELDS BECAUSE THEY ARE TWO FACTS
    /// -------------------------------------
    /// One field used to answer both, off the standing alone: unconfirmed was printed "not
    /// started". That holds only for a project created since confirming became the press that
    /// starts one — for the projects that were already here it is simply a different question, and
    /// on 2026-09-18 seven OPEN projects were handing work out with no confirmation ever recorded.
    /// The card said "not started" about every one of them. So `started` is read off the project
    /// and `asked` off the standing, and neither is inferred from the other.
    public static func meta(_ standing: StandardSetConfirmationStanding?,
                            started: Bool?,
                            projectTitle: String) -> String {
        guard let standing else {
            return "\(projectTitle) — the standing could not be read just now."
        }
        let count = standing.currentVersion.material.count
        let seal = CriteriaDecisions.shortSeal(standing.currentVersion.digest)
        let stands: String
        switch started {
        case .some(true): stands = Self.started
        case .some(false): stands = notStarted
        case .none: stands = startNotRead
        }
        let asked: String
        switch standing.state {
        case .confirmed: asked = Self.confirmed
        case .stale: asked = changedSinceConfirmed
        case .unconfirmed: asked = nobodySaidDone
        }
        return "\(projectTitle) · \(count) criteria · \(stands) · \(asked) · seal \(seal)"
    }

    /// How a stale standing's first line opens.
    public static let changedSince =
        "The criteria changed after they were confirmed, so that confirmation no longer stands."
    public static let editEndsIt =
        "Editing any criterion ends this confirmation and Orbit will ask again."

    /// The one paragraph the card keeps: what a confirmation binds the project to, and what ends it.
    /// It is never dropped — it is the mechanism, and the reason this card is asked before the work
    /// rather than after it. A stale standing says first why it is being asked a second time.
    ///
    /// AND A PROJECT ALREADY RUNNING IS TOLD IT IN ITS OWN TENSE. "Once this starts" is the sentence
    /// for the project this card was written for — the plan is written and nothing has run. Said to
    /// one that is already handing work out it describes a beginning that happened some other day,
    /// which is the same defect as offering it a `Start` button: the card would be narrating a state
    /// the reader is not in. Which of the two it says is `started` — the same fact the meta line's
    /// third field and the action's label are read off, so all three agree by construction. Web's
    /// `acceptanceStartExplanation`, and `AcceptanceConfirmationCopyParityTests` reads both back out
    /// of it.
    public static func startExplanation(count: Int,
                                        standing: StandardSetConfirmationStanding?,
                                        started: Bool? = false) -> String {
        let again = standing?.state == .stale ? "\(changedSince) " : ""
        guard started == true else {
            return "\(again)Once this starts, Orbit derives done from these \(count) and from "
                + "nothing else. " + editEndsIt
        }
        return "\(again)Once this is confirmed, Orbit derives done from these \(count) and from "
            + "nothing else. " + editEndsIt
    }

    /// Whether the confirm button may be pressed. Both un-confirmed states offer it and it always
    /// sends the version standing NOW — never the one that was confirmed before. A standing that
    /// could not be read offers nothing, for the reason the weakening card's `unread` does.
    public static func answerable(_ standing: StandardSetConfirmationStanding?) -> Bool {
        guard let standing else { return false }
        return standing.state != .confirmed
    }

    /// Whether this card is still asking something — what the needs-you bar counts. The standing is
    /// the whole of it, and deliberately: what is open is the QUESTION, and only a confirmation
    /// answers that. Whether the project has been started is the other fact the meta line carries,
    /// and a project already running has this question open all the same. A standing that could not
    /// be read leaves it open, because a failed read is this device's problem and not an answer.
    public static func isOpen(_ standing: StandardSetConfirmationStanding?) -> Bool {
        guard let standing else { return true }
        return standing.state != .confirmed
    }

    /// Whether the card is drawn dimmed, whole: once the set is confirmed, and never for a standing
    /// that could not be read — the weakening card's rule (`CriteriaDecisions.isDimmed`).
    public static func isDimmed(_ standing: StandardSetConfirmationStanding?) -> Bool {
        !isOpen(standing)
    }

    /// Why the button is dead, or nil while it is live. Same rule as the other card: a reader
    /// looking at a disabled action is told which fact made it so.
    public static func staleExplanation(_ standing: StandardSetConfirmationStanding?) -> String? {
        guard let standing else {
            var out = "This card could not be re-read just now, so the version it would confirm "
            out += "cannot be named — and a confirmation that names no version is not one. The "
            out += "criteria themselves are untouched by this."
            return out
        }
        guard standing.state == .confirmed, let confirmation = standing.confirmation else {
            return nil
        }
        let seal = CriteriaDecisions.shortSeal(confirmation.criteriaDigest)
        var out = "Already confirmed, at another end, for seal \(seal) — the version standing now. "
        out += "There is nothing left to answer here; editing any criterion ends that confirmation "
        out += "and Orbit will ask again."
        return out
    }

    /// What a confirmation records: the count it was given over, and the seal it locked.
    ///
    /// Read off the RECORD and never off the version standing now. Those are the same version
    /// exactly while the confirmation counts, and the whole point of the record is what it says when
    /// they are not: after an edit the standing names the new seal, and this line still has to name
    /// the one somebody actually signed. Web's `acceptanceConfirmedLine`, word for word — one
    /// sentence, whether it is drawn the second the door answers or a week later on another device.
    public static func confirmedLine(_ confirmation: RecordedStandardSetConfirmation) -> String {
        let count = confirmation.criteriaMaterial.count
        let seal = CriteriaDecisions.shortSeal(confirmation.criteriaDigest)
        return "You started the project on \(count) criteria at seal \(seal)"
    }

    /// The record's heading: the two words the receipts Orbit already draws into a conversation use
    /// (`CriteriaDecisions.recordedHeading`), because it is the same thing — an answer to a question
    /// this conversation asked. Web's `ACCEPTANCE_RECEIPT_HEADING`.
    public static let receiptHeading = "Decision recorded"

    /// Who signed it, under the line above: the browser's own words for the same two facts
    /// (`acceptanceReceiptStamp`). The time is passed in, for `OwnerConfirmations.receiptLine`'s
    /// reason — formatting a clock is the platform's business and not a contract between the two
    /// ends — and a moment this client cannot read is left off rather than rendered as a dangling
    /// preposition.
    public static func receiptStamp(_ time: String?) -> String {
        guard let time else { return "by you" }
        return "by you at \(time)"
    }

    /// One confirmation this console draws as a record.
    public struct Receipt: Equatable, Sendable, Identifiable {
        public let confirmation: RecordedStandardSetConfirmation

        public init(confirmation: RecordedStandardSetConfirmation) {
            self.confirmation = confirmation
        }

        /// The door's own clock — see `CriteriaDecisions.Receipt.moment`.
        public var moment: String { confirmation.confirmedAt }

        /// The row this record is drawn in — the card's own address rather than a second spelling of
        /// it, so the id the console dedupes on and the id the transcript draws cannot drift.
        public var id: String {
            DeliveredDecisionCard(kind: .acceptanceConfirmationReceipt(confirmed: confirmation)).id
        }
    }

    /// The record this conversation draws, or nothing: a confirmation on record — current or
    /// superseded by an edit, both of which happened. A moment older than every loaded row is not
    /// dropped here: the record carries its own `confirmedAt`, and `TranscriptRows.build` puts it at
    /// the head of the window when that moment is above it (`ReceiptAnchor.Placement`).
    ///
    /// Drawn from the READ and not from the window that pressed. A press kept as this window's own
    /// state lasted exactly as long as the console did: the record of it was gone on the next open,
    /// on the device that made it and on every device that did not.
    public static func receipt(standing: StandardSetConfirmationStanding?) -> Receipt? {
        guard let confirmation = standing?.confirmation else { return nil }
        return Receipt(confirmation: confirmation)
    }

    // MARK: talking about the plan before starting it

    /// What the composer's bar says it is about to talk about, ahead of the project's own title.
    public static let planChangePrefix = "Talking about this plan: "
    /// What the armed composer asks for. A message, not an answer: no door is waiting on it.
    public static let planChangePlaceholder = "What should done mean instead?"

    /// What the next send carries ahead of the typed message: the plan as it stands, named by its
    /// seal.
    ///
    /// The other three armed replies answer a call that is blocking on them, so their door already
    /// knows what the reply is about. This one starts an ordinary turn at an idle agent, which knows
    /// none of it — so the version being discussed rides with the message rather than being looked
    /// up, and the seal is in it so a reply about a set that has since moved can be told apart from
    /// one about this one.
    public static func planChangeContext(projectTitle: String, criteriaDigest: String,
                                         criteria: [String]) -> String {
        let numbered = criteria.enumerated()
            .map { "\($0.offset + 1). \($0.element)" }
            .joined(separator: "\n")
        let seal = CriteriaDecisions.shortSeal(criteriaDigest)
        var out = "About the acceptance criteria of “\(projectTitle)” — the \(criteria.count) that "
        out += "stand now, at seal \(seal), which nobody has confirmed and which "
        out += "no work has started against:\n\n\(numbered)"
        return out
    }
}

/// The confirmation door's body: the version being confirmed, and nothing else.
public struct ConfirmAcceptanceCriteriaRequest: Codable, Equatable, Sendable {
    public let criteriaDigest: String

    public init(criteriaDigest: String) {
        self.criteriaDigest = criteriaDigest
    }
}
