import Foundation
import XCTest
@testable import OrbitKit

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell. These hold the Wiki's
/// wiring to the source instead: the drawer's Wiki row and its amber number, the section's stack on
/// every shell, the home page drawing `WikiLogic.HomeBand` in order, the entry page's inset-grouped
/// sections and its actions, Review's answers stacked through `ApprovalActions` with Accept on top,
/// the `wiki.changed` route, and the `orbit-wiki:` card. Each check reads the slice of the file it is
/// about, so a match somewhere else can't pass it.
final class WikiWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
                .appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil),
                       "\(what): missing \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    // MARK: the drawer

    /// The rail's work rows lead with Projects, Tasks and the Wiki, and the Wiki gets its own row.
    func testTheDrawerDrawsAWikiRowAfterTasks() throws {
        let shell = code(try source("Views/CompactShell.swift"))
        let rail = try slice(shell, from: "ForEach(AppSection.workSections) { section in", to: "workspacesHeader")
        XCTAssertTrue(rail.contains("} else if section == .wiki {\n                        wikiRow"),
                      "the Wiki's section is drawn by its own row")
        XCTAssertTrue(shell.contains(".task { await model.wiki?.loadSpaces() }"),
                      "the drawer reads the spaces that its number counts")
    }

    /// The amber number is written the way the Projects row writes its own — the same font, colour and
    /// guard — and counts what the web sidebar counts. It is said as "3 proposals to review".
    func testTheWikiRowsAmberNumberIsWrittenLikeTheProjectsRows() throws {
        let shell = code(try source("Views/CompactShell.swift"))
        let projects = try slice(shell, from: "private var projectsRow: some View {", to: ".drawerRow()")
        let wiki = try slice(shell, from: "private var wikiRow: some View {", to: ".drawerRow()")
        for shared in ["if waiting > 0 {", "Text(\"\\(waiting)\")", ".font(.orbitMeta.weight(.semibold))",
                       ".foregroundStyle(.orange)", "pill(selected: selected)", "HStack(spacing: 12)",
                       ".frame(width: 24)"] {
            XCTAssertTrue(projects.contains(shared), "the Projects row no longer writes \(shared)")
            XCTAssertTrue(wiki.contains(shared), "the Wiki row doesn't write \(shared) as the Projects row does")
        }
        XCTAssertTrue(wiki.contains("let waiting = model.wiki?.proposalsToReview ?? 0"))
        XCTAssertTrue(wiki.contains(".accessibilityLabel(WikiCopy.proposalsToReview(waiting))"))
        XCTAssertTrue(wiki.contains("Image(systemName: AppSection.wiki.systemImage)"))
        XCTAssertTrue(wiki.contains("Text(AppSection.wiki.title)"))
        // A press is the Projects row's own: the section, at its root, and the drawer closes.
        assertOrder(wiki, ["model.selectedSection = .wiki", "model.nav.popToRoot()", "close()"], "the row's press")
        let model = code(try source("WikiModel.swift"))
        XCTAssertTrue(model.contains("var proposalsToReview: Int { WikiLogic.proposalsToReview(spaces) }"))
    }

    // MARK: the section

    /// The phone's Wiki stack: the home, then an entry or Review — pushed, never presented beside it.
    func testThePhonesWikiStack() throws {
        let shell = code(try source("Views/CompactShell.swift"))
        let stack = try slice(shell, from: "case .wiki:\n            NavigationStack(path: $model.nav.path) {",
                              to: "default:                      EmptyView()")
        XCTAssertTrue(stack.contains("WikiHomeView(rowNavigation: .push)"))
        XCTAssertTrue(stack.contains(".drawerToggle(open: openDrawer)"))
        XCTAssertTrue(stack.contains("case .wikiEntry(let entryID): WikiEntryView(entryID: entryID)"))
        XCTAssertTrue(stack.contains("case .wikiReview:             WikiReviewView()"))
        // An `orbit-wiki:` link in a phone's conversation pushes the entry over it.
        let agents = try slice(shell, from: "case .console(let sessionID, _):", to: "default:                         EmptyView()")
        XCTAssertTrue(agents.contains("case .wikiEntry(let entryID):       WikiEntryView(entryID: entryID)"))
    }

    /// The three-column shells: the home in the list column, whichever page is on top in the detail.
    func testTheWideShellsRouteTheWiki() throws {
        let main = code(try source("Views/MainView.swift"))
        let content = try slice(main, from: "struct SectionContent: View {", to: "struct SectionDetail: View {")
        XCTAssertTrue(content.contains("case .wiki:\n            WikiHomeView()"))
        let detail = try slice(main, from: "struct SectionDetail: View {", to: "struct ComingSoon: View {")
        XCTAssertTrue(detail.contains("case .wiki:\n            WikiDetailPane()"))
        let pane = code(try slice(try source("Views/WikiScreens.swift"),
                                  from: "struct WikiDetailPane: View {", to: "// MARK: - one entry"))
        assertOrder(pane, ["model.selectedWikiEntryID", "WikiEntryView(entryID: id)", "model.nav.wikiReviewOnTop",
                           "WikiReviewView()"], "the detail pane")
        let app = code(try source("AppModel.swift"))
        let projection = try slice(app, from: "var selectedWikiEntryID: String? {", to: "var taskListsDirectoryPresented")
        XCTAssertTrue(projection.contains("get { nav.selectedWikiEntryID }"), "a read of the stack, not a copy")
        XCTAssertTrue(app.contains("case .wiki: return nav.sectionAtRoot"))
    }

    // MARK: the home page

    /// The home page draws `WikiLogic.HomeBand` in its own order — the search under the title, the
    /// banner, then the five bands — and the header carries the large title with the space beside it.
    func testTheHomePageDrawsTheBandsInOrder() throws {
        let page = code(try slice(try source("Views/WikiView.swift"),
                                  from: "struct WikiHomePage: View {", to: "private struct WikiRowLabel: View {"))
        XCTAssertTrue(page.contains("ForEach(WikiLogic.HomeBand.allCases, id: \\.self) { band in"))
        let bands = try slice(page, from: "private func band(_ band: WikiLogic.HomeBand) -> some View {",
                              to: "private var searchField: some View {")
        assertOrder(bands, ["case .search:", "case .reviewBanner:", "case .principles:", "case .topics:",
                            "case .recentDecisions:", "case .recentlyChanged:", "case .agentsUsed:"],
                    "the bands' arms")
        XCTAssertTrue(bands.contains("if content.proposals > 0 {\n                reviewBanner"),
                      "the banner shows only while something is waiting")
        let header = try slice(page, from: "private var header: some View {", to: "private var spacePicker: some View {")
        assertOrder(header, ["Text(WikiCopy.title)", ".font(.largeTitle.bold())", "spacePicker",
                             "Text(content.statusLine)"], "the header")
        let picker = try slice(page, from: "private var spacePicker: some View {",
                               to: "private func band(_ band: WikiLogic.HomeBand) -> some View {")
        XCTAssertTrue(picker.contains("Image(systemName: \"chevron.up.chevron.down\")"))
        XCTAssertTrue(picker.contains("ForEach(content.spaces) { space in"))
        XCTAssertTrue(page.contains("TextField(WikiCopy.searchPlaceholder, text: $query)"))
        let banner = try slice(page, from: "private var reviewBanner: some View {", to: "private func bandHeader(")
        XCTAssertTrue(banner.contains("Button(action: actions.openReview)"))
        XCTAssertTrue(banner.contains("Text(WikiCopy.proposalsToReview(content.proposals))"))
        XCTAssertTrue(banner.contains("Circle().fill(.orange).frame(width: 7, height: 7)"),
                      "the needs-you bar's own amber dot")
    }

    // MARK: one entry

    /// Inset-grouped, the sections in `WikiLogic.EntrySection` order, and Edit beside a ⋯ menu that
    /// holds Supersede…, Retire… (destructive), then Copy link.
    func testTheEntryPage() throws {
        let view = code(try source("Views/WikiView.swift"))
        let page = code(try slice(try source("Views/WikiView.swift"),
                                  from: "struct WikiEntryPage: View {", to: "// MARK: - Review"))
        XCTAssertTrue(page.contains("ForEach(WikiLogic.EntrySection.allCases, id: \\.self) { section in"))
        XCTAssertTrue(page.contains(".wikiEntryListStyle()"))
        XCTAssertTrue(view.contains("self.listStyle(.insetGrouped)"), "grouped cards on iOS")
        let toolbar = try slice(page, from: ".toolbar {", to: "private var head: some View {")
        assertOrder(toolbar, ["Button(WikiCopy.edit, action: actions.edit)", "Menu {",
                              "Label(WikiCopy.supersede, systemImage:",
                              "Button(role: .destructive, action: actions.retire)",
                              "Label(WikiCopy.retire, systemImage:", "Divider()",
                              "Label(WikiCopy.copyLink, systemImage:", "Image(systemName: \"ellipsis\")"],
                    "the entry's actions")
        let sections = try slice(page, from: "private func section(_ section: WikiLogic.EntrySection) -> some View {",
                                 to: "private func countedHeader")
        assertOrder(sections, ["case .details:", "case .sources:", "case .anchors:", "case .whereUsed:", "case .history:"],
                    "the sections' arms")
        XCTAssertTrue(sections.contains("Text(WikiCopy.anchorsNote)"), "the anchors' footnote")
        // The forms those actions open write through the model, one owner write each.
        let screens = code(try source("Views/WikiScreens.swift"))
        for write in ["await wiki.edit(detail.entry, title: title, summary: summary)",
                      "await wiki.supersede(detail.entry, title: title, summary: summary)",
                      "await wiki.retire(entry, reason: why)"] {
            XCTAssertTrue(screens.contains(write), "the entry page no longer writes \(write)")
        }
    }

    // MARK: Review

    /// One card at a time with its position, and the card's answers through the approval cards' own
    /// stack — `VStack(spacing: 10)` on iOS — Accept first, then Edit, then Reject▾; Retire then Keep.
    func testReviewAnswersThroughApprovalActionsAcceptFirst() throws {
        let approvals = code(try source("Views/ApprovalCards.swift"))
        let stack = try slice(approvals, from: "struct ApprovalActions<Content: View>: View {", to: "#endif")
        XCTAssertTrue(stack.contains("#if os(iOS)\n        VStack(spacing: 10) { content() }"),
                      "ApprovalActions stacks full width on iOS")
        let view = code(try source("Views/WikiView.swift"))
        let card = code(try slice(try source("Views/WikiView.swift"),
                                  from: "struct WikiReviewCard: View {", to: "/// The op's chip and the kind"))
        let answers = try slice(card, from: "ApprovalActions {", to: ".disabled(busy)")
        assertOrder(answers, ["Text(WikiCopy.reviewRetire)", "Text(WikiCopy.keep)", "Text(WikiCopy.accept)",
                              "Text(WikiCopy.reviewEdit)", "Text(WikiCopy.reject)"], "a card's answers")
        XCTAssertTrue(answers.contains("actions.decide(card, .reject, .notTrue)"), "Keep is a rejection as Not true")
        XCTAssertTrue(answers.contains("Section(WikiCopy.rejectReasonFoot)"))
        XCTAssertTrue(answers.contains("ForEach(WikiRejectReason.allCases, id: \\.self)"))
        XCTAssertEqual(answers.components(separatedBy: ".approvalActionLabel()").count - 1, 5,
                       "every answer spans the card, as the approval cards' do")
        let accept = try slice(answers, from: "Text(WikiCopy.accept)", to: "Text(WikiCopy.reviewEdit)")
        XCTAssertTrue(accept.contains(".buttonStyle(.borderedProminent)"), "Accept is the one filled answer")
        let page = try slice(view, from: "struct WikiReviewPage: View {", to: "struct WikiReviewCard: View {")
        XCTAssertTrue(page.contains("Text(WikiCopy.ofCount(at + 1, count))"), "1 of N")
        XCTAssertTrue(page.contains(".pickerStyle(.segmented)"))
        XCTAssertTrue(page.contains("WikiLogic.clampedIndex(index, count: visible.count)"))
        let screens = code(try source("Views/WikiScreens.swift"))
        XCTAssertTrue(screens.contains("await wiki.decide(card, action, reason: reason)"))
    }

    // MARK: the event, and the card

    /// `wiki.changed` re-reads the Wiki and nothing else: it has its own arm ahead of the default one
    /// that snapshots the sessions, and the reconnect re-reads the Wiki too.
    func testWikiChangedReReadsTheWikiNotTheSessions() throws {
        let app = code(try source("AppModel.swift"))
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "private func mergeSessionSummary")
        let arm = try slice(apply, from: "case .wikiChanged:", to: "case .providerChanged:")
        XCTAssertTrue(arm.contains("wiki?.nudge()"))
        XCTAssertFalse(arm.contains("scheduleControlRefresh"), "a wiki event is not a session event")
        let wikiArm = try XCTUnwrap(apply.range(of: "case .wikiChanged:"))
        let defaultArm = try XCTUnwrap(apply.range(of: "default:\n            scheduleControlRefresh()"))
        XCTAssertLessThan(wikiArm.lowerBound, defaultArm.lowerBound)
        let connected = try slice(app, from: "case .connected:", to: "case .event(let ev):")
        XCTAssertTrue(connected.contains("if let wiki { Task { await wiki.reloadLoaded() } }"))
        XCTAssertTrue(app.contains("wiki = WikiModel(baseURL: url, tokenStore: tokenStore)"))
    }

    /// An `orbit-wiki:` card wears the Wiki's book, names the entry's kind beside the type, badges its
    /// trust and marks its anchor; the one door opens the entry's page.
    func testTheWikiLinkCard() throws {
        let view = code(try source("Views/OrbitLinkCardView.swift"))
        XCTAssertTrue(view.contains("case .wiki:    return AppSection.wiki.systemImage"))
        XCTAssertTrue(view.contains("Text(content.typeName)"))
        XCTAssertTrue(view.contains("WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))"))
        XCTAssertTrue(view.contains("if let mark = line.anchorMark {"))
        let cards = code(try source("OrbitLinkCards.swift"))
        XCTAssertTrue(cards.contains("case .wikiEntry(let id): openWikiEntry(id, overConsole: overConsole)"))
        XCTAssertTrue(cards.contains("wikiSpaceSlug: readings[ref.target.key]?.preview.wiki?.spaceSlug"),
                      "Copy link on a wiki card is the entry's page, which takes its space")
        let app = code(try source("AppModel.swift"))
        let open = try slice(app, from: "func openWikiEntry(_ id: String, overConsole: Bool = false) {", to: "\n    }")
        assertOrder(open, ["if overConsole {", "push(.wikiEntry(entryID: id))", "selectedSection = .wiki",
                           "nav.path = [.wikiEntry(entryID: id)]"], "where a wiki link opens")
    }
}
