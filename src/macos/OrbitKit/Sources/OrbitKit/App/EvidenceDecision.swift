import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE EVIDENCE-DECISION CARD — THE OTHER HALF OF WEB'S `ApprovalPanel.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   THE GENERIC FORM STAYS THE DEFAULT, AND THIS IS THE ONE EXCEPTION TO IT
   ----------------------------------------------------------------------
   Everything here fires for a single shape: the card `coordinator-evidence-ask.ts` raises so a
   person can answer "is this work finished". Every other AskUserQuestion — including one whose
   two options happen to read alike — falls through to the option rows + Submit that `Approvals`
   already parses, which is what the tool actually is: a form over options nobody has seen before.

   Recognising a question by what it is ABOUT is a cost, and it is taken deliberately rather than
   drifted into. A client that grows one card per kind of question ends up with N surfaces for one
   fact, and this account has already paid for that: two decision surfaces raced on 2026-09-09 and
   the loser came back `EVIDENCE_JUDGMENT_ALREADY_DECIDED`. So the rule is written down — ONE
   special case, this one, and a second one needs a better reason than "this question would look
   nicer as a card". What earns this one its exception is that it is not multiple choice at all: it
   is a judgment about a row the server already publishes in full, and the generic form was
   throwing that row away.

   THE CARD READS THE ROW, NOT THE QUESTION TEXT
   ---------------------------------------------
   `evidenceQuestionBody` flattens the claim, the criterion and the gaps into one string because a
   tool input is all AskUserQuestion carries. Rendering THAT is what produced the wall of text this
   card replaces. So the string is used for exactly two things — to say WHICH row is being asked
   about, and, verbatim and folded away, as the full text — while every line above that fold is
   read off `EvidenceDecisionRow`: the same row the web rail renders, out of the same
   `?decidingSessionId=` read, scoped by the same server rule. Nothing on the card is summarised,
   re-worded or inferred; each visible string is a field of that row or a count of one.

   ONE SOURCE FOR TWO CLIENTS
   --------------------------
   This is the shared half. The recognition rule, the order of the body, the copy and the send-back
   gate live here so macOS and iOS cannot disagree about them, and so they can be tested on Linux
   where no SwiftUI exists. What does NOT live here is the one thing that genuinely differs between
   a 390pt phone and a macOS window: how much of a claim fits before it folds — see
   `claimClampCompact` / `claimClampRegular`. Structure is shared; width is not.

   The mirror on the other side is `src/web/src/components/ApprovalPanel.tsx` (the card) and
   `DecisionRail.tsx` (the row and the two option labels). `EvidenceDecisionCopyParityTests` reads
   that file and fails when the words drift, because "one end says 机器已核 and the other says
   提交者自述" is the failure this whole pair of tasks exists to prevent.
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

    /// A row is one revision of one task — the same key the question's identity line spells out.
    public var id: String { "\(taskId)#\(evidenceRevision)" }

    public init(taskId: String, title: String, criterion: EvidenceDecisionCriterion?,
                evidenceRevision: String, ageSeconds: Int? = nil, claim: String, gaps: [String],
                citations: [EvidenceDecisionCitation],
                decidability: EvidenceDecisionDecidability,
                independence: EvidenceDecisionIndependence) {
        self.taskId = taskId
        self.title = title
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

    public init(decidingSessionId: String, count: Int, oldestAgeSeconds: Int? = nil,
                pending: [EvidenceDecisionRow], waitingOnYou: [EvidenceDecisionRow] = []) {
        self.decidingSessionId = decidingSessionId
        self.count = count
        self.oldestAgeSeconds = oldestAgeSeconds
        self.pending = pending
        self.waitingOnYou = waitingOnYou
    }
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

/// The claim as it is shown, and whether anything was folded away behind "展开全文".
public struct FoldedClaim: Equatable, Sendable {
    public let text: String
    public let folded: Bool
}

/// The gaps a card shows at rest, and the ones it counts instead.
public struct GapPreview: Equatable, Sendable {
    public let shown: [String]
    public let rest: [String]
}

/// What one press of the card's action area means. `chat` is the third answer and deliberately the
/// third: not judging yet is useful — it rides back as a `deny` with a message, exactly as the
/// generic form's "Chat about this" does — but it is not a verdict, so it does not get one's weight.
public enum EvidenceDecisionAction: Equatable, Sendable {
    case confirm
    case sendBack(note: String)
}

/// The send-back half of the action area, as state a view holds and a test can assert on.
///
/// It is a value rather than three loose `@State` booleans so that "the send control is dead until
/// a reason exists" is one testable predicate instead of a condition spelled into a view modifier.
/// The rule it encodes belongs to the server: the decision door refuses a SEND_BACK carrying no
/// note and writes NOTHING at all, so a control that would send one cannot be pressable.
public struct EvidenceSendBackState: Equatable, Sendable {
    /// Whether the reason box is open. Closed until `退回重做` is pressed: a permanently visible
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

    /// The action this state would send, or nil while it could not succeed.
    public var action: EvidenceDecisionAction? {
        canSend ? .sendBack(note: trimmedNote) : nil
    }
}

// MARK: - the logic

public enum EvidenceDecisions {

    // MARK: recognising the one question this file knows

    /// `DecisionRail.tsx`'s two labels, which `coordinator-evidence-ask.ts` copies into the tool
    /// input. Copied again here rather than derived: the invariant is that the WORDS match across
    /// three packages, and a copy is the only form of it a Swift test can compare.
    public static let confirmOption = "Confirm completion"
    public static let sendBackOption = "Send back"

    /// The identity `evidenceQuestionBody` writes into the end of every decision question.
    ///
    /// The server puts it there so two rows whose claims read alike cannot collapse onto one
    /// `answers` key. It is the ONLY part of that body this file reads, and it is read as a handle:
    /// which row is this question about. A question naming no row this session may decide is not a
    /// decision card and renders as the ordinary form — which is also what happens if the server
    /// ever words that line differently, so the failure is a card that looks like it did yesterday
    /// rather than a wrong one.
    public static func askIdentity(_ row: EvidenceDecisionRow) -> String {
        "task \(row.taskId), evidence rev \(row.evidenceRevision)"
    }

    /// The row one question is about, or nil when it is not one of these questions at all.
    public static func row(for question: AskQuestion,
                           in rows: [EvidenceDecisionRow]) -> EvidenceDecisionRow? {
        let labels = question.options.map(\.label)
        guard labels.count == 2,
              labels.contains(confirmOption), labels.contains(sendBackOption) else { return nil }
        let matched = rows.filter { question.question.contains(askIdentity($0)) }
        return matched.count == 1 ? matched[0] : nil
    }

    /// The rows an approval is asking about, or nil for every other question in the world.
    ///
    /// All or nothing on purpose: a card rendering some of its questions as judgments and the rest
    /// as a form would be two cards in one, with one Submit between them. Either the whole ask is
    /// the one shape this file knows, or none of it is.
    ///
    /// Only `pending` is consulted — those are the rows the door would take an answer to from this
    /// session, which is the same set the server built the ask from.
    public static func rows(for approval: PendingApproval,
                            queue: EvidenceDecisionQueue?) -> [EvidenceDecisionRow]? {
        guard Approvals.isQuestion(toolName: approval.toolName ?? ""), let input = approval.input
        else { return nil }
        let questions = Approvals.parseQuestions(from: input)
        guard !questions.isEmpty else { return nil }
        let pending = queue?.pending ?? []
        var matched: [EvidenceDecisionRow] = []
        for question in questions {
            guard let row = row(for: question, in: pending) else { return nil }
            matched.append(row)
        }
        return matched
    }

    // MARK: the copy
    //
    // Every string below is the one its web twin uses, and `EvidenceDecisionCopyParityTests`
    // checks that by reading `ApprovalPanel.tsx`. Two clients wording one judgment differently is
    // two judgments that happen to write the same row.

    /// The card's heading (`DECISION_ASK_HEADING`).
    public static let askHeading = "需要你裁决"
    /// `确认完成` submits on the press itself (`DECISION_CONFIRM_ACTION`). The generic form's
    /// pick-then-Submit exists for a form with several questions and several picks per question; in
    /// a two-way judgment it buys nothing but one more press between a reader and the thing they
    /// already decided.
    public static let confirmAction = "确认完成"
    public static let sendBackAction = "退回重做"
    /// The send-back's own submit, behind the reason box rather than beside it.
    public static let sendAction = "退回"
    /// The third answer (`DECISION_CHAT_ACTION` without its leading emoji: the native card draws an
    /// SF Symbol there, which is the same signal in the platform's own alphabet).
    public static let chatAction = "先聊聊，暂不裁决"
    /// Why the reason is required rather than a placeholder somebody may ignore: the decision door
    /// refuses a SEND_BACK carrying no note and writes nothing at all.
    public static let noteLabel = "下一版证据要给出什么？这句话是下一次尝试唯一能瞄准的东西。"
    public static let notePlaceholder = "例如：把 pg spec 跑一遍，并给出改前先红的原始输出…"
    /// Evidence from before the envelope has no claim at all; the line says so rather than
    /// rendering a blank where the card's lead should be.
    public static let noClaim = "这一版证据没有写下主张。"
    public static let noCriterion = "未引用验收条目"
    public static let noGaps = "提交者声明没有缺口"
    public static let fullLabel = "完整证据正文"

    /// The gaps that did not fit, counted rather than dropped: they are the body of this card.
    public static func gapsMore(_ rest: Int) -> String { "还有 \(rest) 条" }

    /// The gaps heading: a count, so "less is shown" never means "something is hidden".
    public static func gapsHeading(_ total: Int) -> String {
        total == 0 ? noGaps : "提交者声明的缺口 · \(total) 条"
    }

    /// The folded line over the three machine checks. `held` leads because a check that held is a
    /// reason to stop reading; what did not hold is named beside it rather than left to the fold.
    public static func checksHeading(held: Int, total: Int) -> String {
        held == total ? "\(held) 项机器已核" : "\(held) 项机器已核 · \(total - held) 项没过"
    }

    // MARK: the body, in the order a person decides in

    /// How many gaps the card shows before it starts counting.
    ///
    /// Three, and NOT platform-forked, unlike the claim clamp below. This one is a contract with
    /// the other client rather than a judgment about width: the same evidence has to report the
    /// same "3 shown, N more" on a phone and in a browser, or the two ends disagree about how much
    /// the submitter admitted. What a narrow screen gives up is the full text and the checks —
    /// never any of this.
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
                text: "引用的验收条目仍是线上那一条",
                detail: row.decidability.decidable
                    ? row.criterion.map { "\($0.key) · \($0.text)" }
                    : row.decidability.refusal),
            EvidenceDecisionCheck(
                ok: !row.citations.isEmpty && unresolved.isEmpty,
                text: "\(resolved.count)/\(row.citations.count) 条引用解析成功",
                detail: unresolved.isEmpty
                    ? nil
                    : unresolved.map { "\($0.ref)：\($0.reason ?? "未解析")" }
                        .joined(separator: "\n")),
            EvidenceDecisionCheck(
                ok: row.independence.independent,
                text: "裁决人独立于这次提交",
                detail: row.independence.independent ? nil : row.independence.disqualification),
        ]
    }

    /// How many of them held — the number the folded line leads with.
    public static func heldCount(_ row: EvidenceDecisionRow) -> Int {
        checks(row).filter(\.ok).count
    }

    // MARK: the answer

    /// The `answers` payload for one decision, in the shape `evidenceDecisionFromAnswers` reads:
    /// keyed by the question's own text, carrying the server's own option label. A send-back puts
    /// its reason second, which is the same shape the generic form has always used for a typed
    /// answer beside a picked one.
    public static func answers(question: String,
                               action: EvidenceDecisionAction) -> [String: [String]] {
        switch action {
        case .confirm:
            return [question: [confirmOption]]
        case .sendBack(let note):
            return [question: [sendBackOption, note]]
        }
    }

    /// The chip over one card in a delivery that found several rows waiting.
    public static func positionChip(index: Int, total: Int) -> String {
        "证据 \(index + 1)/\(total)"
    }

    /// What the card says once a row has been answered but its siblings have not. A tool call is
    /// answered once, so a delivery asking about three rows holds the first two picks rather than
    /// sending a partial the other two are lost from.
    public static func pickedNote(_ label: String) -> String {
        "已选「\(label == confirmOption ? confirmAction : sendBackAction)」"
    }
}
