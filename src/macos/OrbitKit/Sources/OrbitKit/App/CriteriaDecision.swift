import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE TWO CARDS A PROJECT'S RULER IS MOVED FROM — THE OTHER HALF OF WEB'S
   `CriteriaDecisionCard.tsx` AND OF THE CONFIRMATION REGION IN `ProjectAcceptanceCard.tsx`
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
   copy, which is the property being bought.

   ONE SOURCE FOR TWO CLIENTS
   --------------------------
   The derivation, the standings and every visible word are here so macOS, iOS and the browser
   cannot come apart on them, and so they can be tested on Linux where no SwiftUI exists. The
   mirror is `src/web/src/components/CriteriaDecisionCard.tsx` (commit `12d7f1d1`, filed under the
   same project criterion as this file) — the strings below are copied from it deliberately, the
   way `EvidenceDecisions` copies `DecisionRail`'s. There is no parity TEST for them yet only
   because that web file has not landed on main; when it does, `EvidenceDecisionCopyParityTests` is
   the shape the tripwire takes.

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

/// One criterion as the proposal states it. `id` is null for one the proposal is ADDING, which is
/// the only way a reader can tell an addition from a rewrite — the read publishes the proposed set,
/// not a diff against the set in force (the baseline's text is not published at all).
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
    /// The proposal this one displaced, or nil when it displaced nothing.
    public let supersededIntentId: String?
    public let decidability: CriteriaDecisionDecidability

    public var id: String { intentId }

    public init(intentId: String, projectId: String, commitToken: String, actionDigest: String,
                filedAt: String, ageSeconds: Int, baselineSeal: String, currentSeal: String,
                proposed: [ProposedCriterion], supersededIntentId: String? = nil,
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
        self.supersededIntentId = supersededIntentId
        self.decidability = decidability
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

    public init(readAt: String, projectId: String, count: Int, oldestAgeSeconds: Int? = nil,
                decidableCount: Int, pending: [PendingCriteriaDecisionRow]) {
        self.readAt = readAt
        self.projectId = projectId
        self.count = count
        self.oldestAgeSeconds = oldestAgeSeconds
        self.decidableCount = decidableCount
        self.pending = pending
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

    public init(id: String, acceptanceCriteriaItems: [Item]? = nil) {
        self.id = id
        self.acceptanceCriteriaItems = acceptanceCriteriaItems
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
        /// The row is gone and nothing pending claims to have displaced it: somebody answered it.
        case alreadySettled
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

    // MARK: derivation

    /// A seal as a reader compares it: enough to tell two apart, never the whole 64 characters.
    public static func shortSeal(_ seal: String) -> String {
        seal.isEmpty ? "(unreadable)" : String(seal.prefix(12))
    }

    /// Where one delivered card stands RIGHT NOW, derived from the read and from nothing else.
    /// A nil queue is the read not having come back, which is `unread` and not "nothing pending".
    public static func standing(queue: PendingCriteriaDecisionQueue?,
                                intentId: String) -> CriteriaDecisionStanding {
        guard let queue else { return CriteriaDecisionStanding(intentId: intentId, state: .unread) }
        if let row = queue.pending.first(where: { $0.intentId == intentId }) {
            return CriteriaDecisionStanding(
                intentId: intentId,
                state: row.decidability.decidable ? .decidable(row) : .baseSealMoved(row))
        }
        if let replacement = queue.pending.first(where: { $0.supersededIntentId == intentId }) {
            return CriteriaDecisionStanding(intentId: intentId,
                                            state: .superseded(replacement: replacement))
        }
        return CriteriaDecisionStanding(intentId: intentId, state: .alreadySettled)
    }

    /// The line under the title: which of three things the reader is looking at.
    public static func heading(_ standing: CriteriaDecisionStanding) -> String {
        switch standing.state {
        case .decidable:    return liveHeading
        case .unread:       return unreadHeading
        default:            return staleHeading
        }
    }

    /// The badge: the live one, or the one word that says why this card is dead.
    public static func badge(_ standing: CriteriaDecisionStanding) -> String {
        switch standing.state {
        case .decidable:     return liveBadge
        case .baseSealMoved: return "seal moved"
        case .superseded:    return "replaced"
        case .alreadySettled: return "settled"
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

    /// The proposed set as a numbered line each, in the server's own ordinals. One criterion the
    /// proposal ADDS is marked, because `id == nil` is the only way a reader can tell an addition
    /// from a rewrite — this read publishes the proposed set and not a diff.
    public static func proposedLines(_ row: PendingCriteriaDecisionRow) -> [String] {
        row.proposed.enumerated().map { index, criterion in
            let number = criterion.ordinal > 0 ? criterion.ordinal : index + 1
            let marker = criterion.id == nil ? " · new in this proposal" : ""
            return "\(number). \(criterion.text)\(marker)"
        }
    }

    /// The one line saying how much is being asked for, in the shape the browser's card says it.
    public static func proposedSummary(_ row: PendingCriteriaDecisionRow) -> String {
        let count = row.proposed.count
        return "\(count) criteri\(count == 1 ? "on" : "a"), as this project’s standard set"
    }

    /// The request one press makes, as data, so what goes to the door can be asserted without a
    /// network — the same tactic the web card takes with `criteriaDecisionRequest`.
    public static func request(row: PendingCriteriaDecisionRow,
                               decision: CriteriaDecisionAnswer) -> CriteriaDecisionRequest {
        CriteriaDecisionRequest(commitToken: row.commitToken, decision: decision,
                                baseSeal: row.baselineSeal)
    }

    /// What a decision leaves behind where it was made. The seals are the whole of the
    /// compare-and-set the door performed, in the door's own words, so a reader a week later can
    /// tell which version was answered — and, for a refusal, that the version did not move.
    public static func decisionLine(_ result: CriteriaDecisionResult) -> String {
        result.decision == .approve
            ? "You approved the weakening — the ruler moved, seal \(shortSeal(result.baseSeal)) → "
                + "\(shortSeal(result.resultingSeal))"
            : "You refused the weakening — nothing was applied, seal stays "
                + "\(shortSeal(result.baseSeal))"
    }
}

// MARK: - the settlement confirmation

/// One line of the confirmation card's body: something that holds, or the one thing that does not.
public struct AcceptanceConfirmationCheck: Equatable, Sendable, Identifiable {
    /// True draws the green tick; false the amber question mark. It is NOT a pass/fail verdict —
    /// the open line is the question being asked, not a failure.
    public let ok: Bool
    public let text: String
    public var id: String { text }

    public init(ok: Bool, text: String) {
        self.ok = ok
        self.text = text
    }
}

/// The confirmation card's words and states — the transcript's half of what the browser draws in
/// `ProjectAcceptanceCard`'s confirmation region, said as a question rather than as a region of a
/// project page (this client has no project page, and the coordinator conversation is where the
/// question was delivered).
public enum AcceptanceConfirmations {

    public static let title = "Confirm what done means?"
    public static let confirmLabel = "Confirm — this is what done means"
    public static let notYetLabel = "Not yet"

    /// The fold's label. It carries the count because the count is the thing being confirmed: a
    /// person is agreeing that THESE N conditions, together, express the goal.
    public static func readLabel(count: Int) -> String {
        "Read the \(count) criteri\(count == 1 ? "on" : "a")"
    }

    /// The meta line, in the same shape the weakening card's carries: who is asking, about which
    /// version, and what is being held on the answer.
    public static func meta(_ standing: StandardSetConfirmationStanding?) -> String {
        guard let standing else {
            return "\(CriteriaDecisions.provenanceLabel) — the standing could not be read just now."
        }
        let count = standing.currentVersion.material.count
        let seal = CriteriaDecisions.shortSeal(standing.currentVersion.digest)
        var out = "\(CriteriaDecisions.provenanceLabel) — the set of \(count) at seal \(seal). "
        out += "Settlement is held on this."
        return out
    }

    /// The body: what holds, and the one thing that does not.
    ///
    /// The open line is never dropped, whatever the state — it is the mechanism, and it is the
    /// reason the card exists: nobody derives DONE from criteria alone.
    public static func checks(_ standing: StandardSetConfirmationStanding) -> [AcceptanceConfirmationCheck] {
        let count = standing.currentVersion.material.count
        var rows: [AcceptanceConfirmationCheck] = []
        switch standing.state {
        case .unconfirmed:
            let text = "Nobody has confirmed that these \(count) express this project’s goal."
            rows.append(AcceptanceConfirmationCheck(ok: false, text: text))
        case .stale:
            var text = "The criteria changed after they were confirmed, so that confirmation no "
            text += "longer stands."
            if let prior = standing.confirmation {
                text += " It named seal \(CriteriaDecisions.shortSeal(prior.criteriaDigest))."
            }
            rows.append(AcceptanceConfirmationCheck(ok: false, text: text))
        case .confirmed:
            var text = "These \(count) were confirmed to express this project’s goal, and the "
            text += "wording that stands now is the wording that was confirmed."
            rows.append(AcceptanceConfirmationCheck(ok: true, text: text))
        }
        // The mechanism, never dropped: nobody derives DONE from criteria alone, and that is the
        // whole reason this card is in front of a person.
        if standing.state == .confirmed {
            rows.append(AcceptanceConfirmationCheck(
                ok: true,
                text: "Editing any criterion ends this confirmation and Orbit will ask again."))
        } else {
            var text = "Orbit will not derive DONE until you say this set of \(count) is what "
            text += "“done” means here."
            rows.append(AcceptanceConfirmationCheck(ok: false, text: text))
        }
        return rows
    }

    /// Whether the confirm button may be pressed. Both un-confirmed states offer it and it always
    /// sends the version standing NOW — never the one that was confirmed before. A standing that
    /// could not be read offers nothing, for the reason the weakening card's `unread` does.
    public static func answerable(_ standing: StandardSetConfirmationStanding?) -> Bool {
        guard let standing else { return false }
        return standing.state != .confirmed
    }

    /// Whether the confirmation is still a question — the same distinction the other card draws:
    /// a standing that could not be read is unanswerable and open, because a failed read is this
    /// device's problem and not an answer.
    public static func isOpen(_ standing: StandardSetConfirmationStanding?) -> Bool {
        guard let standing else { return true }
        return standing.state != .confirmed
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

    /// What a confirmation leaves behind where it was made.
    public static func confirmedLine(_ standing: StandardSetConfirmationStanding) -> String {
        let count = standing.currentVersion.material.count
        let seal = CriteriaDecisions.shortSeal(standing.currentVersion.digest)
        return "You confirmed the standard set — \(count) criteria at seal \(seal)"
    }
}

/// The confirmation door's body: the version being confirmed, and nothing else.
public struct ConfirmAcceptanceCriteriaRequest: Codable, Equatable, Sendable {
    public let criteriaDigest: String

    public init(criteriaDigest: String) {
        self.criteriaDigest = criteriaDigest
    }
}
