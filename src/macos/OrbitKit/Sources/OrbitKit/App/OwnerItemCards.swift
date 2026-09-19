import Foundation

/// The two owner cards this client draws, as pure logic: what each says, when each is answerable,
/// and what a press sends (contract §7.5, mocks 4 and 5).
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
        case .merged: return mergedHeading
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

    /// C's commit row: what landed, and when.
    public static func mergedLine(_ view: ProjectPromotionView, now: Date = Date()) -> String {
        guard let merged = view.merged else { return "merged" }
        let when = RelativeTime.elapsed(merged.at, now: now).map { " · \($0)" } ?? ""
        return "\(String(merged.sha.prefix(7))) · merge of \(shortRef(view.sourceRef)) · by you\(when)"
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
}
