import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE EVIDENCE-DECISION CARD — THE OTHER HALF OF WEB'S `EvidenceDecisionCard.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   A CARD ORBIT DRAWS, NOT A QUESTION AN AGENT ASKS
   ------------------------------------------------
   Whether a task's submitted evidence settles it used to reach this client as an AskUserQuestion
   the project's coordinator raised over a pending row, answered back into the engine for the model
   to relay to `task_evidence_decide`. Nothing in that loop needed a model:
   `GET /tasks/evidence-decisions/pending` already publishes the whole row, and
   `POST /tasks/:taskId/evidence/decision` already takes this device's own credential. So the card
   is drawn from the one and pressed at the other — the shape `CriteriaDecision.swift` has for the
   ruler — and no question is taken for one: an AskUserQuestion offering `Confirm completion` /
   `Send back` is an ordinary form.

   NOTHING IS FROZEN INTO THE CARD EXCEPT THE ADDRESS
   --------------------------------------------------
   A delivered card keeps one thing across renders — which revision of which task's evidence it was
   drawn for, the pair the door's compare-and-set is against — and re-derives everything else from
   the read (`EvidenceDecisions.standing`). A revision answered in a browser, displaced by a newer
   one, or not readable right now is a conclusion about the read rather than local state somebody
   has to remember to clear. Nothing on the card is summarised, re-worded or inferred: each visible
   string is a field of the row or a count of one.

   ONE SOURCE FOR TWO CLIENTS
   --------------------------
   The derivation, the order of the body, the copy and the send-back gate live here so macOS and
   iOS cannot disagree about them, and so they can be tested on Linux where no SwiftUI exists. What
   does NOT live here is the one thing that genuinely differs between a 390pt phone and a macOS
   window: how much of a claim fits before it folds — see `claimClampCompact` /
   `claimClampRegular`. Structure is shared; width is not.

   The mirror on the other side is `src/web/src/components/EvidenceDecisionCard.tsx`.
   `EvidenceDecisionCopyParityTests` reads that file and fails when the words drift, because "one
   end says 机器已核 and the other says 提交者自述"（现在是 "checked for you" 对 "the account"） is the failure this pair of clients exists to
   prevent.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the row, as the server publishes it

/// One cited check, resolved against the rows as they are NOW.
public struct EvidenceDecisionCitation: Codable, Equatable, Sendable {
    public let kind: String
    public let ref: String
    public let resolved: Bool
    public let reason: String?
    /// The cited row in words when the server has better than the ref: the tool's name and the
    /// command it ran. Null for a citation that did not resolve, and for kinds whose ref reads.
    public let label: String?

    public init(kind: String, ref: String, resolved: Bool, reason: String? = nil,
                label: String? = nil) {
        self.kind = kind
        self.ref = ref
        self.resolved = resolved
        self.reason = reason
        self.label = label
    }
}

/// Whether the decision door would record ANY answer about this row — independent of who asks.
public struct EvidenceDecisionDecidability: Codable, Equatable, Sendable {
    public let decidable: Bool
    public let refusal: String?
    public let requiredAction: String?

    public init(decidable: Bool, refusal: String? = nil, requiredAction: String? = nil) {
        self.decidable = decidable
        self.refusal = refusal
        self.requiredAction = requiredAction
    }
}

/// Whether the door would take an answer to this row FROM THIS SESSION.
public struct EvidenceDecisionIndependence: Codable, Equatable, Sendable {
    public let independent: Bool
    public let disqualification: String?
    public let requiredAction: String?

    public init(independent: Bool, disqualification: String? = nil, requiredAction: String? = nil) {
        self.independent = independent
        self.disqualification = disqualification
        self.requiredAction = requiredAction
    }
}

/// The stated criterion the evidence quotes, as it was quoted.
public struct EvidenceDecisionCriterion: Codable, Equatable, Sendable {
    public let key: String
    public let text: String

    public init(key: String, text: String) {
        self.key = key
        self.text = text
    }
}

/// One pending completion decision — `PendingEvidenceJudgment` on the wire, `PendingDecisionRow`
/// in the web client. Fields are the server's; nothing is added and nothing is dropped.
public struct EvidenceDecisionRow: Codable, Equatable, Sendable, Identifiable {
    public let taskId: String
    public let title: String
    /// The project the task is filed under, or nil for a task in none. A conversation draws a card
    /// only for its own project's rows (`EvidenceDecisions.cardRows`).
    public let projectId: String?
    public let criterion: EvidenceDecisionCriterion?
    /// The revision awaiting an answer, in the decimal spelling the decision door takes back.
    public let evidenceRevision: String
    public let ageSeconds: Int?
    /// What the submitter says the work established.
    public let claim: String
    /// What the submitter says it did NOT establish. Carried on every row because it is the field
    /// most likely to change the answer; no client may drop it to save space.
    public let gaps: [String]
    public let citations: [EvidenceDecisionCitation]
    public let decidability: EvidenceDecisionDecidability
    public let independence: EvidenceDecisionIndependence

    /// A row is one revision of one task — the pair the decision door's compare-and-set is against.
    public var id: String { "\(taskId)#\(evidenceRevision)" }

    public init(taskId: String, title: String, projectId: String? = nil,
                criterion: EvidenceDecisionCriterion?,
                evidenceRevision: String, ageSeconds: Int? = nil, claim: String, gaps: [String],
                citations: [EvidenceDecisionCitation],
                decidability: EvidenceDecisionDecidability,
                independence: EvidenceDecisionIndependence) {
        self.taskId = taskId
        self.title = title
        self.projectId = projectId
        self.criterion = criterion
        self.evidenceRevision = evidenceRevision
        self.ageSeconds = ageSeconds
        self.claim = claim
        self.gaps = gaps
        self.citations = citations
        self.decidability = decidability
        self.independence = independence
    }
}

/// What THIS session is being asked to decide: `GET /tasks/evidence-decisions/pending`.
/// Only `pending` is a question addressed to this reader — `waitingOnYou` is a row the door
/// refuses whatever anybody presses, which is why no card is ever built from it.
public struct EvidenceDecisionQueue: Codable, Equatable, Sendable {
    public let decidingSessionId: String
    /// How many rows are waiting for a decision from this session: the length of `pending`.
    public let count: Int
    public let oldestAgeSeconds: Int?
    public let pending: [EvidenceDecisionRow]
    public let waitingOnYou: [EvidenceDecisionRow]
    /// What THIS session has already decided, oldest first — the receipts its conversation keeps
    /// after a card's question is gone. A read that has not published them yet decodes as empty
    /// rather than failing the whole queue, which would take the pending cards down with it.
    public let decided: [RecordedEvidenceDecision]

    public init(decidingSessionId: String, count: Int, oldestAgeSeconds: Int? = nil,
                pending: [EvidenceDecisionRow], waitingOnYou: [EvidenceDecisionRow] = [],
                decided: [RecordedEvidenceDecision] = []) {
        self.decidingSessionId = decidingSessionId
        self.count = count
        self.oldestAgeSeconds = oldestAgeSeconds
        self.pending = pending
        self.waitingOnYou = waitingOnYou
        self.decided = decided
    }

    // Tolerant decode, like `PendingCriteriaDecisionQueue`: the key is absent from a server older
    // than this build, and an absent receipt list is "nothing to draw", not a broken read.
    enum CodingKeys: String, CodingKey {
        case decidingSessionId, count, oldestAgeSeconds, pending, waitingOnYou, decided
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        decidingSessionId = try c.decode(String.self, forKey: .decidingSessionId)
        count = try c.decode(Int.self, forKey: .count)
        oldestAgeSeconds = try? c.decodeIfPresent(Int.self, forKey: .oldestAgeSeconds)
        pending = try c.decode([EvidenceDecisionRow].self, forKey: .pending)
        waitingOnYou = (try? c.decodeIfPresent([EvidenceDecisionRow].self, forKey: .waitingOnYou)) ?? []
        decided = (try? c.decodeIfPresent([RecordedEvidenceDecision].self, forKey: .decided)) ?? []
    }
}

/// One answer this session has already recorded, as the pending read publishes it: what was
/// decided, on which revision of which task, and when.
///
/// Small on purpose — it rides every poll — and it is the ONLY copy of the answer the console keeps:
/// the receipt is drawn from it, so a reload, a relaunch or another device shows the same record.
/// The evidence it answered is not here; the browser fetches that when a reader opens the receipt's
/// fold, which is a step this client does not need and does not take.
public struct RecordedEvidenceDecision: Codable, Equatable, Sendable, Identifiable {
    public let taskId: String
    public let title: String
    public let projectId: String?
    /// The revision that was answered, in the decimal spelling a pending row uses.
    public let evidenceRevision: String
    public let decision: EvidenceDecisionAnswer
    public let note: String?
    /// ISO-8601, as JSON carries it.
    public let decidedAt: String
    /// `USER` when the owner pressed a card, `AGENT` when a run of the deciding session called the
    /// door. The receipt says which, because the two are different events in a conversation.
    public let decidedByType: String

    public init(taskId: String, title: String, projectId: String?, evidenceRevision: String,
                decision: EvidenceDecisionAnswer, note: String?, decidedAt: String,
                decidedByType: String) {
        self.taskId = taskId
        self.title = title
        self.projectId = projectId
        self.evidenceRevision = evidenceRevision
        self.decision = decision
        self.note = note
        self.decidedAt = decidedAt
        self.decidedByType = decidedByType
    }

    public var recordedByAgent: Bool { decidedByType == "AGENT" }
    /// The version this receipt answers — the same address a pending row carries.
    public var id: String { "\(taskId)@\(evidenceRevision)" }
}

// MARK: - the door

/// The two answers the door takes. There is deliberately no third that leaves it pending: not
/// deciding yet is simply not pressing.
public enum EvidenceDecisionAnswer: String, Codable, Equatable, Sendable {
    case confirm = "CONFIRM"
    case sendBack = "SEND_BACK"
}

/// The body one press sends to `POST /tasks/:taskId/evidence/decision`.
///
/// Three bindings, and they are not the same kind of thing: `decidingSessionId` says where the
/// answer is given FROM — the door runs its independence check on that session, so an account owner
/// gets no shorter path than a coordinator does — the credential the request carries says WHO, and
/// `evidenceRevision` says WHICH version was read, which is the compare-and-set the door refuses
/// once that version is not the latest.
public struct EvidenceDecisionRequest: Codable, Equatable, Sendable {
    public let decidingSessionId: String
    public let evidenceRevision: String
    public let decision: EvidenceDecisionAnswer
    /// The reason, on a send-back and on nothing else. Nil is left out of the body, not sent as null.
    public let note: String?

    public init(decidingSessionId: String, evidenceRevision: String,
                decision: EvidenceDecisionAnswer, note: String? = nil) {
        self.decidingSessionId = decidingSessionId
        self.evidenceRevision = evidenceRevision
        self.decision = decision
        self.note = note
    }
}

/// What the door returns once it has recorded one — read back, never recomputed by a client.
public struct EvidenceDecisionResult: Codable, Equatable, Sendable {
    public let taskId: String
    public let evidenceRevision: String
    public let decision: EvidenceDecisionAnswer
    public let note: String?
    /// ISO-8601, as JSON carries it. Never parsed here.
    public let decidedAt: String

    public init(taskId: String, evidenceRevision: String, decision: EvidenceDecisionAnswer,
                note: String? = nil, decidedAt: String) {
        self.taskId = taskId
        self.evidenceRevision = evidenceRevision
        self.decision = decision
        self.note = note
        self.decidedAt = decidedAt
    }
}

// MARK: - where one delivered card stands right now

/// The four shapes a delivered card can be in. Three are states of the EVIDENCE, read off the
/// queue; `unread` is a state of this CLIENT and gets the same treatment for the same reason — a
/// card that cannot re-derive itself cannot say the door would accept anything.
public struct EvidenceDecisionStanding: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// The revision is in the read, and the read still says this session may answer it.
        case decidable(EvidenceDecisionRow)
        /// It is gone, and the same task is in the read at a LATER revision. The door answers only a
        /// task's latest evidence, so every answer to this one would be refused; the later revision
        /// is its own card.
        case superseded(replacement: EvidenceDecisionRow)
        /// It is gone and nothing later has taken its place: it was answered.
        case alreadyDecided
        /// The read has not come back.
        case unread
    }

    public let taskId: String
    public let evidenceRevision: String
    public let state: State

    public init(taskId: String, evidenceRevision: String, state: State) {
        self.taskId = taskId
        self.evidenceRevision = evidenceRevision
        self.state = state
    }

    /// The row this card is rendering, or nil when the read no longer publishes one. A stale card
    /// has no evidence to show: see the file header.
    public var row: EvidenceDecisionRow? {
        if case .decidable(let row) = state { return row }
        return nil
    }

    /// Whether the door would take an answer from this card: true for exactly one of the four.
    public var answerable: Bool { row != nil }
}

// MARK: - what the card shows

/// One machine-checkable statement about the row, in the row's own fields.
public struct EvidenceDecisionCheck: Equatable, Sendable, Identifiable {
    public let ok: Bool
    public let text: String
    /// What the reader would go and look at: the standard itself, or the door's words for a check
    /// that did not hold. Nil when the line says everything there is.
    public let detail: String?
    public var id: String { text }
}

/// The claim at its clamp, and whether it is long enough that the card folds it away behind
/// `claimFold` instead of showing it where it stands.
public struct FoldedClaim: Equatable, Sendable {
    public let text: String
    public let folded: Bool
}

/// The gaps a card shows at rest, and the ones it counts instead.
public struct GapPreview: Equatable, Sendable {
    public let shown: [String]
    public let rest: [String]
}

/// The send-back half of the action area, as state a view holds and a test can assert on.
///
/// It is a value rather than three loose `@State` booleans so that "the send control is dead until
/// a reason exists" is one testable predicate instead of a condition spelled into a view modifier.
/// The rule it encodes belongs to the server: the decision door refuses a SEND_BACK carrying no
/// note and writes NOTHING at all, so a control that would send one cannot be pressable.
public struct EvidenceSendBackState: Equatable, Sendable {
    /// Whether the reason box is open. Closed until `Send back` is pressed: a permanently visible
    /// box reads like an invitation to say something rather than like the one thing that makes the
    /// button work — which is exactly how the generic form's `Or type your own answer…` read.
    public var open: Bool
    public var note: String

    public init(open: Bool = false, note: String = "") {
        self.open = open
        self.note = note
    }

    /// The note as it would be sent: trimmed, because whitespace is not a reason.
    public var trimmedNote: String {
        note.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether the send control may be pressed. The one rule both clients are under: an action
    /// that cannot succeed is disabled.
    public var canSend: Bool { !trimmedNote.isEmpty }
}

// MARK: - the logic

public enum EvidenceDecisions {

    // MARK: which rows get a card, and where one stands

    /// The rows this conversation gets a card for.
    ///
    /// `pending` is already scoped by the server to rows this session may decide. The first two
    /// checks are the second half of that rule, read off the door's own answers carried on the row;
    /// the third is the card's own — a conversation shows the judgments of the project it
    /// coordinates, and a row from another project, or from none, gets no card there.
    public static func cardRows(queue: EvidenceDecisionQueue?,
                                projectId: String?) -> [EvidenceDecisionRow] {
        guard let projectId else { return [] }
        return (queue?.pending ?? []).filter { row in
            row.decidability.decidable && row.independence.independent && row.projectId == projectId
        }
    }

    /// Where one delivered card stands RIGHT NOW, derived from the read and from nothing else.
    /// A nil queue is the read not having come back, which is `unread` and not "nothing pending".
    public static func standing(queue: EvidenceDecisionQueue?, projectId: String?, taskId: String,
                                evidenceRevision: String) -> EvidenceDecisionStanding {
        EvidenceDecisionStanding(
            taskId: taskId, evidenceRevision: evidenceRevision,
            state: state(queue: queue, projectId: projectId, taskId: taskId,
                         evidenceRevision: evidenceRevision))
    }

    private static func state(queue: EvidenceDecisionQueue?, projectId: String?, taskId: String,
                              evidenceRevision: String) -> EvidenceDecisionStanding.State {
        guard let queue else { return .unread }
        let rows = cardRows(queue: queue, projectId: projectId)
        if let row = rows.first(where: { row in
            row.taskId == taskId && row.evidenceRevision == evidenceRevision
        }) {
            return .decidable(row)
        }
        if let replacement = rows.first(where: { row in
            row.taskId == taskId && isLaterRevision(row.evidenceRevision, than: evidenceRevision)
        }) {
            return .superseded(replacement: replacement)
        }
        return .alreadyDecided
    }

    /// Revisions are decimal strings of up to 19 digits, so they are compared as digits: `10` is
    /// later than `9`, which comparing the two strings would get backwards.
    private static func isLaterRevision(_ candidate: String, than: String) -> Bool {
        candidate.count == than.count ? candidate > than : candidate.count > than.count
    }

    /// Whether this card is still a QUESTION — which is not the same as whether it can be answered.
    ///
    /// The bar above the transcript counts by this and the buttons are gated by `answerable`, and
    /// the two differ in exactly one case, for the reason `CriteriaDecisions.isOpen` gives: a card
    /// this device could not re-derive is unanswerable and still open.
    public static func isOpen(_ standing: EvidenceDecisionStanding) -> Bool {
        switch standing.state {
        case .decidable, .unread:          return true
        case .superseded, .alreadyDecided: return false
        }
    }

    // MARK: the copy
    //
    // Every string below is the one its web twin uses, and `EvidenceDecisionCopyParityTests`
    // checks that by reading `EvidenceDecisionCard.tsx`. Two clients wording one judgment
    // differently is two judgments that happen to write the same row.

    /// The card's heading (`DECISION_ASK_HEADING`).
    public static let askHeading = "Does this evidence settle the task?"
    /// The heading a card that can no longer be answered carries instead
    /// (`EVIDENCE_DECISION_STALE_HEADING`).
    public static let staleHeading = "This evidence is no longer waiting on you"
    /// And the one for a card this device could not re-derive just now
    /// (`EVIDENCE_DECISION_UNREAD_HEADING`).
    public static let unreadHeading = "This card could not be re-read just now"
    /// 'Confirm done' submits on the press itself (`DECISION_CONFIRM_ACTION`). A pick-then-Submit step
    /// exists for a form with several questions and several picks per question; in a two-way
    /// judgment it buys nothing but one more press between a reader and the thing they already
    /// decided.
    public static let confirmAction = "Confirm done"
    public static let sendBackAction = "Send back"
    /// The send-back's own submit, behind the reason box rather than beside it.
    public static let sendAction = "Send it back"
    /// Why the reason is required rather than a placeholder somebody may ignore: the decision door
    /// refuses a SEND_BACK carrying no note and writes nothing at all.
    public static let noteLabel =
        "What does the next version of the evidence have to show? It is the only thing the next "
        + "attempt can aim at."
    public static let notePlaceholder =
        "For example: run the pg spec, and show the raw output of it failing before the fix…"
    /// Evidence from before the envelope has no claim at all; the line says so rather than
    /// rendering a blank where the card's lead should be.
    public static let noClaim = "This version of the evidence states no claim."
    public static let noCriterion = "no acceptance criterion cited"
    public static let noGaps = "the submitter declares nothing missing"
    /// The heading over the criterion's own text (`DECISION_CRITERION_HEADING`). The question is
    /// whether this evidence settles THAT sentence, and a key is not a sentence — so the text
    /// leads the card and the key stays in the meta line, where identity belongs.
    public static let criterionHeading = "WHAT IT HAS TO SATISFY"
    /// The submitter's account, folded to one line carrying its length (`decisionClaimFold`): the
    /// longest field on the card and the least decisive.
    public static func claimFold(_ chars: Int) -> String {
        "the submitter’s full account (\(chars) characters)"
    }
    public static let claimHide = "Hide the account"

    /// The door's two refusals that mean "this card is out of date", in the door's own spelling, so
    /// a card can say which one it would meet.
    public static let alreadyDecidedRefusal = "EVIDENCE_JUDGMENT_ALREADY_DECIDED"
    public static let supersededRefusal = "EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED"

    /// The gaps that did not fit, counted rather than dropped: they are the body of this card.
    public static func gapsMore(_ rest: Int) -> String { "\(rest) more" }

    /// The gaps heading: a count, so "less is shown" never means "something is hidden".
    public static func gapsHeading(_ total: Int) -> String {
        total == 0 ? noGaps : "WHAT THIS EVIDENCE DOES NOT ESTABLISH · \(total)"
    }

    /// The folded line over the three machine checks. `held` leads because a check that held is a
    /// reason to stop reading; what did not hold is named beside it rather than left to the fold.
    public static func checksHeading(held: Int, total: Int) -> String {
        held == total
            ? "\(held) checked for you"
            : "\(held) checked for you · \(total - held) did not hold"
    }

    // MARK: the standing, in words

    /// Which of three things the reader is looking at: a question, one that has moved on, or a card
    /// this device could not re-derive.
    public static func heading(_ standing: EvidenceDecisionStanding) -> String {
        switch standing.state {
        case .decidable:                   return askHeading
        case .unread:                      return unreadHeading
        case .superseded, .alreadyDecided: return staleHeading
        }
    }

    /// What a card shows once the read no longer publishes its row: the address, and nothing else.
    public static func addressLine(_ standing: EvidenceDecisionStanding) -> String {
        "\(standing.taskId) · rev \(standing.evidenceRevision)"
    }

    /// Why this card cannot be answered, addressed to the reader looking at its dead buttons.
    ///
    /// Each sentence names the refusal the door would give, because that is the fact: a reader told
    /// only "you cannot" has been told the button is broken.
    public static func staleExplanation(_ standing: EvidenceDecisionStanding) -> String? {
        switch standing.state {
        case .decidable:
            return nil
        case .superseded(let replacement):
            var out = "Superseded: this task has submitted version "
            out += "\(replacement.evidenceRevision) of its evidence since, and the door decides only "
            out += "the latest — any decision about version \(standing.evidenceRevision) would be "
            out += "refused (\(supersededRefusal)). Nothing was recorded here; version "
            out += "\(replacement.evidenceRevision) has its own card."
            return out
        case .alreadyDecided:
            var out = "Already answered: this version is no longer pending, its decision was "
            out += "recorded somewhere else, and a decision sent from this card would be refused "
            out += "(\(alreadyDecidedRefusal)). This card recorded nothing for you, and cannot "
            out += "change what was."
            return out
        case .unread:
            var out = "The pending read did not come back just now, so this card cannot say what "
            out += "it is asking. It keeps no copy of the evidence — every line is re-derived from "
            out += "the read — and a decision the door might refuse is not offered. The evidence "
            out += "itself is unaffected."
            return out
        }
    }

    // MARK: the body, in the order a person decides in

    /// How many gaps the card shows before it starts counting.
    ///
    /// Three, and NOT platform-forked, unlike the claim clamp below. This one is a contract with
    /// the other client rather than a judgment about width: the same evidence has to report the
    /// same "3 shown, N more" on a phone and in a browser, or the two ends disagree about how much
    /// the submitter admitted. What a narrow screen gives up is the checks — never any of this.
    public static let gapsShown = 3

    /// Where a claim starts folding on a 390pt phone, and in a macOS window.
    ///
    /// Two constants because the two clients are read at different widths, and one number for both
    /// would be wrong at one of them: a claim that fits a macOS transcript column on one line eats
    /// four lines of a phone and pushes the gaps and the actions off the screen, while clamping the
    /// window to the phone's number folds a sentence that had room to be read. The FOLD is shared;
    /// the threshold is not.
    public static let claimClampCompact = 90
    public static let claimClampRegular = 220

    /// The clamp for the client this is compiled into. iOS is the compact one; macOS is not.
    #if os(iOS)
    public static let claimClamp = claimClampCompact
    #else
    public static let claimClamp = claimClampRegular
    #endif

    /// The claim as the card shows it at rest — the lead line, folded only when it would crowd out
    /// what the reader is actually judging.
    public static func foldedClaim(_ claim: String, clamp: Int) -> FoldedClaim {
        let trimmed = claim.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > clamp else { return FoldedClaim(text: trimmed, folded: false) }
        return FoldedClaim(text: String(trimmed.prefix(clamp)) + "…", folded: true)
    }

    /// The line under the claim: which task, which revision, which standard. Identity, not
    /// substance, which is why it sits below the claim and above nothing.
    public static func meta(_ row: EvidenceDecisionRow) -> String {
        "\(row.taskId) · rev \(row.evidenceRevision) · "
            + (row.criterion.map(\.key) ?? noCriterion)
    }

    /// The gaps split into the ones shown and the ones counted.
    public static func gapPreview(_ row: EvidenceDecisionRow) -> GapPreview {
        GapPreview(shown: Array(row.gaps.prefix(gapsShown)),
                   rest: Array(row.gaps.dropFirst(gapsShown)))
    }

    /// The three things nobody has to take on faith, folded into one line.
    ///
    /// Each is a structured field the server already computed, so this is a reading of the row
    /// rather than an opinion about it — which is exactly why they fold and the gaps do not: a
    /// check that held is a reason to stop reading, and a gap is a reason to keep going.
    public static func checks(_ row: EvidenceDecisionRow) -> [EvidenceDecisionCheck] {
        let resolved = row.citations.filter(\.resolved)
        let unresolved = row.citations.filter { !$0.resolved }
        return [
            EvidenceDecisionCheck(
                ok: row.decidability.decidable,
                text: "the criterion it cites is still the live one",
                detail: row.decidability.decidable
                    ? row.criterion.map { "\($0.key) · \($0.text)" }
                    : row.decidability.refusal),
            EvidenceDecisionCheck(
                ok: !row.citations.isEmpty && unresolved.isEmpty,
                text: "\(resolved.count)/\(row.citations.count) citations resolved",
                detail: unresolved.isEmpty
                    ? nil
                    : unresolved.map { "\($0.ref): \($0.reason ?? "unresolved")" }
                        .joined(separator: "\n")),
            EvidenceDecisionCheck(
                ok: row.independence.independent,
                text: "the decider is independent of this submission",
                detail: row.independence.independent ? nil : row.independence.disqualification),
        ]
    }

    /// How many of them held — the number the folded line leads with.
    public static func heldCount(_ row: EvidenceDecisionRow) -> Int {
        checks(row).filter(\.ok).count
    }

    // MARK: the answer

    /// The request one press makes, as data, so what goes to the door can be asserted without a
    /// network — the same tactic the web card takes with `evidenceDecisionRequest`.
    ///
    /// Nil for a send-back without a reason: the door refuses a SEND_BACK carrying no note and
    /// writes nothing at all, so there is no request worth making. The reason is trimmed, because
    /// whitespace is not one, and it rides with a send-back and with nothing else.
    public static func request(row: EvidenceDecisionRow, decision: EvidenceDecisionAnswer,
                               note: String? = nil,
                               decidingSessionID: String) -> EvidenceDecisionRequest? {
        switch decision {
        case .confirm:
            return EvidenceDecisionRequest(decidingSessionId: decidingSessionID,
                                           evidenceRevision: row.evidenceRevision,
                                           decision: .confirm)
        case .sendBack:
            let reason = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !reason.isEmpty else { return nil }
            return EvidenceDecisionRequest(decidingSessionId: decidingSessionID,
                                           evidenceRevision: row.evidenceRevision,
                                           decision: .sendBack, note: reason)
        }
    }

    /// What an answer given from a card leaves where it was given: the door's receipt, in the card's
    /// own words (`evidenceDecisionRecordedLine`).
    ///
    /// Only the card whose button was pressed is handed this. The record that OUTLIVES the console
    /// is `receipts` below, drawn from the read.
    public static func recordedLine(_ result: EvidenceDecisionResult) -> String {
        let action = result.decision == .confirm ? confirmAction : sendBackAction
        let line = "Recorded: \(action) · rev \(result.evidenceRevision)"
        guard let note = result.note, !note.isEmpty else { return line }
        return "\(line) — \(note)"
    }

    // MARK: the receipt an answered revision leaves

    /// What a receipt says it is, where the card asked a question. Web's
    /// `EVIDENCE_DECISION_RECORDED_HEADING` and `EVIDENCE_DECISION_AGENT_RECORDED_HEADING`, word for
    /// word — a run of this session reaching the door is a different event from the owner pressing a
    /// card, and the heading is where a reader tells them apart.
    public static let recordedHeading = "Decision recorded"
    public static let agentRecordedHeading = "An agent recorded a decision"
    /// The label over a send-back's reason, as the receipt shows it (web: `DECISION_RECEIPT_REASON`).
    public static let receiptReasonLabel = "the reason it was sent back"

    private static let receiptClockFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()
    private static let receiptDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        return f
    }()

    /// When a receipt says it was decided: the clock on the day it happened, the date as well after
    /// — a bare "5:42" on a receipt a week old reads as this morning. Web's `decisionReceiptTime`,
    /// same rule.
    public static func receiptTime(_ decidedAt: String, now: Date = Date()) -> String {
        guard let at = ThinkingSummary.date(decidedAt) else { return decidedAt }
        let sameDay = Calendar.current.isDate(at, inSameDayAs: now)
        return (sameDay ? receiptClockFormatter : receiptDayFormatter).string(from: at)
    }

    /// The receipt's line: which answer, to which revision, and when — web's `decisionReceiptLine`,
    /// word for word.
    public static func receiptLine(_ decided: RecordedEvidenceDecision,
                                   now: Date = Date()) -> String {
        let action = decided.decision == .confirm ? confirmAction : sendBackAction
        return "\(action) · rev \(decided.evidenceRevision) · \(receiptTime(decided.decidedAt, now: now))"
    }

    /// One answer this console draws as a record, and the item it belongs after.
    public struct Receipt: Equatable, Sendable, Identifiable {
        public let decided: RecordedEvidenceDecision
        public let afterItemID: String

        public init(decided: RecordedEvidenceDecision, afterItemID: String) {
            self.decided = decided
            self.afterItemID = afterItemID
        }

        /// Beside the question card's id rather than equal to it — see `DeliveredDecisionCard`,
        /// where both rows can be on screen at once for one revision.
        public var id: String { "evidence-decision-receipt-\(decided.id)" }
    }

    /// The receipts this console draws for the revisions ITS session has answered.
    ///
    /// WHY THIS IS NOT THE PRESSING WINDOW'S
    /// -------------------------------------
    /// A receipt used to be written by the console that pressed (`appendDecisionLine`) and kept in
    /// memory, so closing the console or relaunching the app took the decision out of the
    /// conversation — the same defect the criteria receipt had, reported by the account owner on
    /// 2026-09-16. The answers are committed rows the pending read publishes (`decided`, scoped to
    /// the deciding session), so they are derived here like everything else on a card, and a device
    /// that never saw the question still shows what was decided.
    ///
    /// Placed by `ReceiptAnchor` — the last item at or before the door's clock — and NOT drawn at
    /// all when that moment is older than everything this console holds: the window starts at the
    /// tail, so such a receipt has no honest place to go.
    public static func receipts(queue: EvidenceDecisionQueue?,
                                items: [TranscriptItem]) -> [Receipt] {
        guard let queue else { return [] }
        return queue.decided.compactMap { decided in
            guard let anchor = ReceiptAnchor.after(items: items, at: decided.decidedAt) else {
                return nil
            }
            return Receipt(decided: decided, afterItemID: anchor)
        }
    }

    /// Whether the read says this revision was answered — what makes its question card give way.
    public static func answered(_ queue: EvidenceDecisionQueue?, taskID: String,
                                evidenceRevision: String) -> Bool {
        queue?.decided.contains { $0.taskId == taskID && $0.evidenceRevision == evidenceRevision }
            ?? false
    }
}
