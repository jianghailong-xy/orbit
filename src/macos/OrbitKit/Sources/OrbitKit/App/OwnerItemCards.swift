import Foundation

/// The three owner cards this client draws, as pure logic: what each says, when each is answerable,
/// and what a press sends (contract §7.5, mocks 4, 5 and 6 ①).
///
/// WHY THE WORDS ARE HERE AND NOT IN THE VIEW. They are the web's words, and the two clients must
/// not drift: a person who reads "Approve merge to main" in a banner, opens the card and finds a
/// third paraphrase of it has been told the same fact three ways. Every string below names the web
/// export it copies (`CoordinatorQuestionCard.tsx`, mock 4), and the tests read them rather than
/// reading a view — which is also what makes them testable on Linux, where no SwiftUI exists.
///
/// WHY A STANDING RATHER THAN A ROW. Same rule as `CriteriaDecision.swift`: a card is delivered
/// once and then re-derived from the read on every render, and "the read has not answered yet" is
/// a third state that must never be drawn as "the question went away". A card whose question is
/// gone says so and stops being counted; it does not vanish.

// MARK: - the coordinator's question

/// What the read says about one question right now.
public enum CoordinatorQuestionStanding: Equatable, Sendable {
    /// No read has come back. The card draws with dead buttons rather than claiming anything.
    case unread
    /// The question, as the owner's own read publishes it.
    case open(ProjectOpenItemRow)
    /// The read came back and this question is not in it: answered here, answered elsewhere, or
    /// withdrawn. The card stays on screen saying so — it is the only thing that can explain it.
    case gone
}

public enum CoordinatorQuestions {
    /// The heading, the provenance mark and the button, in the web card's own spelling.
    public static let heading = "The coordinator has a question"
    public static let provenance = "FROM COORDINATOR"
    public static let provenanceTitle =
        "Orbit filed this question on behalf of the conversation coordinating this project. "
        + "It is not something an agent turn wrote into this page."
    public static let sendAnswer = "Send answer"
    public static let recommended = "Recommended"
    public static let answeredHeading = "Answered"
    public static let deliveredToCoordinator = "delivered to the current coordinator"
    public static let waitingForCoordinator = "waiting for this project’s next coordinator"
    /// What a card whose question the read no longer carries says about itself.
    public static let gone = "This question is no longer open."
    public static let unreadable = "Couldn’t read this question — pull to retry."
    /// The placeholder on a question asked without options, matching the web's textarea.
    public static let freeAnswerPrompt = "Your answer"

    /// The questions on a project's open items: the owner's group only. A question is filed with
    /// the OWNER on it, so one in the coordinator's group would be a row this card cannot answer.
    public static func open(_ items: ProjectOpenItemsView?) -> [ProjectOpenItemRow] {
        (items?.needsYou ?? []).filter { $0.kind == .coordinatorQuestion && $0.question != nil }
    }

    /// Where one question stands, by the address the card was delivered under.
    public static func standing(items: ProjectOpenItemsView?, itemId: String) -> CoordinatorQuestionStanding {
        guard let items else { return .unread }
        guard let row = open(items).first(where: { $0.itemId == itemId }) else { return .gone }
        return .open(row)
    }

    /// Whether this card is still a question waiting on the reader — what the "open questions
    /// below" bar counts. An unreadable standing is NOT counted: pointing somebody at a card that
    /// cannot say what it is asking is worse than saying nothing.
    public static func isOpen(_ standing: CoordinatorQuestionStanding) -> Bool {
        if case .open = standing { return true }
        return false
    }

    /// Whether the press may be made: a choice when the question offers options, and any non-empty
    /// text when it does not. The door's own rule (`answerOpenItem`), so a button that is live is
    /// a button whose press the server will take.
    public static func sendable(question: CoordinatorQuestion, chosen: Int?, text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return question.options.isEmpty ? !trimmed.isEmpty : chosen != nil
    }

    /// What to send: the option, the text, or both — the web card's own `send`.
    public static func request(question: CoordinatorQuestion, chosen: Int?, text: String) -> OwnerAnswerRequest? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sendable(question: question, chosen: chosen, text: trimmed) else { return nil }
        if question.options.isEmpty { return OwnerAnswerRequest(text: trimmed) }
        return OwnerAnswerRequest(option: chosen, text: trimmed.isEmpty ? nil : trimmed)
    }

    /// What the owner chose, in the words the card showed it in — the receipt's own line.
    public static func answerInWords(question: CoordinatorQuestion, option: Int?, text: String) -> String {
        let chosen = option.flatMap { question.options.indices.contains($0) ? question.options[$0].label : nil }
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = [chosen, typed.isEmpty ? nil : typed].compactMap { $0 }
        return parts.isEmpty ? "(no answer given)" : parts.joined(separator: " — ")
    }

    /// `asked 2h ago`, the card's footnote — the web's `ago`, so the two agree on the rounding.
    public static func askedLine(since: String, now: Date = Date()) -> String {
        "asked \(RelativeTime.ago(since, now: now) ?? "just now")"
    }

    /// The receipt's second line: who answered, and whether anybody has been told yet (R11).
    public static func receiptLine(delivered: Bool) -> String {
        "by you · \(delivered ? deliveredToCoordinator : waitingForCoordinator)"
    }
}

// MARK: - the merge into main

/// Which of the confirmation card's four states a candidate is in (mock 4, §7.5).
public enum PromotionStage: Equatable, Sendable {
    /// A: checks passed, waiting for the owner.
    case askingYou
    /// B: confirmed, and landing on its own — possibly re-checking because the upstream moved.
    case merging
    /// C: merged. The card becomes the receipt.
    case merged
    /// D: it cannot merge yet, and the coordinator is on it.
    case blocked
}

public enum PromotionCards {
    public static let mergeToMain = "Merge to main"
    public static let notNow = "Not now"
    public static let merging = "Merging…"
    public static let cancel = "Cancel"
    public static let openCoordinator = "Open coordinator"
    /// §7.5's provenance mark — the same one the exception and blocker cards carry.
    public static let provenance = "FROM ORBIT"
    public static let mergedHeading = "✓ Merged into main"
    /// C's heading when nobody pressed Merge — web's `MERGED_AUTOMATICALLY_HEADING`. The receipt is
    /// the only place the owner learns the Automatic setting merged it (§3.3 M-T11), so it says so
    /// first.
    public static let mergedAutomaticallyHeading = "✓ Merged into main automatically"
    /// Who merged it, where a pressed merge says "by you" — web's `UNDER_AUTOMATIC`.
    public static let underAutomatic = "under your Automatic setting"
    /// What a card whose candidate the read no longer publishes says about itself: a newer
    /// candidate replaced it, or it was answered at another end. It stays on screen saying so —
    /// a card that vanished would leave the reader wondering what they had been about to press.
    public static let supersededTitle = "This merge is no longer on offer"
    public static let superseded =
        "A newer candidate replaced it, or it was answered somewhere else. The next one comes back "
        + "here as its own card."
    /// B's second row, verbatim from mock 4: the whole point is that the reader may walk away.
    public static let nothingToDo =
        "nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t"

    /// Which card to draw, or nil while there is nothing to say: a candidate still being checked
    /// is not a question yet, and one that was declined, cancelled or superseded is not one any
    /// more. Both are the ordinary case, and neither is a card.
    public static func stage(_ view: ProjectPromotionView?) -> PromotionStage? {
        switch view?.state {
        case .ready: return .askingYou
        case .confirmed, .rechecking: return .merging
        case .merged: return .merged
        case .blocked: return .blocked
        default: return nil
        }
    }

    /// When a check blocked this candidate, or nil for one in any other state.
    ///
    /// State D's own moment, `project_promotion.decided_at` on the wire, and the half of web's
    /// `promotionRecordMoment` this client reads: a merge's moment is `merged.at`, which `Receipt`
    /// carries. The conversation draws the card at it instead of at the tail
    /// (`DeliveryAnchor.promotion`), so both ends put the same card in the same place.
    public static func blockedAt(_ view: ProjectPromotionView) -> String? {
        stage(view) == .blocked ? view.decidedAt : nil
    }

    /// Only a READY candidate may be confirmed (§3.3): a blocked one's checks did not pass, and a
    /// confirmed one is already landing.
    public static func confirmable(_ view: ProjectPromotionView?) -> Bool {
        view?.state == .ready
    }

    /// The card's heading, per state.
    public static func title(_ view: ProjectPromotionView) -> String {
        let branch = shortRef(view.sourceRef)
        let into = shortRef(view.upstreamRef)
        switch stage(view) {
        case .merging: return "Merging \(branch) into \(into)…"
        case .merged: return view.merged?.automatic == true ? mergedAutomaticallyHeading : mergedHeading
        case .blocked: return "\(branch) can’t merge into \(into) yet"
        default: return "Merge \(branch) into \(into)?"
        }
    }

    /// `project/bg-jobs · 7 commits ahead of main` — mock 4's Branch row.
    public static func branchLine(_ view: ProjectPromotionView) -> String {
        let branch = shortRef(view.sourceRef)
        guard let ahead = view.commitsAhead else { return branch }
        return "\(branch) · \(ahead) commit\(ahead == 1 ? "" : "s") ahead of \(shortRef(view.upstreamRef))"
    }

    /// `4 landed on the branch` — how much this merge would carry.
    public static func tasksLine(_ view: ProjectPromotionView) -> String {
        let n = view.taskIds.count
        return "\(n) landed on the branch"
    }

    /// `✓ Passed on the combined tree · <command> · 6m 12s`, or what failed instead. The check the
    /// owner is being asked to trust, named by the command that ran and how long it took.
    public static func checksLine(_ view: ProjectPromotionView) -> String {
        guard let check = view.checks.last else { return "no checks recorded" }
        let elapsed = check.durationMs.map { " · \(duration(ms: $0))" } ?? ""
        let verdict = check.passed
            ? "✓ Passed on the combined tree"
            : (check.timedOut == true ? "✕ Timed out on the combined tree" : "✕ Failed on the combined tree")
        return "\(verdict) · \(check.command)\(elapsed)"
    }

    /// The upstream row: whether this candidate conflicts with it, and — on a re-check — that it
    /// moved. `no conflicts` is the fact the owner is deciding on.
    public static func upstreamLine(_ view: ProjectPromotionView) -> String {
        guard view.conflicts.isEmpty else {
            let n = view.conflicts.count
            return "\(n) file\(n == 1 ? "" : "s") conflict with \(shortRef(view.upstreamRef))"
        }
        return "no conflicts"
    }

    /// `3 of 6 met on this branch — merging does not close the project`, from the criteria the
    /// console already read for the confirmation card. Nil when it has not read them: a card that
    /// invented "0 of 0 met" would be saying something about the project that nobody checked.
    public static func criteriaLine(met: Int, of total: Int) -> String? {
        guard total > 0 else { return nil }
        return "\(met) of \(total) met on this branch — merging does not close the project"
    }

    /// `exactly the tested tree 58f3a47 · as a merge commit` — what M-S3 promises.
    public static func landsLine(_ view: ProjectPromotionView) -> String {
        let sha = String(view.sourceSha.prefix(7))
        let how = view.landsAs == "FAST_FORWARD" ? "as a fast-forward" : "as a merge commit"
        return "exactly the tested tree \(sha) · \(how)"
    }

    /// B's status row: the upstream moved after the check, so the combined tree is being checked
    /// again — and nobody has to press anything for that.
    public static func mergingStatusLine(_ view: ProjectPromotionView) -> String {
        view.state == .rechecking
            ? "\(shortRef(view.upstreamRef)) moved since the check — re-checking the combined tree"
            : "checks passed and this is landing on \(shortRef(view.upstreamRef))"
    }

    /// C's commit row: what landed, who merged it, and when.
    public static func mergedLine(_ view: ProjectPromotionView, now: Date = Date()) -> String {
        guard let merged = view.merged else { return "merged" }
        let when = RelativeTime.elapsed(merged.at, now: now).map { " · \($0)" } ?? ""
        let who = merged.automatic == true ? underAutomatic : "by you"
        return "\(String(merged.sha.prefix(7))) · merge of \(shortRef(view.sourceRef)) · \(who)\(when)"
    }

    /// C's undo row, on a merge the Automatic setting made: the one command that takes it back out
    /// of main. Nil on a pressed merge, whose receipt is what it always was — the owner chose that
    /// one and watched it happen; this one happened without them.
    public static func revertLine(_ view: ProjectPromotionView) -> String? {
        guard let merged = view.merged, merged.automatic == true else { return nil }
        return merged.revert
    }

    /// D's first row: why it cannot merge, in the files that say so.
    public static func blockedLine(_ view: ProjectPromotionView) -> String {
        guard !view.conflicts.isEmpty else { return "the checks on the combined tree did not pass" }
        let n = view.conflicts.count
        let files = view.conflicts.prefix(3).joined(separator: ", ")
        let more = n > 3 ? " and \(n - 3) more" : ""
        return "\(n) file\(n == 1 ? "" : "s") conflict with \(shortRef(view.upstreamRef)): \(files)\(more)"
    }

    /// D's second row: who has it. The coordinator, until the clock hands it over.
    public static let blockedWho = "The coordinator is resolving it on the project branch"

    /// `asked 2h 10m ago`, A's footnote.
    public static func askedLine(_ view: ProjectPromotionView, now: Date = Date()) -> String? {
        guard let askedAt = view.askedAt, let ago = RelativeTime.ago(askedAt, now: now) else {
            return nil
        }
        return "asked \(ago)"
    }

    /// How long a check took, to the second: "48s", "6m 12s", "1h 4m". Finer than the spans the
    /// rest of the card uses, because this is the number that says whether the tree was really
    /// exercised — mock 4 writes it out, and "6m" would lose that.
    static func duration(ms: Int) -> String {
        let total = Swift.max(0, ms) / 1_000
        if total < 60 { return "\(total)s" }
        let minutes = total / 60, seconds = total % 60
        if minutes < 60 { return seconds == 0 ? "\(minutes)m" : "\(minutes)m \(seconds)s" }
        let hours = minutes / 60, rest = minutes % 60
        return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
    }

    /// `refs/heads/x` → `x`, the way every ref is shown to a person here.
    public static func shortRef(_ ref: String) -> String {
        ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
    }

    // MARK: the record a merge leaves

    /// One merge this conversation draws as a record.
    public struct Receipt: Equatable, Sendable, Identifiable {
        public let promotion: ProjectPromotionView
        /// The merge's own clock — the other four records read theirs off their payload, and this
        /// one has to carry it: a promotion with no `merged` is a candidate on offer, not a record,
        /// and `init?` is what keeps that from becoming a receipt nobody could place.
        public let moment: String

        public init?(promotion: ProjectPromotionView) {
            guard let at = promotion.merged?.at else { return nil }
            self.promotion = promotion
            self.moment = at
        }

        /// The row this record is drawn in — the card's own address rather than a second spelling of
        /// it, so the id the console dedupes on and the id the transcript draws cannot drift.
        public var id: String {
            DeliveredDecisionCard(kind: .promotionReceipt(promotion: promotion)).id
        }
    }

    /// The receipts this conversation draws, each where its merge HAPPENED — the fifth of the five
    /// records placed that way, beside the criteria decision's, the evidence decision's, the owner
    /// decision's and the standard set's confirmation.
    ///
    /// WHERE THIS USED TO BE DRAWN. A merge was drawn by the conversation's card strip, off
    /// `GET /projects/:id/promotions/current` — the candidate the branch is offering NOW. That row
    /// moves on to the next candidate the branch produces, so the receipt for a merge sat at the
    /// bottom of the pane for the life of the project: under every later message, in conversations
    /// started long afterwards, and after the project was done. The account owner's report,
    /// 2026-09-21, on this client: `✓ Merged into main · df444ca · merge of project/34ODo… · 41m`,
    /// fixed at the bottom of a conversation the merge was not the last thing in. Web was fixed the
    /// same way and from a read of its own (`GET /projects/:id/promotions/merged`, `mergedAt` as the
    /// anchor — `ProjectPromotionReceipt`); this is that read, and this is that anchor.
    ///
    /// A merge older than everything this console holds is still drawn: the record carries the
    /// merge's own `merged.at`, and the row it belongs in is resolved against the rows loaded at
    /// render time (`ReceiptAnchor.Placement`) — where it happened when that row is loaded, the head
    /// of the window when the moment is above it.
    public static func receipts(merged: [ProjectPromotionView]) -> [Receipt] {
        merged.compactMap(Receipt.init)
    }
}

// MARK: - an exception that became the owner's

/// Where one open item stands right now, as the owner's own read publishes it.
///
/// The same three states the question card has, and for the same reason: a card is delivered once
/// and then re-derived from the read on every render, and "the read has not come back yet" is a
/// third state that must never be drawn as "the item went away".
public enum OwnerItemStanding: Equatable, Sendable {
    /// No read has come back. The card draws with dead buttons rather than claiming anything.
    case unread
    /// The item, as the owner's read publishes it.
    case open(ProjectOpenItemRow)
    /// The read came back and this item is not in it: resolved here, resolved elsewhere (the
    /// coordinator closed it, the task moved on), or handed back to the coordinator by this press.
    case gone
}

/// The exception that became the owner's without anybody asking, and the pause they are the only
/// one who can lift (contract §7.5, mock 5's right column and mock 6 ①).
///
/// WHY IT EXISTS AT ALL. The server counts these two among the four owner items and lands the count
/// on the project's coordinator conversation, so the session list, the console header and the
/// needs-you banner all light up on it. On the web the card is drawn in that same conversation
/// (`ProjectExceptionCards` in `WorkspaceView.tsx`) — and on this client it was not, for a while:
/// a row said "Waiting for approval", the banner said "Escalated to you", and pressing either
/// opened a conversation with nothing in it to press. A badge that opens nothing is worse than a
/// dark one, which is the rule the server's own counting read is written under.
///
/// WHY ONLY THE OWNER'S GROUP. `ExceptionCards.cards` reads the same group the question card does
/// (`needsYou`), not everything the project has open: an item still with the coordinator is
/// somebody's work in progress, and a second copy of that work on the owner's phone would be the
/// same list drawn twice.
public enum ExceptionCards {
    /// The card's header, in the words the needs-you banner uses for the same kind, so a person who
    /// pressed the banner finds the card saying what the banner said. `OwnerItemCardsTests` holds
    /// both to `NeedsYouLogic.ownerItemText` — the banner and the card are the same fact.
    public static let escalatedTitle = "Escalated to you"
    public static let pauseTitle = "Paused"
    /// §7.5's provenance mark, the same one the merge and question cards carry.
    public static let provenance = "FROM ORBIT"
    public static let provenanceTitle =
        "Orbit filed this from the fact that opened it. It is not something an agent turn wrote "
        + "into this page."
    /// Mock 5's press: the item goes back to the conversation that should have had it (§4.7).
    /// Nothing is retried and nothing ends — what the coordinator does about it is the coordinator's.
    public static let askCoordinatorAgain = "Ask the coordinator again"
    /// Mock 6 ①'s press (§6.3 F-T4): the coordinator stops being paused and starts working again.
    public static let resume = "Resume"
    /// What the composer's bar says the reply is about, and what the empty composer asks for —
    /// `Approvals.chatAction` is the button, these are what arming it says (`ComposerView`).
    ///
    /// Two prefixes because the two cards are two things: a pause is not an exception, and a
    /// coordinator reading "About this exception: The coordinator paused itself" would be told the
    /// wrong noun by the card that knows better.
    public static let chatPrefix = "About this exception: "
    public static let pauseChatPrefix = "About this pause: "
    /// What the armed composer asks for. A message, not an answer: no door is waiting on it.
    public static let chatPlaceholder = "Say what the coordinator should do…"

    /// The bar's one line, for one row: the card's own word for what this is, then the item.
    public static func chatBanner(_ row: ProjectOpenItemRow, isPause: Bool) -> String {
        (isPause ? pauseChatPrefix : chatPrefix) + row.title
    }
    /// What a card whose item the read no longer carries says about itself. Native-only copy, and
    /// deliberately so: the browser re-derives its cards from the read on every render and the card
    /// simply goes, which leaves a reader who just pressed something with nothing to read.
    public static let gone = "This exception is no longer open."
    /// The read did not come back. Native-only, like the question card's `unreadable`.
    public static let unreadable = "Couldn’t read this exception — pull to retry."
    /// The receipts, drawn only for a press made on THIS screen: what it sent, and where. All three
    /// are native-only words, and deliberately so — the browser re-derives its cards from the read
    /// and the card simply goes, which leaves a reader who just pressed something with nothing to
    /// read.
    public static let returned = "Sent back to the coordinator"
    public static let resumed = "Resumed"
    /// `Owner: you · waiting 2h 10m` — the browser's `ownerLine`, owner arm.
    public static let ownerPrefix = "Owner: you"
    /// What a refused resume says, in the browser's headline (`FusePauseCard`'s alert).
    public static let notResumed = "The coordinator was not resumed"
    /// What a refused hand-back says. Native-only: the browser draws the server's own sentence.
    public static let notReturned = "That item was not sent back"

    /// The items this client draws a card for: the owner's group, minus the two kinds that have
    /// cards of their own (`CoordinatorQuestions.open`, `PromotionCards.stage`). Mirrors the web's
    /// `ItemAsCard`, which draws nothing for those two for the same reason — one question, answered
    /// in one place.
    public static func cards(_ items: ProjectOpenItemsView?) -> [ProjectOpenItemRow] {
        (items?.needsYou ?? []).filter {
            $0.kind != .coordinatorQuestion && $0.kind != .promotionApproval
        }
    }

    /// Where one item stands, by the address the card was delivered under.
    public static func standing(items: ProjectOpenItemsView?,
                                itemId: String) -> OwnerItemStanding {
        guard let items else { return .unread }
        guard let row = cards(items).first(where: { $0.itemId == itemId }) else { return .gone }
        return .open(row)
    }

    /// Whether this card is still something waiting on the reader — what a count of open items
    /// would use. Not drawn by any bar today: the browser's rail points at decisions, not at
    /// exceptions (§7.6 V13's `needsDecisionCount`), and this is the same rule.
    public static func isOpen(_ standing: OwnerItemStanding) -> Bool {
        if case .open = standing { return true }
        return false
    }

    /// Whether the pause may be lifted: the server lists `RESUME` only while there is an episode to
    /// resume, and the door takes the episode by id — so a card missing either is a card whose press
    /// the server would refuse.
    public static func resumable(_ row: ProjectOpenItemRow) -> Bool {
        row.fuseEpisodeId != nil && row.actions.contains(.resume)
    }

    /// Whether the item may be sent back. The server lists `ASK_COORDINATOR_AGAIN` only while a live
    /// coordinator conversation exists to hand it to (`askable`, §4.7), so a project with nobody
    /// coordinating it draws no button rather than a button whose only answer is a refusal.
    public static func askable(_ row: ProjectOpenItemRow) -> Bool {
        row.actions.contains(.askCoordinatorAgain)
    }

    // MARK: - the fact block (§7.5, mock 5)

    /// One row of the card's fact block: a label, its value, and whether the value is a machine
    /// string — the rows the browser draws in its mono face end to end (the files a merge conflicted
    /// on, an integration's error code).
    ///
    /// The VALUE is the browser's own string, character for character, and nothing here composes one
    /// of its own: the block is a reading of the item's payload, and a second reading of the same
    /// fact is the thing free to disagree with the row beside it.
    public struct FactRow: Equatable, Sendable {
        public let label: String
        public let value: String
        public let mono: Bool

        public init(label: String, value: String, mono: Bool = false) {
            self.label = label
            self.value = value
            self.mono = mono
        }
    }

    /// What a failed check printed, folded from the END (mock 5) — which is where the reason a check
    /// is red always is. The browser's `CheckOutputTail`: the last `foldedLines` lines are what is
    /// drawn while folded, and the rest is offered.
    public struct CheckTail: Equatable, Sendable {
        /// The browser's `CHECK_TAIL_LINES`.
        public static let foldedLines = 6
        public static let less = "Show less"

        /// Every line the check printed, with its ANSI colour codes stripped — the browser's
        /// `stripAnsi`, because those codes are invisible in a native `Text` and what would show is
        /// literal "[41m" garbage.
        public let lines: [String]
        /// How many lines the fold keeps back. Zero when the whole tail fits.
        public let hidden: Int

        /// The lines drawn while folded: the last of them, or all of them when they fit.
        public var shown: [String] {
            hidden == 0 ? lines : Array(lines.suffix(Self.foldedLines))
        }
        /// "Show 3 more lines", or nil when every line is already on screen.
        public var more: String? { hidden > 0 ? "Show \(hidden) more lines" : nil }

        /// The tail as the card draws it, or nil when the check printed nothing (which is what the
        /// browser's `outputTail.trim() !== ''` decides too).
        public static func of(_ outputTail: String?) -> CheckTail? {
            guard let outputTail else { return nil }
            let cleaned = strippingAnsi(outputTail)
            guard !cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let lines = cleaned.components(separatedBy: "\n")
            return CheckTail(lines: lines, hidden: Swift.max(0, lines.count - foldedLines))
        }

        /// The browser's `stripAnsi` (`src/web/src/lib/ansi.ts`): real ESC-prefixed CSI sequences
        /// only, so a literal "arr[0]" someone printed is left alone.
        static func strippingAnsi(_ text: String) -> String {
            guard text.contains("\u{1B}") else { return text }
            guard let re = try? NSRegularExpression(pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]") else {
                return text
            }
            return re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text),
                                               withTemplate: "")
        }
    }

    /// What the card draws where a payload was read: the rows, and the failed check's own log.
    public struct FactBlock: Equatable, Sendable {
        public let rows: [FactRow]
        public let logTail: CheckTail?

        public init(rows: [FactRow], logTail: CheckTail? = nil) {
            self.rows = rows
            self.logTail = logTail
        }
    }

    /// What a card draws in place of the item's sentence. `detailLine` is what every card drew
    /// before the rows existed, and it is what a row with no readable payload still draws — the
    /// server's own sentence, never a card with blanks in it.
    public enum ItemFacts: Equatable, Sendable {
        case detailLine(String)
        case rows(FactBlock)
    }

    /// The fact block of §7.5, from the payload the row carries — the browser's `ItemFactRows`,
    /// field for field (`ProjectProgressStatus.tsx`). The one place the two may differ is the font a
    /// row is drawn in; the rows, their order and every word in them are the same.
    public static func facts(_ row: ProjectOpenItemRow) -> ItemFacts {
        guard let facts = row.facts else { return .detailLine(row.detailLine) }
        var rows: [FactRow] = []
        if let task = facts.task { rows.append(FactRow(label: taskLabel, value: task.title)) }
        if let targetRef = facts.targetRef {
            var into = targetRef
            if let sha = facts.targetSha { into += " at \(String(sha.prefix(7)))" }
            if facts.nothingLanded { into += nothingLanded }
            rows.append(FactRow(label: intoLabel, value: into))
        }
        if !facts.files.isEmpty {
            rows.append(FactRow(label: filesLabel, value: facts.files.joined(separator: " · "),
                                mono: true))
        }
        // Only where the item is about a task: the press this sentence describes is a push to that
        // task's branch, and a promotion's failure has no task branch to push to.
        if facts.task != nil && !facts.files.isEmpty {
            rows.append(FactRow(label: afterAFixLabel, value: afterAFix))
        }
        if let check = facts.check {
            rows.append(FactRow(label: checkLabel,
                                value: "\(check.command) · \(checkVerdict(check)) after "
                                    + checkDuration(check.durationMs ?? 0)))
        }
        if facts.branchUnchanged {
            rows.append(FactRow(label: branchLabel, value: branchUnchanged))
        }
        if let failure = facts.failure {
            rows.append(FactRow(label: howLabel, value: howFailed(failure)))
            if let standing = chainStanding(failure) {
                rows.append(FactRow(label: retriesLabel, value: standing))
            }
        }
        if let errorCode = facts.errorCode {
            rows.append(FactRow(label: errorLabel, value: errorCode, mono: true))
        }
        return .rows(FactBlock(rows: rows, logTail: CheckTail.of(facts.check?.outputTail)))
    }

    /// The block's labels, in mock 5's words.
    public static let taskLabel = "Task"
    public static let intoLabel = "Into"
    public static let filesLabel = "Files"
    public static let afterAFixLabel = "After a fix"
    public static let checkLabel = "Check"
    public static let branchLabel = "Branch"
    public static let howLabel = "How"
    public static let retriesLabel = "Retries"
    public static let errorLabel = "Error"
    /// What a conflict's target-branch row says about the branch it could not move.
    public static let nothingLanded = " · nothing landed"
    /// What a fix is expected to do, and the one thing it does not ask the reader to do.
    public static let afterAFix =
        "push to the task branch — Orbit re-integrates and re-checks on its own"
    /// The whole sentence of a check that failed only combined with the task's own branch.
    public static let branchUnchanged =
        "unchanged — the task passed on its own branch; it fails only on the combined tree"

    /// How a check ended, in the words the mock uses for it: the code it returned, or that its budget
    /// ran out while it was still running.
    public static func checkVerdict(_ check: IntegrationCheckResult) -> String {
        if let exitCode = check.exitCode { return "exit \(exitCode)" }
        return check.timedOut == true ? "timed out" : "no exit code"
    }

    /// How long a check took, as the browser's `checkDuration` measures it
    /// (`src/web/src/lib/checkDuration.ts`): `48s`, `6m 12s`, `1h 4m`.
    ///
    /// Deliberately not `PromotionCards.duration`, which floors the same measurement where the web
    /// rounds: the merge card has floored it since before this card existed, and one client
    /// disagreeing with the other by a second is not this card's to fix.
    public static func checkDuration(_ ms: Int) -> String {
        let seconds = Swift.max(0, Int((Double(ms) / 1_000).rounded()))
        let h = seconds / 3_600, m = (seconds % 3_600) / 60, s = seconds % 60
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        if m > 0 { return s > 0 ? "\(m)m \(s)s" : "\(m)m" }
        return "\(s)s"
    }

    /// Why an attempt failed, in the browser's `howFailed` words — the same sentence whether or not
    /// it knows the reason, because a card that went blank on an unknown one would say less than the
    /// row beside it.
    public static func howFailed(_ failure: OpenItemFacts.Failure) -> String {
        let how: [String: String] = [
            "ACCEPTANCE_EXIT_MISMATCH": "the acceptance command exited",
            "RUN_FAILED": "a turn of the run failed",
            "RUNNER_FINALIZED_FAILED": "the runner finished the run as failed",
            "REAPED_API_ERROR": "the run stopped on an API or sign-in error and was reaped",
            "ATTEMPT_LOST_RUNNER_OFFLINE": "its runner went offline and the attempt was taken back",
            "ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED":
                "its runtime never started and the attempt was taken back",
            "REPORTED_FAILED": "somebody filed it as failed",
        ]
        let said = failure.how.flatMap { how[$0] } ?? "the task failed"
        guard let exitCode = failure.exitCode else { return said }
        return "\(said) \(exitCode) (expected \(failure.expectedExitCode ?? 0))"
    }

    /// Where the attempt's chain stands (§4.5): how many failures it has had, and that the last one
    /// is the owner's rather than the coordinator's. Nil when the payload carried no counts — the
    /// browser's row needs both, and a card that guessed "attempt 1 of 3" would be describing a
    /// chain nobody read.
    public static func chainStanding(_ failure: OpenItemFacts.Failure) -> String? {
        guard let attempt = failure.attempt, let limit = failure.limit else { return nil }
        let standing = "attempt \(attempt) of \(limit) in this chain"
        return attempt >= limit
            ? "\(standing) — this one is the owner's"
            : "\(standing) — the \(ordinal(limit)) failure goes straight to the owner"
    }

    /// `3rd`, `1st`, `12th` — the mock counts the failure that stops being the coordinator's.
    public static func ordinal(_ n: Int) -> String {
        let teens = n % 100
        if teens >= 11 && teens <= 13 { return "\(n)th" }
        switch n % 10 {
        case 1: return "\(n)st"
        case 2: return "\(n)nd"
        case 3: return "\(n)rd"
        default: return "\(n)th"
        }
    }

    // MARK: - the card's three weights (mock 7, 方案 B)

    /// The three weights a card's presses are drawn in: the press this kind of exception is asking
    /// for, the other way to take that step, and — behind both — the doors that only look or only
    /// stop, drawn quiet so they stop competing with the press.
    public enum PressTier: String, Equatable, Sendable {
        case primary
        case secondary
        case link
    }

    /// One press of a card, by the action the server named and the weight the card gave it.
    public struct CardPress: Equatable, Sendable {
        public let action: ProjectOpenItemAction
        public let tier: PressTier

        public init(action: ProjectOpenItemAction, tier: PressTier) {
            self.action = action
            self.tier = tier
        }
    }

    /// The doors a card may LEAD with: go onto the work, run the task again, hand the item back.
    /// The rest of an item's list is a way to LOOK (`Open coordinator`) or to STOP (`Cancel task`),
    /// which the mock demotes to quiet links (mock 7's rule 2).
    static let leadingActions: Set<ProjectOpenItemAction> = [
        .openTaskSession, .retry, .askCoordinatorAgain,
    ]

    /// What the way onto the work is called, in the browser's `ACTION_LABEL` spelling. The other
    /// doors of that map are drawn by cards this one is not: the pause's `Resume`, the merge's
    /// `Review`, and the two the owner's card reaches through its own controls.
    public static let openTaskSession = "Open task session"

    /// What the next step is for a kind of exception, where the design names one (mock 7 ①②③). A
    /// conflict and a failed combined-tree check both want the branch fixed, so the way onto that
    /// branch leads; a task that failed wants another run. A kind this map has no answer for keeps
    /// the server's own order rather than being handed a step nobody asked for.
    static let kindNextStep: [ProjectOpenItemKind: ProjectOpenItemAction] = [
        .integrationConflict: .openTaskSession,
        .integrationCheckFailed: .openTaskSession,
        .taskFailed: .retry,
    ]

    /// The kinds an owner closes by hand (§4.7's "标记已处理"): the exceptions, which are the ones a
    /// person sometimes answers in a way the platform cannot read. A question is the owner's to
    /// ANSWER rather than to close, and a merge approval and a paused project each have a press of
    /// their own — the server's own door refuses all three.
    static let handClosableKinds: Set<ProjectOpenItemKind> = [
        .integrationConflict, .integrationCheckFailed, .integrationError, .taskFailed,
    ]

    /// Whether this row carries the address a press would need, in the shape the browser's
    /// `actionHref` / `writeTarget` answer it. A press the row cannot reach is not drawn, never
    /// drawn and refused: the two task presses act on the task the item is about, and the rest are
    /// about the item itself.
    public static func addressed(_ row: ProjectOpenItemRow, _ action: ProjectOpenItemAction) -> Bool {
        switch action {
        case .askCoordinatorAgain, .answer: return true
        case .retry, .cancelTask: return row.taskId != nil
        case .review: return row.promotionId != nil
        case .openCoordinator: return row.delivery?.sessionId != nil
        case .openTaskSession: return row.sessionId != nil || row.taskId != nil
        case .resume: return true
        case .unknown: return false
        }
    }

    /// The presses a card draws: the same list the server serves, minus what this build cannot draw
    /// and minus the doors this row carries no address for. Never more than the server listed, so a
    /// card cannot come to offer something no door answers.
    public static func drawn(_ row: ProjectOpenItemRow) -> [ProjectOpenItemAction] {
        row.actions.filter { $0 != .unknown && addressed(row, $0) }
    }

    /// The presses a card leads with, in the order it draws them: the step this kind of exception is
    /// asking for, then the same step taken another way — the browser's `leadingDoors`, from the
    /// server's own list, so a card never offers a door that is not there.
    public static func leadingDoors(_ row: ProjectOpenItemRow,
                                    _ actions: [ProjectOpenItemAction]) -> [ProjectOpenItemAction] {
        let leading = actions.filter { leadingActions.contains($0) }
        // An item that has become the owner's leads with the way back to the coordinator that should
        // have had it (§4.7): the work is not the owner's to run again, and the server lists no
        // RETRY for one.
        let next = row.assignee == .owner ? ProjectOpenItemAction.askCoordinatorAgain
                                          : kindNextStep[row.kind]
        guard let next, leading.contains(next) else { return leading }
        return [next] + leading.filter { $0 != next }
    }

    /// The card's whole action row, in the weights of mock 7 方案 B: the pair it leads with in their
    /// own order, then the rest of the server's list — so a card reads left to right as what to do,
    /// what else would do it, and the ways in and out.
    ///
    /// `Mark as handled` is NOT one of these: see `markable`.
    public static func presses(_ row: ProjectOpenItemRow) -> [CardPress] {
        let actions = drawn(row)
        let leading = leadingDoors(row, actions)
        let primary = leading.first
        let secondary = leading.dropFirst().first
        return (leading + actions.filter { !leading.contains($0) }).map { action in
            CardPress(action: action,
                      tier: action == primary ? .primary : action == secondary ? .secondary : .link)
        }
    }

    // MARK: - the owner's own ending (§4.7, mock 7 方案 B)

    /// The press the card wears, and the dialog it opens. The browser's `MARK_HANDLED` and its two
    /// sentences, verbatim: what the press ends, and why the reason is required.
    public static let markHandled = "Mark as handled"
    public static let markHandledTitle = "Mark this item as handled?"
    public static let markHandledBody =
        "It stops being something this project owes anyone. The reason is what the record gains, "
        + "because nothing on the line could verify the ending for itself — the task, its branch and "
        + "its history stay where they are."
    /// What the field asks for, in the browser's own label.
    public static let markHandledReason = "Why is it no longer open?"
    /// What a refused ending says, in the browser's own headline.
    public static let notMarkedHandled = "The item was not closed"
    /// What the receipt says, for a press made on this screen. Native-only, like the hand-back's:
    /// the browser re-derives its cards from the read and the card simply goes.
    public static let handled = "Marked as handled"
    /// The door's own ceiling (`MAX_OPEN_ITEM_RESOLUTION_NOTE`), so the field stops where the
    /// server's validation would.
    public static let markHandledMaxLength = 2_000

    /// Whether the owner may close this item themselves, in the browser's own rule: the item is
    /// theirs, and its kind is one the door closes by hand (`HAND_CLOSABLE_KINDS`, which names the
    /// same set as the server's `HAND_CLOSABLE_RESOLUTIONS`). Offered on the owner's card only —
    /// an item still with the coordinator is the coordinator's to close (§4.7).
    public static func markable(_ row: ProjectOpenItemRow) -> Bool {
        row.assignee == .owner && handClosableKinds.contains(row.kind)
    }

    /// What the press sends, or nil when it may not be made: the door requires the reason
    /// (`ResolveOpenItemDto.note`), so an empty one is not a press at all. Trimmed, exactly as the
    /// browser trims before it asks.
    public static func markHandledRequest(_ note: String) -> OpenItemResolveRequest? {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return OpenItemResolveRequest(note: trimmed)
    }

    /// The task this item is about, as the app's own `orbit-task:` door — what the `Open task
    /// session` press reaches when the attempt that opened the item has no session left. Nil when
    /// the item is about no task, or when the id cannot name one.
    public static func taskLink(_ row: ProjectOpenItemRow) -> URL? {
        link(row.taskId, scheme: "orbit-task")
    }

    /// The attempt that opened the item, for the reader who wants the run itself.
    public static func sessionLink(_ row: ProjectOpenItemRow) -> URL? {
        link(row.sessionId, scheme: "orbit-session")
    }

    /// Where `Open task session` goes, in the browser's own order: the attempt that opened the item
    /// when there is one, the task when there is not.
    public static func openTaskSessionLink(_ row: ProjectOpenItemRow) -> URL? {
        sessionLink(row) ?? taskLink(row)
    }

    private static func link(_ id: String?, scheme: String) -> URL? {
        guard let id, PublicID.toUUID(id) != nil else { return nil }
        return URL(string: "\(scheme):\(id)")
    }


    /// The moment this item became the owner's — what its card is placed in the conversation by
    /// (`DeliveryAnchor.exception`, `ReceiptAnchor`).
    ///
    /// `escalatedAt` where the read says when the clock handed it over, and `waitingSince` where it
    /// does not: an item that was never the coordinator's has no escalation instant (a project with
    /// no coordinator lands one straight on the owner), and every item has this one. The two fields
    /// the card's own heading and footer already read, so where the card sits in the conversation
    /// and how long it says it has waited are never two different stories.
    ///
    /// A read that says neither, or says something no clock can parse, is not a moment: the caller
    /// falls back to where the card arrived rather than placing it by a guess.
    public static func moment(_ row: ProjectOpenItemRow) -> String {
        row.escalatedAt ?? row.waitingSince
    }

    /// §7.5's heading for an item that BECAME the owner's, one per way it happened — the browser's
    /// `escalationHeading`, verbatim. Nil for an item that was the owner's from the start, which is
    /// every other kind this card draws and says so in its own title.
    public static func heading(_ row: ProjectOpenItemRow, now: Date = Date()) -> String? {
        switch row.assigneeReason {
        case .escalated:
            return "Now yours — no one acted on this for \(waitedBeforeEscalation(row))"
        case .coordinatorEnded:
            return "Now yours — the coordinator conversation ended"
        case .chainLimit:
            return "Now yours — the 3rd failure in this chain"
        case .handedOver:
            return "Now yours — the coordinator handed it over"
        case .noCoordinator:
            return "Now yours — this project has no coordinator (waiting \(waited(row, now: now)))"
        case .defaultReason, .unknown:
            return nil
        }
    }

    /// The card's first line: why it is the owner's, or — for an item that carries no escalation
    /// reason — its own title, which is what the browser's plain `OpenItemCard` puts in the heading
    /// slot. One line either way, so the card never opens with a blank.
    public static func headingLine(_ row: ProjectOpenItemRow, now: Date = Date()) -> String {
        heading(row, now: now) ?? row.title
    }

    /// What escalated, under the heading the browser draws it above, for the kinds whose heading is
    /// no longer the item's title. Nil when the heading IS the title, which would print it twice.
    public static func subject(_ row: ProjectOpenItemRow, now: Date = Date()) -> String? {
        heading(row, now: now) == nil ? nil : row.title
    }

    /// How long the coordinator had it before the clock took it away — the window the project set,
    /// read off the two instants rather than off the setting, so a window that was changed
    /// afterwards cannot make this sentence lie about what happened. `a while` when the read does
    /// not say when it escalated, which is the browser's own fallback.
    public static func waitedBeforeEscalation(_ row: ProjectOpenItemRow) -> String {
        guard let escalated = row.escalatedAt.flatMap(RelativeTime.parse),
              let since = RelativeTime.parse(row.waitingSince) else { return "a while" }
        return RelativeTime.span(escalated.timeIntervalSince(since))
    }

    /// How long it has been waiting: `2h 10m`, in the browser's `formatSpan` words.
    public static func waited(_ row: ProjectOpenItemRow, now: Date = Date()) -> String {
        guard let since = RelativeTime.parse(row.waitingSince) else { return "a while" }
        return RelativeTime.span(now.timeIntervalSince(since))
    }

    /// §7.5's footer: who owes an answer, and for how long. The owner arm of the browser's
    /// `ownerLine` — the coordinator arm belongs to the rows this client does not draw.
    public static func ownerLine(_ row: ProjectOpenItemRow, now: Date = Date()) -> String {
        "\(ownerPrefix) · waiting \(waited(row, now: now))"
    }

    /// What the next send carries ahead of the typed sentence: the item as it stands.
    ///
    /// `chatBanner` says which item in the bar; this is what the COORDINATOR is told, and it needs
    /// more: the conversation it is about to be read in may not have seen this item since it went
    /// quiet, and the item is not in that transcript — it is a row in the project's own list. So the
    /// title, the server's sentence and the item's id ride with the message, and the id is there so
    /// an answer about an item that has since moved can be told apart from one about this one (the
    /// same reason the plan's seal rides with `planChangeContext`).
    public static func chatContext(projectTitle: String?, row: ProjectOpenItemRow,
                                   isPause: Bool, now: Date = Date()) -> String {
        let what = isPause ? "pause" : "exception"
        var out = "About the \(what)"
        if let projectTitle { out += " in “\(projectTitle)”" }
        out += isPause
            ? " — the coordinator stopped itself, and only the owner can lift it:"
            : " that is the owner's now — no one acted on it for \(waitedBeforeEscalation(row)):"
        out += "\n\n\(row.title)"
        if !row.detailLine.isEmpty { out += "\n\(row.detailLine)" }
        out += "\n\n(open item \(row.itemId), waiting since \(row.waitingSince))"
        return out
    }
}
