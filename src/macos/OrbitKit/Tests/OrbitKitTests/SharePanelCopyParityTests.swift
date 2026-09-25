import Foundation
import XCTest
@testable import OrbitKit

/// The Share panel, and the ⋯ menus that open it, say what the web says (docs/share-links-design.md
/// §8). `SharePanel` and `ShareMarkdown` are ports of `ShareModal.tsx`, `lib/shareLinks.ts`, the
/// task panel's and the project header's ⋯ menus and their Copy as Markdown, and nothing in either
/// build notices a word changed at one end only — so every word the panel and the menus draw is
/// looked up in the web source it came from.
///
/// Byte for byte, with one kind of exception: a button or a menu item takes the platform's title
/// case where the contract spells it so for the apps (`Copy link` → `Copy Link`), and `Share Link…`,
/// which hands the link to the system share sheet the web does not have, is pinned to the contract
/// instead. A missing counterpart is a FAILURE, never an `XCTSkip`.
final class SharePanelCopyParityTests: XCTestCase {

    private static let modal = "src/web/src/components/ShareModal.tsx"
    private static let lib = "src/web/src/lib/shareLinks.ts"
    private static let taskPanel = "src/web/src/components/TaskDetailPanel.tsx"
    private static let projectControls = "src/web/src/components/ProjectShareControls.tsx"
    private static let outcome = "src/web/src/lib/taskOutcome.ts"
    private static let statusPill = "src/web/src/components/TaskStatusPill.tsx"
    private static let taskPage = "src/web/src/pages/TaskDetailPage.tsx"
    private static let runnerSlots = "src/web/src/lib/runnerSlots.ts"
    private static let contract = "docs/share-links-design.md"

    private enum ParityError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let file):
                return "\(file) was not found above this test file. The Share panel is one half of a pair; "
                    + "if the web half moved, move this check with it rather than deleting it."
            }
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.missing(relative)
    }

    private func assertSays(_ web: String, _ literal: String, in file: String,
                            file testFile: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(file) no longer says \(literal)", file: testFile, line: line)
    }

    /// The platform's title case for a button or a menu item: every word capitalised but a short
    /// article, conjunction or preposition after the first — "Copy link" → "Copy Link", while
    /// "Copy as Markdown" is already it.
    private func titleCased(_ label: String) -> String {
        let minor: Set<String> = ["a", "an", "the", "and", "but", "or", "for", "nor", "as", "at", "by", "in",
                                  "of", "on", "to", "with"]
        return label.split(separator: " ", omittingEmptySubsequences: false).enumerated().map { index, word in
            if index > 0 && minor.contains(word.lowercased()) { return String(word) }
            return word.prefix(1).uppercased() + word.dropFirst()
        }.joined(separator: " ")
    }

    /// The part of `text` from `start` up to (not including) `end`, or to its end.
    private func slice(_ text: String, from start: String, to end: String?) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        guard let end, let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
            return String(text[lower.lowerBound...])
        }
        return String(text[lower.lowerBound..<upper.lowerBound])
    }

    /// The row objects of a kind's `layers: [...]`, in order: each from its `{` to its `},`.
    private func rows(in block: String) throws -> [String] {
        try slice(block, from: "layers: [", to: nil)
            .components(separatedBy: "\n      {\n").dropFirst()
            .map { $0.components(separatedBy: "\n      },").first ?? $0 }
    }

    /// A row object's `name: '…'`.
    private func name(of row: String) -> String? {
        guard let start = row.range(of: "name: '"),
              let end = row.range(of: "'", range: start.upperBound..<row.endIndex) else { return nil }
        return String(row[start.upperBound..<end.lowerBound])
    }

    /// The last non-blank line of a JSX slice — the words an element closes on.
    private func lastWords(_ text: String) -> String? {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.last
    }

    /// The one line of `text` that contains `needle`.
    private func line(in text: String, containing needle: String) -> String? {
        text.split(separator: "\n").first { $0.contains(needle) }.map(String.init)
    }

    // MARK: the panel

    func testTheTitleAndWhatAVisitorCanDoAreTheDialogsForEachKind() throws {
        let web = try source(Self.modal)
        for kind in ShareRootKind.allCases {
            assertSays(web, "title: '\(SharePanelCopy.title(kind))'", in: Self.modal)
            assertSays(web, "publicDetail: '\(SharePanelCopy.publicDetail(kind))'", in: Self.modal)
        }
    }

    func testAccessSaysWhatTheDialogSays() throws {
        let web = try source(Self.modal)
        assertSays(web, "aria-label=\"\(SharePanelCopy.access)\"", in: Self.modal)
        assertSays(web, "title=\"\(SharePanelCopy.onlyYou)\"", in: Self.modal)
        assertSays(web, "detail=\"\(SharePanelCopy.onlyYouDetail)\"", in: Self.modal)
        assertSays(web, "title=\"\(SharePanelCopy.anyoneWithTheLink)\" detail=\"\(SharePanelCopy.anyoneWithTheLinkDetail)\"",
                   in: Self.modal)
        assertSays(web, "{link ? '\(SharePanelCopy.anyoneWithTheLink)' : '\(SharePanelCopy.onlyYou)'}", in: Self.modal)
        assertSays(web, "'\(SharePanelCopy.privateDetail)'", in: Self.modal)
        // The picker's two choices, Only you first, as the dialog's menu lists them.
        XCTAssertLessThan(try XCTUnwrap(web.range(of: "key: 'private'")).lowerBound,
                          try XCTUnwrap(web.range(of: "key: 'public'")).lowerBound)
        XCTAssertEqual(SharePanel.Access.allCases.map(\.label),
                       [SharePanelCopy.onlyYou, SharePanelCopy.anyoneWithTheLink])
        XCTAssertEqual(SharePanel.Access.allCases.map(\.detail),
                       [SharePanelCopy.onlyYouDetail, SharePanelCopy.anyoneWithTheLinkDetail])
    }

    func testAFailedReadSaysSoInTheDialogsWords() throws {
        let web = try source(Self.modal)
        assertSays(web, "\(SharePanelCopy.couldNotLoad) {shareQ.error.message}", in: Self.modal)
        let retry = try slice(web, from: "onClick={() => void shareQ.refetch()}>", to: "</Button>")
        XCTAssertEqual(lastWords(retry), SharePanelCopy.retry)
    }

    func testTurningOffAsksInTheContractsWords() throws {
        let web = try source(Self.modal)
        assertSays(web, "const TURN_OFF_TITLE = '\(SharePanelCopy.turnOffTitle)';", in: Self.modal)
        assertSays(web, "const TURN_OFF_DETAIL = '\(SharePanelCopy.turnOffDetail)';", in: Self.modal)
        assertSays(web, "okText=\"\(SharePanelCopy.turnOff)\"", in: Self.modal)
        assertSays(web, "cancelText=\"\(SharePanelCopy.cancel)\"", in: Self.modal)
        let contract = try source(Self.contract)
        assertSays(contract, "`\(SharePanelCopy.turnOffTitle)` / `\(SharePanelCopy.turnOffDetail)`", in: Self.contract)
    }

    func testTheLinksPressesAreTheContractsAndCopiedIsTheDialogs() throws {
        let web = try source(Self.modal)
        assertSays(web, "{copied ? '\(SharePanelCopy.copied)' : 'Copy'}", in: Self.modal)
        let done = try slice(web, from: "<Button type=\"primary\" onClick={onClose}>", to: "</Button>")
        XCTAssertEqual(lastWords(done), SharePanelCopy.done, "\(Self.modal) no longer closes with \(SharePanelCopy.done)")
        // The apps' panel, as the contract draws it: Access Picker → the link, Copy Link, Share Link….
        let contract = try source(Self.contract)
        let apps = try slice(contract, from: "- iOS/macOS：", to: "- 对话框的关闭确认")
        assertSays(apps, "链接、\(SharePanelCopy.copyLink)、\(SharePanelCopy.shareLink) → Includes", in: Self.contract)
        assertSays(apps, "改名为 `\(SharePanelCopy.copyLink)`，新增 `\(SharePanelCopy.share)`", in: Self.contract)
        XCTAssertEqual(SharePanelCopy.shareLink, titleCased("Share link…"))
    }

    func testEachKindsLayersAreTheDialogsInItsOrderWithItsWords() throws {
        let web = try source(Self.modal)
        let blocks: [(ShareRootKind, String)] = [
            (.session, try slice(web, from: "  SESSION: {", to: "  TASK: {")),
            (.task, try slice(web, from: "  TASK: {", to: "  PROJECT: {")),
            (.project, try slice(web, from: "  PROJECT: {", to: "/** Whether this dialog can be opened")),
        ]
        let everything = ShareCounts(messages: 2, toolCalls: 2, tasks: 2, comments: 2, files: 2, runs: 2, transcripts: 3)
        for (kind, block) in blocks {
            var panel = SharePanel(kind: kind)
            panel.loaded(ShareLinkRead(
                link: ShareLink(id: "l", kind: kind, token: "t",
                                include: ShareInclude(taskPages: true, commentsAndFiles: true, conversations: true,
                                                      toolOutput: true),
                                root: ShareRootSummary(id: "r")),
                counts: everything))
            let webRows = try rows(in: block)
            XCTAssertEqual(panel.layers.map(\.name), webRows.map(name(of:)), "\(kind)'s Includes, in the dialog's order")
            for (row, web) in zip(panel.layers, webRows) {
                // The root's own row is the one without a layer, and the one that is always counted.
                XCTAssertEqual(web.contains("layer: null"), row.layer == nil, "\(kind) \(row.name)")
                if let layer = row.layer { assertSays(web, "layer: '\(layer.rawValue)'", in: Self.modal) }
                XCTAssertEqual(web.contains("under: 'taskPages'"), row.isNested, "\(kind) \(row.name) nesting")
                XCTAssertEqual(web.contains("warn: true"), row.warns, "\(kind) \(row.name) risk")
                if row.name == "Conversations" {
                    assertSays(web, kind == .project ? "${CONVERSATIONS_RISK}" : "detail: CONVERSATIONS_RISK",
                               in: Self.modal)
                } else {
                    assertSays(web, "detail: '\(row.detail)'", in: Self.modal)
                }
            }
        }
        assertSays(web, "export const CONVERSATIONS_RISK = '\(SharePanelCopy.conversationsRisk)';", in: Self.modal)
        let contract = try source(Self.contract)
        assertSays(contract, "`\(SharePanelCopy.conversationsRisk)`", in: Self.contract)
        // What a project's transcripts are: its runs, and the coordinator when there are more of them.
        assertSays(web, "`${countOf(counts.runs ?? 0, 'run')}${(counts.transcripts ?? 0) > (counts.runs ?? 0) ? ' and the coordinator' : ''}. ${CONVERSATIONS_RISK}`",
                   in: Self.modal)
    }

    func testEachLayersCountIsTheDialogsCount() throws {
        let web = try source(Self.modal)
        assertSays(web, "count: () => '\(SharePanelCopy.always)'", in: Self.modal)
        for (field, noun) in [("messages", "message"), ("toolCalls", "call"), ("comments", "comment"),
                              ("transcripts", "transcript"), ("tasks", "task")] {
            assertSays(web, "countOf(counts.\(field) ?? 0, '\(noun)')", in: Self.modal)
        }
        assertSays(web, "...(counts.files ? [countOf(counts.files, 'file')] : [])].join(' · ')", in: Self.modal)
        let lib = try source(Self.lib)
        assertSays(lib, "export const countOf = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;",
                   in: Self.lib)
        XCTAssertEqual([SharePanelCopy.countOf(1, "call"), SharePanelCopy.countOf(0, "task"),
                        SharePanelCopy.countOf(29, "comment")], ["1 call", "0 tasks", "29 comments"])
    }

    func testIncludesUpdatesAndExpiresAreTheDialogsRows() throws {
        let web = try source(Self.modal)
        assertSays(web, "<div className=\"share-dialog-label\">\(SharePanelCopy.includes)</div>", in: Self.modal)
        assertSays(web, "<span className=\"share-dialog-key\">\(SharePanelCopy.updates)</span>", in: Self.modal)
        let live = try slice(web, from: "<span className=\"share-dialog-live\">", to: "</span>")
        XCTAssertEqual(lastWords(live), SharePanelCopy.live,
                       "\(Self.modal) no longer says \(SharePanelCopy.live)")
        assertSays(web, "<span className=\"share-dialog-key\">\(SharePanelCopy.expires)</span>", in: Self.modal)
        assertSays(web, "aria-label=\"\(SharePanelCopy.expires)\"", in: Self.modal)
        assertSays(web, "`Until ${shortDate(expiry)}`", in: Self.modal)
        assertSays(web, "Stops working {shortDate(expiry)}", in: Self.modal)
        let contract = try source(Self.contract)
        assertSays(contract, "「\(SharePanelCopy.live)」", in: Self.contract)
    }

    func testExpiresOffersTheDialogsChoices() throws {
        let lib = try source(Self.lib)
        for choice in ShareExpiryChoice.all {
            let days = choice.days.map(String.init) ?? "null"
            assertSays(lib, "{ value: '\(choice.value)', label: '\(choice.label)', days: \(days) }", in: Self.lib)
        }
        assertSays(lib, "toLocaleDateString('en-US', { month: 'short', day: 'numeric' })", in: Self.lib)

        // The panel's own renderings, against the dialog's templates.
        var panel = SharePanel(kind: .task)
        panel.loaded(ShareLinkRead(link: ShareLink(id: "l", kind: .task, token: "t",
                                                   expiresAt: "2026-10-02T12:00:00.000Z",
                                                   root: ShareRootSummary(id: "r"))))
        XCTAssertEqual(panel.untilLabel, "Until Oct 2")
        _ = panel.chooseExpiry("7", now: Date(timeIntervalSince1970: 1_790_337_600))
        XCTAssertEqual(panel.expiryHint, "Stops working Oct 2")
    }

    func testHowOftenItWasOpenedIsTheListsLine() throws {
        let lib = try source(Self.lib)
        for phrase in ["if (link.viewCount === 0) return '\(SharePanelCopy.notOpenedYet)';",
                       "link.viewCount === 1 ? 'once' : `${link.viewCount} times`",
                       "`Viewed ${times} · last ${ago(link.lastViewedAt, now)}` : `Viewed ${times}`"] {
            assertSays(lib, phrase, in: Self.lib)
        }
        let now = Date(timeIntervalSince1970: 1_790_337_600)
        XCTAssertEqual(SharePanelCopy.viewsLine(viewCount: 14, lastViewedAt: "2026-09-25T10:00:00.000Z", now: now),
                       "Viewed 14 times · last 2h ago")
        XCTAssertEqual(SharePanelCopy.viewsLine(viewCount: 1, lastViewedAt: nil, now: now), "Viewed once")
    }

    // MARK: the ⋯ menus

    func testTheTaskAndProjectMenusOfferTheWebsThreeInItsOrder() throws {
        for file in [Self.taskPanel, Self.projectControls] {
            let web = try source(file)
            let items = try slice(web, from: "key: 'copy-link'", to: "</Dropdown>")
            let order = ["key: 'copy-link'", "key: 'share'", "key: 'copy-markdown'"].map {
                items.range(of: $0)?.lowerBound
            }
            XCTAssertFalse(order.contains(nil), "\(file) lost one of Copy link, Share…, Copy as Markdown")
            XCTAssertEqual(order.compactMap { $0 }, order.compactMap { $0 }.sorted(), "\(file) reordered its menu")

            let copyLink = try slice(items, from: "key: 'copy-link'", to: "key: 'share'")
            assertSays(copyLink, "label: 'Copy link'", in: file)
            XCTAssertEqual(SharePanelCopy.copyLink, titleCased("Copy link"), "the same words, as a menu item")
            // The web's copy can fail and says so; a native pasteboard write has no failure to report.
            assertSays(copyLink, "'\(SharePanelCopy.linkCopied)'", in: file)

            let share = try slice(items, from: "key: 'share'", to: "key: 'copy-markdown'")
            assertSays(share, "\(SharePanelCopy.share)<span className=\"scope-menu-value\">\(SharePanelCopy.liveLink)</span>",
                       in: file)
            assertSays(share, "'\(SharePanelCopy.share)'", in: file)

            let markdown = try slice(items, from: "key: 'copy-markdown'", to: nil)
            assertSays(markdown, "label: '\(SharePanelCopy.copyAsMarkdown)'", in: file)
            XCTAssertEqual(SharePanelCopy.copyAsMarkdown, titleCased(SharePanelCopy.copyAsMarkdown))
            assertSays(web, "'\(SharePanelCopy.markdownCopied)'", in: file)
        }
        // Without a link open, the menu says so in the Access picker's own words.
        XCTAssertEqual(SharePanel.menuStatus(ShareLinkRead(link: nil)), SharePanelCopy.onlyYou)
    }

    // MARK: Copy as Markdown

    func testATasksMarkdownIsWrittenInThePanelsWords() throws {
        let web = try source(Self.taskPanel)
        for phrase in ["`# ${task.title}`", "`**Status:** ${status}`", "`**Outcome:** ${supersession}`",
                       "`**Link:** ${link}`", "'## Acceptance'",
                       "`Command: \\`${task.acceptanceCommand}\\` — done when it exits \\`${task.acceptanceExpectedExitCode}\\``",
                       "'## Dependencies'", "'No dependencies'",
                       "`- Needs: ${t.title} — ${taskOutcomeChip(t).label}`",
                       "`- Unblocks: ${t.title} — ${taskOutcomeChip(t).label}`",
                       "'## Runs'", "'No runs yet'", "`${runs.length} run${runs.length === 1 ? '' : 's'}`",
                       "`- ${sessionStatusMeta(s).label} · ${fmt(s.createdAt)}${s.workspace?.name ? ` · ${s.workspace.name}` : ''}`",
                       "`- …and ${runs.length - MARKDOWN_RUNS} earlier`",
                       "const MARKDOWN_RUNS = \(ShareMarkdown.listedRuns);",
                       "judged?.replace(' · ', ' ')", "month: 'short',"] {
            assertSays(web, phrase, in: Self.taskPanel)
        }
        let states: [(String, SessionRunState)] = [("RUNNING", .running), ("SUCCEEDED", .succeeded),
                                                   ("FAILED", .failed), ("AWAITING_INPUT", .awaitingInput),
                                                   ("INTERRUPTED", .interrupted), ("ENDED", .ended)]
        for (key, state) in states {
            assertSays(web, "\(key): { label: '\(ShareMarkdown.runLabel(state))'", in: Self.taskPanel)
        }
        assertSays(web, "QUEUED: { label: QUEUED_LABEL", in: Self.taskPanel)
        assertSays(try source(Self.runnerSlots), "export const QUEUED_LABEL = '\(ShareMarkdown.runLabel(.queued))';",
                   in: Self.runnerSlots)
        assertSays(try source(Self.taskPage), "export const ACCEPTANCE_EMPTY = '\(ShareMarkdown.acceptanceEmpty)';",
                   in: Self.taskPage)

        let outcome = try source(Self.outcome)
        for status in ["OPEN", "IN_PROGRESS", "DONE", "FAILED", "CANCELLED"] {
            assertSays(outcome, "\(status): { label: '\(ShareMarkdown.outcomeLabel(status: status))'", in: Self.outcome)
        }
        for reason in ["SUPERSEDED", "ABANDONED"] {
            let label = ShareMarkdown.outcomeLabel(status: "CANCELLED", terminalReason: reason)
            assertSays(outcome, "\(reason): { label: '\(label)'", in: Self.outcome)
        }
        for phrase in ["'Superseded — the task that replaced it has been deleted'", "'Superseded by a later attempt'",
                       "`Superseded by ${head.title}`",
                       "`Superseded — ${head.title} is the live attempt, ${chain.length} replacements on`",
                       "`Replaces ${replaced[0].title}`", "`Replaces ${replaced.length} earlier attempts`"] {
            assertSays(outcome, phrase, in: Self.outcome)
        }
    }

    func testAProjectsMarkdownIsWrittenInTheProjectPagesWords() throws {
        let web = try source(Self.projectControls)
        for status in [ProjectStatus.open, .done, .cancelled] {
            assertSays(web, "\(status.rawValue): '\(ShareMarkdown.projectStatusWord(status))'", in: Self.projectControls)
        }
        for (landing, words) in ShareMarkdown.landingWords {
            assertSays(web, "\(landing): '\(words)'", in: Self.projectControls)
        }
        for (key, word) in [("done", "done"), ("running", "running"), ("ready", "ready"), ("blocked", "waiting"),
                            ("awaitingVerification", "awaiting verification"), ("failed", "failed"),
                            ("cancelled", "cancelled")] {
            assertSays(web, "{ key: '\(key)', word: '\(word)' }", in: Self.projectControls)
        }
        for phrase in ["`${tasks} task${tasks === 1 ? '' : 's'}`", "`# ${project.title}`", "`**Status:** ${status}`",
                       "`**Link:** ${link}`", "'## Goal'", "'No goal set'", "'## Acceptance criteria'",
                       "'No criteria are stated for this project.'", "` — Met by its work",
                       "' — Not met by its work'", "`${criterion.ordinal}. ${criterion.text.trim()}${answer}`",
                       "'## Tasks'", "'No top-level tasks yet'",
                       "`- ${task.title} — ${taskStatusLabel(task.status, task.workState === 'RUNNING')}`"] {
            assertSays(web, phrase, in: Self.projectControls)
        }
        let pill = try source(Self.statusPill)
        for status in ["DONE", "IN_PROGRESS", "OPEN", "FAILED", "CANCELLED"] {
            let row = line(in: pill, containing: "  \(status): { cls: ") ?? ""
            assertSays(row, "label: '\(ShareMarkdown.taskStatusLabel(status, running: false))' }", in: Self.statusPill)
        }
        assertSays(pill, "if (running) return '\(ShareMarkdown.taskStatusLabel("OPEN", running: true))';", in: Self.statusPill)
    }
}
