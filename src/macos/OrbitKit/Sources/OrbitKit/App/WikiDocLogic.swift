import Foundation

// The Wiki's documents on the native pages (criterion 10 revised 2026-09-28, mocks 24, 26, 28) — the Swift
// half of the web's `src/web/src/lib/wikiDocs.ts`: the directory by the confirmed plan's categories and
// documents, one document with its sentences' marks and footnotes, and Browse by category and the A–Z index
// by document.
//
// Every sentence is a constant here, not a literal in a view, because `WikiDocsCopyParityTests` looks each
// one up in the web source; every reading is proved against the cases in `src/shared/src/wiki-docs.fixture.json`,
// which the web's `lib/wikiDocs.test.ts` reads too.
//
// Pure, with no SwiftUI, so it is tested on Linux like the rest of this directory.

/// Every sentence the document pages say. The web's constant each one mirrors is named beside it.
public enum WikiDocCopy {
    /// The Contents sheet's fourth row (mock 26 ②).
    public static let plan = "Plan"                                          // WIKI_DIRECTORY_PLAN
    /// The reader and scope block (mock 24 ①).
    public static let question = "Question"                                  // WIKI_DOC_QUESTION
    public static let writtenFor = "Written for"                             // WIKI_DOC_WRITTEN_FOR
    public static let covers = "Covers"                                      // WIKI_DOC_COVERS
    public static let notCovered = "Not covered"                             // WIKI_DOC_NOT_COVERED
    public static let scopeFolded = "Written for · Covers · Not covered"     // WIKI_DOC_SCOPE_FOLDED
    /// The sentence marks, and the section that has a withdrawn sentence (mock 24 ②).
    public static let noSource = "No source"                                 // WIKI_MARK_NO_SOURCE
    public static let notVerified = "Not verified"                           // WIKI_MARK_NOT_VERIFIED
    public static let withdrawn = "Withdrawn"                                // WIKI_MARK_WITHDRAWN
    public static let rewritePending = "Rewrite pending"                     // WIKI_REWRITE_PENDING
    /// The banner over a document past the threshold.
    public static let needsReview = "Needs review"                           // WIKI_DOC_NEEDS_REVIEW
    public static let nextMarked = "Next marked ›"                           // WIKI_NEXT_MARKED
    public static let notWritten = "Not written yet."                        // WIKI_DOC_NOT_WRITTEN
    public static let sectionNotWritten = "Not written yet — Wiki maintenance writes it on its next run."   // WIKI_DOC_SECTION_NOT_WRITTEN
    /// The footnotes under the text, the footnote sheet, and the entries under the document.
    public static let footnotes = "Footnotes"                                // WIKI_DOC_FOOTNOTES
    public static let viaEntry = "Via entry"                                 // WIKI_VIA_ENTRY
    public static let noQuoteGiven = "— no quote given"                      // WIKI_NO_QUOTE_GIVEN
    public static let entries = "Entries"                                    // WIKI_DOC_ENTRIES
    public static let openTheEntry = "Open the entry ›"                      // WIKI_OPEN_THE_ENTRY
    /// Browse's grey state of a document no run has written.
    public static let notWrittenShort = "Not written yet"                    // WIKI_DOC_NOT_WRITTEN_SHORT

    /// The lines a code footnote's sheet shows of its excerpt before `… N more lines` (`WIKI_EXCERPT_LINES_PHONE`).
    public static let excerptLinesPhone = 6
    /// The footnotes the list shows before `Show N more` (`WIKI_FOOTNOTES_SHOWN`).
    public static let footnotesShown = 15
    /// The entries a kind group shows on a phone before `Show N more` (`WIKI_DOC_GROUP_SHOWN_PHONE`).
    public static let groupShownPhone = 3
    /// The sections Browse shows of an open document on a phone (`WIKI_BROWSE_SECTIONS_SHOWN_PHONE`).
    public static let browseSectionsShownPhone = 6

    /// A section's kind as the pages name it (`WIKI_SECTION_KIND_LABELS`).
    public static func sectionKind(_ kind: WikiPlanSectionKind?) -> String {
        switch kind {
        case .overview?: return "Overview"
        case .concepts?: return "Concepts"
        case .flow?: return "Flow"
        case .interface?: return "Interface"
        case .data?: return "Data & config"
        case .ops?: return "Operations"
        case .pitfalls?: return "Pitfalls"
        case .decisions?: return "Decisions"
        case .conventions?: return "Conventions"
        case .other?: return "Other"
        case .unknown?, nil: return "Other"
        }
    }

    /// A footnote's kind of original (`WIKI_FOOTNOTE_KIND_LABELS`).
    public static func footnoteKind(_ kind: WikiDocFootnoteKind) -> String {
        switch kind {
        case .designDoc: return "Design doc"
        case .code: return "Code"
        case .contract: return "Contract"
        case .turn, .event, .toolCall: return "Session"
        case .task: return "Task"
        case .taskComment: return "Task comment"
        case .approval: return "Approval"
        case .ownerDecision: return "Owner decision"
        case .mergeReceipt: return "Merge receipt"
        case .note: return "Note"
        case .unknown: return "Source"
        }
    }

    /// The card's verdict, right of its head (`WIKI_VERDICT_CARD`).
    public static func verdictCard(_ verdict: WikiDocVerdict) -> String {
        switch verdict {
        case .verified: return "quote verified ✓"
        case .notFound: return "✗ quote not found"
        case .noQuote: return "✗ no quote given"
        case .unresolved, .unknown: return "✗ source not found"
        }
    }

    /// The same verdict in the list under the text (`WIKI_VERDICT_LIST`).
    public static func verdictList(_ verdict: WikiDocVerdict) -> String {
        switch verdict {
        case .verified: return "✓"
        case .notFound: return "✗ quote not found"
        case .noQuote: return "✗ no quote"
        case .unresolved, .unknown: return "✗ not found"
        }
    }

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(WikiArticleCopy.count(n)) \(n == 1 ? one : many)"
    }

    public static func moreLines(_ n: Int) -> String { "… \(plural(n, "more line", "more lines"))" }           // wikiMoreLines
    public static func moreSections(_ n: Int) -> String { plural(n, "more section", "more sections") }          // wikiMoreSections
    public static func entriesHint(_ n: Int) -> String { "the \(WikiArticleCopy.count(n)) this document’s quotes came through, by kind" }   // wikiDocEntriesHint
    public static func seeFootnote(_ n: Int) -> String { "See footnote [\(n)]" }                              // wikiSeeFootnote
    /// A footnote marker as the text carries it: `[7]`.
    public static func noteLabel(_ n: Int) -> String { "[\(n)]" }

    /// `§7`, `§3 and §7`, `§3, §5 and §7`: sections named together in a sentence (`wikiSectionList`).
    public static func sectionList(_ numbers: [Int]) -> String {
        let marks = Array(Set(numbers)).sorted().map { "§\($0)" }
        guard marks.count > 1 else { return marks.first ?? "" }
        return "\(marks.dropLast().joined(separator: ", ")) and \(marks[marks.count - 1])"
    }

    /// `Sep 15, 07:37`: when a record a footnote quotes was made, in the reader's zone (`wikiMonthDayTime`).
    public static func monthDayTime(_ iso: String?, timeZone: TimeZone = .current) -> String? {
        guard let iso else { return nil }
        let said = WikiModeLogic.runWhen(iso, timeZone: timeZone)
        return said.isEmpty ? nil : said
    }
}

public enum WikiDocLogic {
    // MARK: orders

    /// A document page's blocks, top to bottom — the web phone's order (`WIKI_DOC_SECTIONS`), and the one
    /// the native page iterates.
    public enum Section: String, CaseIterable, Sendable {
        case crumb, title, tags, updated, review, scope, body, footnotes, entries
    }

    /// The footnote card's parts, top to bottom — the sheet's (`WIKI_FOOTNOTE_CARD_PARTS`).
    public enum CardPart: String, CaseIterable, Sendable {
        case head, quote, problem, place, via, open
    }

    // MARK: one document's head

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(WikiArticleCopy.count(n)) \(n == 1 ? one : many)"
    }

    /// Which kinds of original a document's quotes come from, as its tags and its footnotes' heading count them.
    private static let quoteGroups: [(kinds: [WikiDocFootnoteKind], one: String, many: String)] = [
        ([.turn, .event, .toolCall], "session quote", "session quotes"),
        ([.designDoc, .code, .contract], "code & doc quote", "code & doc quotes"),
        ([.task, .taskComment], "task quote", "task quotes"),
        ([.approval, .ownerDecision, .mergeReceipt], "record quote", "record quotes"),
        ([.note], "note", "notes"),
    ]

    /// How many of a document's footnotes quote each kind of original (`wikiQuoteCounts`).
    public static func quoteCounts(_ footnotes: [WikiDocFootnote]) -> [String] {
        quoteGroups.compactMap { group in
            let n = footnotes.filter { group.kinds.contains($0.kind) }.count
            return n > 0 ? plural(n, group.one, group.many) : nil
        }
    }

    /// The tags after the category (`wikiDocTags`): its sections, its footnotes, and what they quote.
    public static func tags(_ doc: WikiDoc) -> [String] {
        let footnotes = doc.footnotes ?? []
        var tags = [plural((doc.sections ?? []).count, "section", "sections")]
        if !footnotes.isEmpty { tags += [plural(footnotes.count, "footnote", "footnotes")] + quoteCounts(footnotes) }
        return tags
    }

    /// The line under the tags (`wikiDocUpdatedParts`): when and at which commit, from which plan version,
    /// how many sentences. None for a document no run has written.
    public static func updatedParts(_ doc: WikiDoc, timeZone: TimeZone = .current) -> [String] {
        guard doc.written else { return [] }
        let day = doc.updatedAt.flatMap { WikiModeLogic.monthDay($0, timeZone: timeZone) } ?? ""
        let at = doc.repoSha.map { " at \(WikiLogic.shortSha($0))" } ?? ""
        let version = doc.writtenFromPlanVersion ?? doc.planVersion ?? 0
        return ["Updated \(day)\(at)", "written by \(WikiCopy.historyMaintenance) from plan v\(version)",
                plural(doc.counts?.sentences ?? 0, "sentence", "sentences")]
    }

    /// The amber end of that line on a document under the threshold (`wikiDocUpdatedWarn`).
    public static func updatedWarn(_ doc: WikiDoc) -> String? {
        guard doc.written, doc.status != .needsReview else { return nil }
        var parts: [String] = []
        if let n = doc.counts?.unsourced, n > 0 { parts.append("\(WikiArticleCopy.count(n)) without a source") }
        if let n = doc.counts?.unverified, n > 0 { parts.append("\(WikiArticleCopy.count(n)) not verified") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The threshold as the banner says it: `5%` (contract `docs.rules.needsReviewAbove`).
    public static let needsReviewThreshold = "5%"

    /// The banner's sentence after `Needs review ·` (`wikiDocNeedsReviewText`).
    public static func needsReviewText(_ doc: WikiDoc) -> String {
        let counts = doc.counts
        let marked = (counts?.unsourced ?? 0) + (counts?.unverified ?? 0)
        let share = String(format: "%.1f", ((doc.unsourcedShare ?? 0) * 1000).rounded() / 10)
        return "\(WikiArticleCopy.count(marked)) of \(plural(counts?.sentences ?? 0, "sentence", "sentences")) (\(share)%) state something no footnote "
            + "backs, or cite one that couldn’t be verified. Over \(needsReviewThreshold), the whole document is marked; "
            + "they’re marked below, and written again when their section is."
    }

    /// The mark a sentence wears (`WikiSentenceMark`).
    public enum Mark: String, CaseIterable, Sendable {
        case unsourced, unverified, withdrawn

        /// Its word (`WIKI_MARK_LABELS`).
        public var label: String {
            switch self {
            case .unsourced: return WikiDocCopy.noSource
            case .unverified: return WikiDocCopy.notVerified
            case .withdrawn: return WikiDocCopy.withdrawn
            }
        }
    }

    /// The mark a sentence wears, or nil for a sourced sentence or a transition (`wikiSentenceMark`).
    public static func mark(_ sentence: WikiDocSentence) -> Mark? {
        switch sentence.status {
        case .unsourced: return .unsourced
        case .unverified: return .unverified
        case .withdrawn: return .withdrawn
        default: return nil
        }
    }

    /// The banner's legend: each mark the document has, with how many sentences wear it (`wikiDocLegend`).
    public static func legend(_ doc: WikiDoc) -> [(mark: Mark, label: String, count: Int)] {
        let counts = doc.counts
        return Mark.allCases.compactMap { mark in
            let n: Int
            switch mark {
            case .unsourced: n = counts?.unsourced ?? 0
            case .unverified: n = counts?.unverified ?? 0
            case .withdrawn: n = counts?.withdrawn ?? 0
            }
            return n > 0 ? (mark, mark.label, n) : nil
        }
    }

    /// The sections a withdrawal left waiting for the next run (`wikiDocRewriteNote`).
    public static func rewriteNote(_ sections: [WikiDocSection]) -> String? {
        let stale = sections.filter { $0.stale == true }.compactMap(\.number)
        return stale.isEmpty ? nil : "\(WikiDocCopy.sectionList(stale)) rewritten at the next run"
    }

    /// The sentence under a document no run has written yet (`wikiDocNotWrittenNote`).
    public static func notWrittenNote(written: Int?, total: Int?) -> String {
        var count = ""
        if let written, let total { count = " — \(WikiArticleCopy.count(written)) of \(plural(total, "document is", "documents are")) written" }
        return "Wiki maintenance writes it on its next run\(count). What it will cover is below."
    }

    /// The phone's folded reader-and-scope row: how many lines each of its three fields holds (`wikiDocScopeCounts`).
    public static func scopeCounts(_ doc: WikiDoc) -> String {
        [doc.audience?.count ?? 0, doc.scopeIn?.count ?? 0, doc.scopeOut?.count ?? 0].map(WikiArticleCopy.count).joined(separator: " · ")
    }

    /// Where a «Not covered» line leaves its matter: `→ 3.2`, the document's number, else its title (`wikiScopeTarget`).
    public static func scopeTarget(_ target: WikiDoc.ScopeOut.Target) -> String {
        "→ \(target.number ?? target.title ?? target.slug)"
    }

    // MARK: a marked sentence, explained

    /// What a footnote points at, as the explanations name it.
    private static func originWord(_ note: WikiDocFootnote) -> String {
        switch note.kind {
        case .code: return "code"
        case .designDoc: return "a design doc"
        case .contract: return "a contract"
        default: return "a record"
        }
    }

    /// The record a footnote quotes, as a sentence names it: `event #2703`, `turn #4`, `tool call Bash` (`wikiRecordName`).
    public static func recordName(_ note: WikiDocFootnote) -> String {
        switch note.kind {
        case .turn: return note.seq.map { "turn #\($0)" } ?? "turn"
        case .event: return note.seq.map { "event #\($0)" } ?? "event"
        case .toolCall: return note.label.map { "tool call \($0)" } ?? "tool call"
        case .task: return "task"
        case .taskComment: return "comment"
        case .approval: return note.label.map { "approval of \($0)" } ?? "approval"
        case .ownerDecision: return "decision"
        case .mergeReceipt: return "merge receipt"
        case .note: return "note"
        default: return "lines"
        }
    }

    private static func withdrawClause(_ reason: WikiDocWithdrawReason) -> String {
        switch reason {
        case .rejected: return "which you rejected"
        case .retired: return "which was retired"
        case .superseded: return "which was superseded"
        case .anchorChanged: return "whose anchor changed"
        case .anchorMissing: return "whose anchor went missing"
        case .unknown: return "which left the wiki"
        }
    }

    /// Why a marked sentence wears its mark (`WikiMarkNote`): the tap bubble's words.
    public struct MarkNote: Equatable, Sendable {
        /// Bold, first: `No source.`
        public let title: String
        public let text: String
        /// The footnote a not-verified sentence failed on: `See footnote [10]`.
        public let see: Int?
        /// The entry a withdrawn sentence came through: `Open the entry ›`.
        public let entryId: String?
    }

    /// Why a marked sentence wears its mark (`wikiMarkNote`).
    public static func markNote(_ sentence: WikiDocSentence, section: WikiDocSection, doc: WikiDoc,
                                timeZone: TimeZone = .current) -> MarkNote? {
        let number = section.number ?? 0
        switch mark(sentence) {
        case .unsourced?:
            return MarkNote(title: "\(WikiDocCopy.noSource).",
                            text: "This sentence states something no footnote backs. It’s written again, with a source or without the claim, when §\(number) is.",
                            see: nil, entryId: nil)
        case .unverified?:
            let notes = Dictionary((doc.footnotes ?? []).map { ($0.n, $0) }, uniquingKeysWith: { first, _ in first })
            let failed = (sentence.notes ?? []).compactMap { notes[$0] }.first { $0.verdict != .verified }
            var text = "Its footnote couldn’t be checked, so neither could the sentence."
            if let failed {
                switch failed.verdict {
                case .noQuote: text = "Its footnote cites \(originWord(failed)) without quoting it, so the sentence couldn’t be checked."
                case .notFound: text = "Its footnote’s quote isn’t in the \(recordName(failed)) it cites, so the sentence couldn’t be checked."
                case .unresolved: text = "Its footnote cites a record this wiki can’t read, so the sentence couldn’t be checked."
                default: break
                }
            }
            return MarkNote(title: "\(WikiDocCopy.notVerified).", text: text, see: failed?.n, entryId: nil)
        case .withdrawn?:
            guard let withdrawn = sentence.withdrawn else { return nil }
            let entry = (doc.entries ?? []).first { $0.id == withdrawn.entryId }
            let name = entry.map { "「\($0.title)」" } ?? "an entry"
            let day = withdrawn.at.flatMap { WikiModeLogic.monthDay($0, timeZone: timeZone) }
            return MarkNote(title: "\(WikiDocCopy.withdrawn).",
                            text: "It came through \(name), \(withdrawClause(withdrawn.reason))\(day.map { " on \($0)" } ?? ""). "
                                + "§\(number) is written again at the next maintenance run.",
                            see: nil, entryId: withdrawn.entryId)
        case nil:
            return nil
        }
    }

    // MARK: a footnote

    /// A repository original: its lines are read on the runner at a sha, not by the server.
    public static func isRepo(_ note: WikiDocFootnote) -> Bool {
        note.kind == .designDoc || note.kind == .code || note.kind == .contract
    }

    private static let eventLabels: [String: String] = [
        "assistant": "Agent reply", "user": "User message", "tool_use": "Tool call", "tool_result": "Command output",
        "error": "Error", "thinking": "Thinking", "result": "Run result", "status": "Status",
    ]

    /// Whose words a record footnote quotes, after its kind (`wikiFootnoteSubLabel`).
    public static func subLabel(_ note: WikiDocFootnote) -> String? {
        switch note.kind {
        case .turn: return note.label == "steer" ? "Steer" : "User message"
        case .event: return note.label.flatMap { eventLabels[$0] }
        case .toolCall: return "Command output"
        case .taskComment: return note.label == "AGENT" ? "Agent’s comment" : note.label == "USER" ? "Your comment" : nil
        default: return nil
        }
    }

    /// `L330–341`, or `L12` for one line (`wikiLineRange`).
    public static func lineRange(_ start: Int?, _ end: Int?) -> String? {
        guard let start else { return nil }
        if let end, end != start { return "L\(start)–\(end)" }
        return "L\(start)"
    }

    /// A repository original's first part: `docs/architecture.md § Execution model`, `src/x.ts · Symbol`.
    private static func repoWhere(_ note: WikiDocFootnote) -> String {
        let path = note.path ?? note.location ?? ""
        if note.kind == .designDoc, let section = note.section { return "\(path) § \(section)" }
        if note.kind == .code, let symbol = note.symbol { return "\(path) · \(symbol)" }
        return path
    }

    /// A record's place: what it belongs to, its own name, and when it was made.
    private static func recordParts(_ note: WikiDocFootnote, withProject: Bool, timeZone: TimeZone) -> [String] {
        var parts: [String] = []
        switch note.kind {
        case .turn, .event, .toolCall, .approval:
            if let title = note.sessionTitle { parts.append(title) }
            if withProject, let project = note.projectTitle { parts.append(project) }
        case .task, .taskComment:
            if let title = note.taskTitle { parts.append(title) }
            if withProject, let project = note.projectTitle { parts.append(project) }
        case .mergeReceipt:
            if let title = note.taskTitle ?? note.sessionTitle { parts.append(title) }
        case .ownerDecision:
            if let project = note.projectTitle { parts.append(project) }
        case .note:
            return [note.notePath ?? note.location ?? ""]
        default:
            break
        }
        parts.append(recordName(note))
        if let when = WikiDocCopy.monthDayTime(note.at, timeZone: timeZone) { parts.append(when) }
        return parts
    }

    /// Where a footnote's original is, in the list under the text (`wikiFootnoteWhere`).
    public static func footnoteWhere(_ note: WikiDocFootnote, timeZone: TimeZone = .current) -> String {
        isRepo(note) ? repoWhere(note) : recordParts(note, withProject: false, timeZone: timeZone).joined(separator: " · ")
    }

    /// The card's place line (`wikiFootnotePlace`): a record with its project, a repository original with its lines.
    public static func footnotePlace(_ note: WikiDocFootnote, timeZone: TimeZone = .current) -> String {
        if isRepo(note) {
            let lines = lineRange(note.lineStart, note.lineEnd)
            return lines.map { "\(repoWhere(note)) · \($0)" } ?? repoWhere(note)
        }
        return recordParts(note, withProject: true, timeZone: timeZone).joined(separator: " · ")
    }

    /// `https://github.com/<owner>/<repo>` for a space whose repository is on GitHub, else nil (`wikiGithubRepo`).
    public static func githubRepo(_ repoUrlNorm: String?) -> String? {
        guard let text = repoUrlNorm,
              let regex = try? NSRegularExpression(pattern: #"^github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let owner = Range(match.range(at: 1), in: text), let repo = Range(match.range(at: 2), in: text)
        else { return nil }
        return "https://github.com/\(text[owner])/\(text[repo])"
    }

    /// Where a footnote's one button goes (`WikiFootnoteOpen`).
    public enum OpenTarget: Equatable, Sendable {
        /// The session's transcript, opened at the quoted record (`SessionRecordLink`).
        case sessionRecord(session: String, record: String)
        case task(String)
        case session(String)
        case project(String)
        /// The repository's host, in the browser.
        case external(URL)
    }

    public struct FootnoteOpen: Equatable, Sendable {
        public let label: String
        public let target: OpenTarget
    }

    /// The characters `encodeURIComponent` leaves as they are.
    private static let uriComponent = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    /// The footnote's way to its original (`wikiFootnoteOpen`; the phone sheet's one button, owner's call
    /// 2026-09-29): a session record opens its session at that record, a comment its task, repository lines
    /// the file on GitHub at the commit the run read it at. Nil where Orbit has nothing to open — a note.
    public static func footnoteOpen(_ note: WikiDocFootnote, github: String?) -> FootnoteOpen? {
        if isRepo(note) {
            guard let github, let path = note.path, let sha = note.sha else { return nil }
            var lines = ""
            if let start = note.lineStart {
                lines = "#L\(start)"
                if let end = note.lineEnd, end != start { lines += "-L\(end)" }
            }
            let encoded = path.split(separator: "/", omittingEmptySubsequences: false)
                .map { $0.addingPercentEncoding(withAllowedCharacters: uriComponent) ?? String($0) }
                .joined(separator: "/")
            guard let url = URL(string: "\(github)/blob/\(sha)/\(encoded)\(lines)") else { return nil }
            return FootnoteOpen(label: "Open on GitHub at \(WikiLogic.shortSha(sha)) ↗", target: .external(url))
        }
        let record = note.sessionRecord.map { OpenTarget.sessionRecord(session: $0.session, record: $0.record) }
        switch note.kind {
        case .turn: return record.map { FootnoteOpen(label: "Open at this turn", target: $0) }
        case .event: return record.map { FootnoteOpen(label: "Open at this event", target: $0) }
        case .toolCall: return record.map { FootnoteOpen(label: "Open at this tool call", target: $0) }
        case .task: return note.taskId.map { FootnoteOpen(label: "Open the task", target: .task($0)) }
        case .taskComment: return note.taskId.map { FootnoteOpen(label: "Open the comment", target: .task($0)) }
        case .approval, .mergeReceipt: return note.sessionId.map { FootnoteOpen(label: "Open the session", target: .session($0)) }
        case .ownerDecision: return note.projectId.map { FootnoteOpen(label: "Open the project", target: .project($0)) }
        default: return nil
        }
    }

    /// The red line of a footnote that did not check (`wikiFootnoteProblem`).
    public static func footnoteProblem(_ note: WikiDocFootnote) -> String? {
        switch note.verdict {
        case .notFound:
            return "These words aren’t in the \(recordName(note)) it cites. Open it to see what it does say."
        case .noQuote:
            let what = isRepo(note) ? (note.kind == .designDoc ? "design doc" : note.kind.rawValue) : "record"
            return "The sentence cites this \(what) without quoting it, so it couldn’t be checked."
        case .unresolved:
            return "The record it cites isn’t one this wiki can read, so it couldn’t be checked."
        default:
            return nil
        }
    }

    /// A quote as the pages print it, in curly quotes (`wikiQuoted`).
    public static func quoted(_ quote: String) -> String { "“\(quote)”" }

    /// One line of a repository footnote's excerpt, and whether the quote is on it (`WikiExcerptLine`).
    public struct ExcerptLine: Equatable, Sendable, Identifiable {
        public let n: Int
        public let text: String
        public let quoted: Bool
        public var id: Int { n }
    }

    private static func replacing(_ text: String, _ pattern: String, with: String) -> String {
        text.replacingOccurrences(of: pattern, with: with, options: .regularExpression)
    }

    /// A line's words without a comment's opening marks, whitespace folded: what a quote is looked for in.
    private static func lineCore(_ text: String) -> String {
        var core = replacing(text, #"^\s*(?:/\*\*?|\*/|\*|//+|#+|--)\s?"#, with: "")
        core = replacing(core, #"\s*\*/\s*$"#, with: "")
        core = replacing(core, #"\s+"#, with: " ")
        return core.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The excerpt's lines, numbered from the first line the runner read, the quoted ones lit, and how many
    /// are left after the first `shown` (`wikiExcerptLines`).
    public static func excerptLines(_ note: WikiDocFootnote, shown: Int) -> (lines: [ExcerptLine], more: Int) {
        guard var excerpt = note.excerpt, !excerpt.isEmpty else { return ([], 0) }
        if excerpt.hasSuffix("\n") { excerpt.removeLast() }
        let all = excerpt.components(separatedBy: "\n")
        let start = note.lineStart ?? 1
        let quote = note.quote.map { replacing($0, #"\s+"#, with: " ").trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        let lines = all.enumerated().map { i, text -> ExcerptLine in
            let core = lineCore(text)
            let lit = !quote.isEmpty && !core.isEmpty && (core.contains(quote) || (core.utf16.count >= 8 && quote.contains(core)))
            return ExcerptLine(n: start + i, text: text, quoted: lit)
        }
        return (Array(lines.prefix(shown)), max(0, lines.count - shown))
    }

    /// The footnotes' heading line (`wikiFootnotesSummary`): `45 · 14 session quotes · 30 code & doc quotes · 1 note`.
    public static func footnotesSummary(_ footnotes: [WikiDocFootnote]) -> String {
        ([WikiArticleCopy.count(footnotes.count)] + quoteCounts(footnotes)).joined(separator: " · ")
    }

    // MARK: the entries under the document

    /// What happened to a via entry that left the wiki (`wikiViaEntryStatus`).
    public static func viaEntryStatus(_ entry: WikiDocViaEntry) -> String? {
        switch entry.status {
        case .rejected?: return "Rejected by you"
        case .retired?: return "Retired"
        case .superseded?: return "Superseded"
        default: return nil
        }
    }

    /// A via entry that left the wiki, under its title (`wikiViaEntryNote`): what happened, and what that did.
    public static func viaEntryNote(_ entry: WikiDocViaEntry, doc: WikiDoc) -> String? {
        var withdrawn: [Int] = []
        var count = 0
        for section in doc.sections ?? [] {
            for block in section.blocks ?? [] {
                for sentence in block.sentences ?? [] where sentence.withdrawn?.entryId == entry.id {
                    count += 1
                    withdrawn.append(section.number ?? 0)
                }
            }
        }
        var parts = viaEntryStatus(entry).map { [$0] } ?? []
        if count == 1 { parts.append("its sentence in \(WikiDocCopy.sectionList(withdrawn)) is withdrawn") }
        else if count > 1 { parts.append("its sentences in \(WikiDocCopy.sectionList(withdrawn)) are withdrawn") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// One of the kind groups the entries are drawn in.
    public struct EntryGroup: Equatable, Sendable, Identifiable {
        public let title: String
        public let note: String
        public let entries: [WikiDocViaEntry]
        public var id: String { title }
    }

    /// The entries by kind (`wikiDocEntryGroups`), in the topic page's groups, each in the order its quotes
    /// first appear.
    public static func entryGroups(_ entries: [WikiDocViaEntry]) -> [EntryGroup] {
        func first(_ entry: WikiDocViaEntry) -> Int { (entry.notes ?? []).min() ?? Int.max }
        return WikiArticleLogic.entryGroupKinds.compactMap { group in
            let held = entries.filter { entry in entry.kind.map(group.kinds.contains) ?? false }
                .sorted { a, b in first(a) != first(b) ? first(a) < first(b) : a.id < b.id }
            return held.isEmpty ? nil : EntryGroup(title: group.title, note: group.note, entries: held)
        }
    }

    // MARK: the directory, by the confirmed plan

    public struct DirectorySection: Equatable, Sendable, Identifiable {
        public let key: String
        public let number: Int
        public let title: String
        public let written: Bool
        public let stale: Bool
        public var id: String { key }
    }

    public struct DirectoryDoc: Equatable, Sendable, Identifiable {
        public let slug: String
        public let number: String
        public let title: String
        public let written: Bool
        /// An amber dot: the whole document is marked.
        public let needsReview: Bool
        public let sections: [DirectorySection]
        public var id: String { slug }
    }

    public struct DirectoryGroup: Equatable, Sendable, Identifiable {
        public let key: String
        public let number: Int
        public let title: String
        public let docs: [DirectoryDoc]
        public var id: String { key }
    }

    /// The directory's groups (`wikiDocDirectoryGroups`): the plan's categories in its order, each with its
    /// documents; a category with none left out.
    public static func directoryGroups(_ directory: WikiDocsDirectory) -> [DirectoryGroup] {
        directory.categories.compactMap { category in
            let docs = category.docs ?? []
            guard !docs.isEmpty else { return nil }
            return DirectoryGroup(
                key: category.key, number: category.number ?? 0,
                title: category.title.isEmpty ? category.key : category.title,
                docs: docs.map { doc in
                    DirectoryDoc(slug: doc.slug, number: doc.number ?? "", title: doc.title.isEmpty ? doc.slug : doc.title,
                                 written: doc.written ?? false, needsReview: doc.status == .needsReview,
                                 sections: (doc.sections ?? []).map {
                                     DirectorySection(key: $0.key, number: $0.number ?? 0, title: $0.title,
                                                      written: $0.written ?? false, stale: $0.stale ?? false)
                                 })
                })
        }
    }

    /// Whether a space reads by its documents (a plan is confirmed), or still by topic (`wikiReadsByDocs`).
    public static func readsByDocs(_ directory: WikiDocsDirectory?) -> Bool { directory?.plan != nil }

    // MARK: Browse by category, by document

    private static func sectionCount(_ docs: [WikiDocsDirectory.Doc]) -> Int {
        docs.reduce(0) { $0 + ($1.sections ?? []).count }
    }

    /// Browse's line under its title (`wikiDocsBrowseSummary`): `49 documents · 10 categories · 371 sections`, `plan v1`.
    public static func browseSummary(_ directory: WikiDocsDirectory) -> [String] {
        let categories = directory.categories.filter { !($0.docs ?? []).isEmpty }
        let docs = directory.categories.flatMap { $0.docs ?? [] }
        var parts = ["\(plural(docs.count, "document", "documents")) · \(plural(categories.count, "category", "categories")) · "
            + plural(sectionCount(docs), "section", "sections")]
        if let plan = directory.plan { parts.append("plan v\(plan.version)") }
        return parts
    }

    /// A category's line beside its title (`wikiDocsCategoryLine`): `3 documents · 20 sections`.
    public static func categoryLine(_ category: WikiDocsDirectory.Category) -> String {
        let docs = category.docs ?? []
        return "\(plural(docs.count, "document", "documents")) · \(plural(sectionCount(docs), "section", "sections"))"
    }

    /// A document's state beside its sections' count in Browse (`wikiDocsDocLine`).
    public enum DocState: Equatable, Sendable {
        case needsReview, notWritten

        public var text: String { self == .needsReview ? WikiDocCopy.needsReview : WikiDocCopy.notWrittenShort }
        /// `warn` (amber) or `muted` (grey), as the web's tones.
        public var tone: String { self == .needsReview ? "warn" : "muted" }
    }

    public static func docLine(_ doc: WikiDocsDirectory.Doc) -> (sections: String, state: DocState?) {
        let sections = plural((doc.sections ?? []).count, "section", "sections")
        if doc.written != true { return (sections, .notWritten) }
        return (sections, doc.status == .needsReview ? .needsReview : nil)
    }

    // MARK: the A–Z index, by document

    /// The index's line under its title (`wikiDocsIndexSummary`).
    public static func indexSummary(_ items: [WikiDocsIndex.Item]) -> String {
        let docs = items.filter { $0.kind == "doc" }.count
        return "\(plural(docs, "document", "documents")) and \(plural(items.count - docs, "section", "sections")) by title · Chinese titles by pinyin"
    }

    /// An index row's second line (`wikiDocsIndexMeta`): `1.3 · 产品概览 · document`, or `§2 in 7.1 Runner 架构与注册`.
    public static func indexMeta(_ item: WikiDocsIndex.Item) -> String {
        if item.kind == "doc" { return "\(item.docNumber ?? "") · \(item.category?.title ?? item.category?.key ?? "") · document" }
        return "§\(item.sectionNumber ?? 0) in \(item.docNumber ?? "") \(item.docTitle ?? item.docSlug)"
    }

    public struct IndexGroup: Equatable, Sendable, Identifiable {
        public let letter: String
        public let items: [WikiDocsIndex.Item]
        public var id: String { letter }
    }

    /// Every title under its letter (`wikiDocsIndexGroups`), the letters in the bar's order, each group by
    /// pinyin, a document before a section of the same title.
    public static func indexGroups(_ items: [WikiDocsIndex.Item]) -> [IndexGroup] {
        let sorted = items.sorted { a, b in
            switch WikiArticleLogic.pinyinOrder(a.title, b.title) {
            case .orderedAscending: return true
            case .orderedDescending: return false
            case .orderedSame:
                if a.kind != b.kind { return a.kind == "doc" }
                switch WikiArticleLogic.pinyinOrder(a.docNumber ?? "", b.docNumber ?? "") {
                case .orderedAscending: return true
                case .orderedDescending: return false
                case .orderedSame: return (a.sectionNumber ?? 0) < (b.sectionNumber ?? 0)
                }
            }
        }
        var byLetter: [String: [WikiDocsIndex.Item]] = [:]
        for item in sorted { byLetter[WikiArticleLogic.indexInitial(item.title), default: []].append(item) }
        return WikiArticleLogic.indexLetters.compactMap { letter in byLetter[letter].map { IndexGroup(letter: letter, items: $0) } }
    }
}

extension WikiDocsIndex.Item: Identifiable {
    /// A document, or a section of one.
    public var id: String { "\(docSlug):\(sectionKey ?? "")" }
}
