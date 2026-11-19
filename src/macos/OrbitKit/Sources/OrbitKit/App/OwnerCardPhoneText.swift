import Foundation

/// The iPhone's text rules for the owner exception card (board docs/mocks/owner-card-ios-text,
/// D1–D3 = A, decided 2026-11-17): settled items above an open one fold into one row, Details shows
/// the check's failing lines instead of its tail, and the facts are clamped to one line each with
/// the whole value one press away.
///
/// iOS first (D3 = A): the Mac and Android keep the "Who fixes it?" card as it is, and so does the
/// browser, so the words here are this client's own — no web string they are held to.
extension ExceptionCards {
    // MARK: the words

    public static let copyCommand = "Copy command"
    public static let failedLabel = "Failed"
    public static let checkFailedWord = "check failed"
    public static let outputSheetTitle = "Check output"
    public static let doneWord = "Done"

    /// "Full output (171 lines)" — what opens the sheet with the whole output.
    public static func fullOutputLabel(_ lines: Int) -> String {
        "Full output (\(lines) \(lines == 1 ? "line" : "lines"))"
    }

    /// "1 failing test", "3 failing tests".
    public static func failingTestsWord(_ count: Int) -> String {
        "\(count) failing \(count == 1 ? "test" : "tests")"
    }

    // MARK: D2 = A — the failing lines, not the tail

    /// What Details shows of a failed check's output on a phone: the lines that say what failed —
    /// a node test runner's `✖` and TAP's `not ok` — up to `shownMax`, and how many lines the
    /// whole output has, for "Full output (N lines)".
    public struct FailingLines: Equatable, Sendable {
        /// How many failing lines Details shows at most.
        public static let shownMax = 3

        /// The failing lines, trimmed, in the order the output printed them, at most `shownMax`.
        public let shown: [String]
        /// Every distinct failing line the output has — what the folded Details summary counts.
        public let failing: Int
        /// Every line of the output (ANSI codes stripped), for the full-output sheet.
        public let all: [String]

        public var total: Int { all.count }
    }

    /// The failing lines of `outputTail`, or nil when the check printed nothing. A line fails when,
    /// with its indentation off, it starts with `✖` or `not ok`. A test runner prints each failure
    /// twice — where it ran and again in its closing summary — and heads the summary with
    /// "✖ failing tests:", so the same line is counted once and the heading not at all.
    public static func failingLines(_ outputTail: String?) -> FailingLines? {
        guard let tail = CheckTail.of(outputTail) else { return nil }
        var seen = Set<String>()
        var failing: [String] = []
        for line in tail.lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("✖") || trimmed.hasPrefix("not ok") else { continue }
            if trimmed.hasPrefix("✖") && trimmed.hasSuffix(":") { continue }
            if seen.insert(trimmed).inserted { failing.append(trimmed) }
        }
        return FailingLines(shown: Array(failing.prefix(FailingLines.shownMax)),
                            failing: failing.count, all: tail.lines)
    }

    /// The failed check's own command, whole — what "Copy command" puts on the pasteboard, however
    /// short the line drawing it is cut.
    public static func commandCopyValue(_ row: ProjectOpenItemRow) -> String? {
        row.facts?.check?.command
    }

    /// "exit 1 after 6m 12s": the Failed row under the command.
    public static func failedRuns(_ check: IntegrationCheckResult) -> [FactRow.Run] {
        [.init(text: checkVerdict(check), face: .bad),
         .init(text: " after \(checkDuration(check.durationMs ?? 0))")]
    }

    // MARK: rule 4 — clamped facts

    /// How many lines the phone's subline ("<kind> · <task title>") is drawn in: one, cut at its
    /// tail. The whole title is Details' first row.
    public static let phoneSublineLines = 1
    /// How many lines a row's status sentence takes at most on a phone (rule 5).
    public static let phoneStatusLines = 2

    /// The subline as a phone draws it: one line, so a title someone wrote over two lines does not
    /// open a second one under the clamp.
    public static func phoneSubline(_ row: ProjectOpenItemRow, projectName: String?) -> String {
        whoFixesSubline(row, projectName: projectName)
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Details' rows on a phone (board ③): the task's whole title first — the subline cuts it —
    /// then the rows every client draws, with the Check row's command alone (one line, and "Copy
    /// command" under it: the view's) and its verdict moved to a Failed row of its own. The check's
    /// log rides on nothing: the view draws its failing lines under these.
    public static func phoneDetailRows(_ row: ProjectOpenItemRow, projectName: String?) -> [FactRow] {
        var rows: [FactRow] = []
        if let task = row.facts?.task?.title { rows.append(FactRow(label: taskLabel, value: task)) }
        for fact in detailRows(row, projectName: projectName) {
            guard fact.label == checkLabel, let check = row.facts?.check else {
                rows.append(fact)
                continue
            }
            rows.append(FactRow(label: checkLabel, value: check.command, mono: true))
            rows.append(FactRow(label: failedLabel, runs: failedRuns(check)))
        }
        return rows
    }

    /// The folded Details line on a phone: "Details · check failed · 1 failing test". The landing
    /// is a link inside Details, so the summary no longer names it.
    public static func phoneDetailsSummary(_ row: ProjectOpenItemRow) -> String {
        let files = row.facts?.files.count ?? 0
        let check = row.facts?.check
        let failing = failingLines(check?.outputTail)?.failing ?? 0
        return [detailsLabel,
                files > 0 ? "\(files) file\(files == 1 ? "" : "s")" : nil,
                check != nil ? checkFailedWord : nil,
                failing > 0 ? failingTestsWord(failing) : nil].compactMap { $0 }.joined(separator: " · ")
    }
}

/// D1 = A: settled exception cards directly above an open one fold into one row — "✓ 2 sent back
/// to the coordinator · Show" — which opens in place. Nothing settled is drawn at full card size
/// above an item that still needs the reader.
public enum SettledExceptionFold {
    public static let show = "Show"
    public static let hide = "Hide"
    public static let settledWord = "settled"
    public static let noLongerOpenWord = "no longer open"

    /// Where one exception card stands, as the transcript asks it.
    public enum Standing: Equatable, Sendable {
        /// Still waiting on the reader.
        case open
        /// Ended: by a press here (its receipt, e.g. "Sent back to the coordinator"), or elsewhere
        /// (nil — the read no longer lists it).
        case settled(receipt: String?)
        /// Not read yet, or not an exception card at all.
        case other
    }

    /// One run of settled cards, folded under the row its first card's slot draws.
    public struct Run: Equatable, Sendable {
        /// The row id of the run's first card: where the fold row is drawn.
        public let headID: String
        /// Every card in the run, first to last.
        public let memberIDs: [String]
        /// "2 sent back to the coordinator".
        public let line: String

        public var count: Int { memberIDs.count }
    }

    /// The exception card a row draws, by its item id.
    static func itemID(_ row: TranscriptRow) -> String? {
        guard case .decisionCard(let card) = row else { return nil }
        switch card.kind {
        case .escalatedItem(let itemID), .fusePause(let itemID): return itemID
        default: return nil
        }
    }

    /// The runs to fold: settled exception cards one after another, with an open one directly
    /// under the last of them. Settled cards with nothing open under them stay as they are.
    public static func runs(_ rows: [TranscriptRow],
                            standing: (String) -> Standing) -> [Run] {
        var runs: [Run] = []
        var pending: [(id: String, receipt: String?)] = []
        for row in rows {
            guard let item = itemID(row) else { pending = []; continue }
            switch standing(item) {
            case .settled(let receipt):
                pending.append((row.id, receipt))
            case .open:
                if !pending.isEmpty {
                    runs.append(Run(headID: pending[0].id, memberIDs: pending.map(\.id),
                                    line: line(receipts: pending.map(\.receipt))))
                }
                pending = []
            case .other:
                pending = []
            }
        }
        return runs
    }

    /// "2 sent back to the coordinator" when every card ended the same way here; "1 no longer
    /// open" for cards that ended elsewhere; "3 settled" for a mix.
    public static func line(receipts: [String?]) -> String {
        let words = Set(receipts.map { $0.map(lowercasedFirst) ?? noLongerOpenWord })
        let word = words.count == 1 ? words.first! : settledWord
        return "\(receipts.count) \(word)"
    }

    /// The rows drawn: a folded run keeps its first card's row (which draws the fold row) and
    /// drops the rest; an open run keeps every card.
    public static func fold(_ rows: [TranscriptRow], runs: [Run],
                            expanded: Set<String>) -> [TranscriptRow] {
        let hidden = Set(runs.filter { !expanded.contains($0.headID) }.flatMap { $0.memberIDs.dropFirst() })
        guard !hidden.isEmpty else { return rows }
        return rows.filter { !hidden.contains($0.id) }
    }

    private static func lowercasedFirst(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.lowercased() + s.dropFirst()
    }
}
