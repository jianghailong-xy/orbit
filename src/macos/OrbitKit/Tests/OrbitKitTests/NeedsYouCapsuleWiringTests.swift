import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the needs-you bar to the board the owner picked on 2026-10-21
/// (`docs/mocks/needs-you-capsule`, A): a glass capsule under the nav bar, not an amber band — the
/// amber in one 30pt circle whose mark says which kind is waiting, two lines (what, where) and how
/// long, no chevron when the press goes elsewhere, and on iOS 26 floating over the transcript as the
/// composer band does. Each check reads the slice of the file it is about.
final class NeedsYouCapsuleWiringTests: XCTestCase {
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

    private var banner: String {
        get throws { code(try source("Views/NeedsYouBannerView.swift")) }
    }

    /// The capsule is the nav bar's own glass on iOS 26, and the band it replaced is gone: no amber
    /// wash, no bar material behind the line, no dot.
    func testTheBarIsAGlassCapsuleNotABand() throws {
        let view = try banner
        let surface = try slice(view, from: "func needsYouCapsule()", to: "\n    }")
        XCTAssertTrue(surface.contains("glassEffect(.regular.interactive(), in: .capsule)"))
        XCTAssertTrue(view.contains(".frame(minHeight: 44)"), "the height of the nav bar's controls")
        XCTAssertFalse(view.contains("needsYouTint"), "the amber wash is gone")
        XCTAssertFalse(view.contains(".background(.bar)"), "and the band material with it")
        XCTAssertFalse(view.contains("Circle()\n                    .fill(.orange)"), "the 7pt dot is the circle now")
    }

    /// The amber is the Landing head's circle and nothing else — the words stay primary/secondary.
    func testTheAmberIsTheCircleAlone() throws {
        let view = try banner
        XCTAssertTrue(view.contains(".frame(width: 30, height: 30)"))
        XCTAssertTrue(view.contains(".background(Color.orange.opacity(0.15), in: Circle())"),
                      "`ProjectLandingRow.mark`'s own recipe")
        let lines = try slice(view, from: "VStack(alignment: .leading, spacing: 0) {", to: ".padding(.leading, 7)")
        XCTAssertFalse(lines.contains(".orange"), "never amber words")
    }

    /// One mark per kind, so the four read apart at a glance; the hand for a blocked tool call.
    func testEachKindHasItsOwnMark() throws {
        let symbols = try slice(try banner, from: "var symbol: String {", to: "\n    }")
        for (glyph, symbol) in [("merge", "arrow.triangle.merge"), ("question", "questionmark.bubble.fill"),
                                ("warning", "exclamationmark.triangle.fill"), ("pause", "pause.fill"),
                                ("hand", "hand.raised.fill")] {
            XCTAssertTrue(symbols.contains("case .\(glyph): return \"\(symbol)\""), "\(glyph) → \(symbol)")
        }
    }

    /// Two lines and the wait: the first line the banner's words, the second its `detail`, the age
    /// from its `since`, "+N" for the others behind it.
    func testTheBarSaysWhatWhereAndHowLong() throws {
        let view = try banner
        XCTAssertTrue(view.contains("bar(text: banner.text, detail: banner.detail, since: banner.since, more: banner.more,"))
        XCTAssertTrue(view.contains("if let since { NeedsYouAge(since: since) }"))
        XCTAssertTrue(view.contains("RelativeTime.elapsed(since, now: context.date)"),
                      "a duration still running, kept current")
        XCTAssertTrue(view.contains("Text(\"+\\(more)\")"))
    }

    /// Several waiting (the owner, 2026-11-13, option B of 03-expand.html; floating since 11-15,
    /// 04-floating.html): folded, a deck under the capsule says the press unfolds; unfolded, one
    /// capsule per conversation in `entries`' order, each opening its own, the first standing where
    /// the folded one stood with the ↑ that folds them, the rest hanging over the page on a scrim —
    /// the bar keeps the deck's room either way, so the page under it never moves.
    func testSeveralWaitingUnfoldIntoOneCapsuleEach() throws {
        let view = try banner
        XCTAssertTrue(view.contains("model.needsYouEntries(excluding: excluding)"))
        XCTAssertTrue(view.contains("let several = banner.count > 1 && !banner.arriving"))
        XCTAssertTrue(view.contains("if several { setUnfolded(true) } else { open(banner) }"))
        XCTAssertFalse(view.contains("Image(systemName: \"chevron.down\").imageScale(.small)"), "the ⌄ pill is the deck now")
        XCTAssertTrue(view.contains("chrome(deck: banner.count > 1) {"))
        XCTAssertTrue(view.contains("bar(entries[0], more: 0, fold: { setUnfolded(false) })"))
        let stack = try slice(view, from: ".overlay(alignment: .top) {\n                            VStack(spacing: 6) {",
                              to: "} scrim: {")
        XCTAssertTrue(stack.contains(".padding(.top, 44 + 6)"), "hung under the first, over the page")
        XCTAssertTrue(view.contains("chrome(deck: true) {"), "unfolded keeps the folded bar's height")
        XCTAssertTrue(view.contains(".onTapGesture { setUnfolded(false) }"), "the scrim folds them")
        XCTAssertTrue(view.contains(".padding(.bottom, deck ? Self.deckReach : 0)"))
        XCTAssertTrue(view.contains("Image(systemName: \"chevron.up\")"))
        XCTAssertTrue(view.contains("entries.prefix(NeedsYouLogic.unfoldedLimit)"), "at most five")
        let model = code(try source("AppModel.swift"))
        XCTAssertTrue(model.contains("NeedsYouLogic.entries(waiting: needsYouSessions, excluding: focused)"))
    }

    /// The bar's press goes elsewhere, so it carries no chevron — the whole of it is the press. What
    /// waits in the conversation on screen is said by the nav bar's capsule (07-console-one-capsule),
    /// which points the way its card lies.
    func testOnlyTheConversationsOwnCapsulePoints() throws {
        let view = try banner
        XCTAssertFalse(view.contains("chevron.down"), "no chevron on the bar")
        let console = code(try source("Views/Console/ConsoleView.swift"))
        let capsule = try slice(console, from: "private func waitingCapsule(_ here: WaitingBelow) -> some View {",
                                to: ".accessibilityHint(")
        XCTAssertTrue(capsule.contains(#"here.side == .above ? "chevron.up" : "chevron.down""#))
        XCTAssertTrue(capsule.contains("console.requestScroll(to: here.rowID)"))
    }

    /// A conversation carries no needs-you bar (07-console-one-capsule): what waits in it is the nav
    /// bar capsule's to say — while its card is out of sight — and what waits elsewhere the lists'.
    /// Over the session list and over a page the bar stands on nothing, lifted by a shadow.
    func testNoBarInAConversationAndItFloatsElsewhere() throws {
        let console = code(try source("Views/Console/ConsoleView.swift"))
        XCTAssertFalse(console.contains("NeedsYouBannerView("), "no bar in a conversation")
        let principal = try slice(console, from: "ToolbarItem(placement: .principal) {", to: "principalQuestion(proxy)")
        XCTAssertTrue(principal.contains("if !hidesStickyQuestion, let here = console.waitingBelow,"))
        XCTAssertTrue(principal.contains("here.side == .above || !atBottom || console.detached {"),
                      "said while its card is out of sight")
        let model = code(try source("ConsoleModel.swift"))
        XCTAssertTrue(model.contains("NeedsYouLogic.here(rows: rows, approvalIDs: state.pendingApprovals.map(\\.id),"),
                      "its own approvals too")
        let view = try banner
        XCTAssertTrue(view.contains(".background { surface }"))
        XCTAssertTrue(view.contains("if overList {\n            Color.clear"))
        XCTAssertFalse(view.contains("listSoftEdge"), "no band of its own under it")
        XCTAssertTrue(view.contains(".shadow(color: .black.opacity(scheme == .dark ? 0.75 : 0.10), radius: 14, y: 10)"))
    }

    /// An approval that has just arrived is said by this bar (the owner, 2026-11-15,
    /// 05-one-surface.html): its line, ringed amber, and a press that goes to it — and pages with
    /// no bar of their own get this same view over them from the shell.
    func testAnArrivalIsSaidHereAndPagesWithoutABarCarryIt() throws {
        let view = try banner
        XCTAssertTrue(view.contains("deck: banner.count > 1, arriving: banner.arriving) {"))
        XCTAssertTrue(view.contains("Capsule().strokeBorder(Color.orange.opacity(0.75), lineWidth: 1.5)"))
        let host = try slice(view, from: "private struct NeedsYouOverPage: ViewModifier {", to: "\n}\n")
        XCTAssertTrue(host.contains("model.pageHasNoNeedsYouBar(wide: wide)"))
        XCTAssertTrue(host.contains("NeedsYouBannerView(excluding: nil, overList: true)"))
        XCTAssertTrue(host.contains(".sensoryFeedback(.warning, trigger: model.needsYouArrival)"))
        XCTAssertTrue(code(try source("Views/CompactShell.swift")).contains(
            "CompactSections(openDrawer: openDrawer)\n                    .needsYouOverPage(wide: false)"))
        XCTAssertTrue(code(try source("Views/MainView.swift")).contains(".needsYouOverPage(wide: true)"))
        let model = code(try source("AppModel.swift"))
        let rule = try slice(model, from: "func pageHasNoNeedsYouBar(wide: Bool) -> Bool {", to: "\n    }")
        XCTAssertTrue(rule.contains("return !(nav.sectionAtRoot || nav.focusedConsoleSessionID != nil)"),
                      "a phone's Sessions list and conversation carry their own")
    }

    /// Over the Sessions list it floats as it does over a conversation (the owner, 2026-11-15,
    /// 06-list-floats.html): hung under the inset rather than in it, so the sticky section headers
    /// pass behind it; the list's first row keeps its height clear at rest; the pull's spinner still
    /// clears it.
    func testOverTheListItFloatsAndAFirstRowKeepsItClear() throws {
        let agents = code(try source("Views/AgentsView.swift"))
        let mount = try slice(agents, from: ".topInsetClearOfRefresh {", to: "#endif")
        let floating = try slice(mount, from: "} floating: {", to: "needsYouClearance = $0 }")
        XCTAssertTrue(floating.contains("NeedsYouBannerView(excluding: app.selectedAgentSessionID,"))
        XCTAssertFalse(try slice(mount, from: ".topInsetClearOfRefresh {", to: "} floating: {")
            .contains("NeedsYouBannerView"), "not in the inset")
        XCTAssertTrue(agents.contains("if needsYouClearance > 0 {\n                Color.clear\n                    .frame(height: needsYouClearance)"))
        let modifier = code(try source("Views/TopInsetClearOfRefresh.swift"))
        XCTAssertTrue(modifier.contains(".alignmentGuide(.bottom) { $0[.top] }"), "hung from the bands' lower edge")
        XCTAssertTrue(modifier.contains("bandsBottom: bands.maxY + floatingHeight"), "the spinner clears it")
    }

    /// Pushed up, it is put away until something new is waiting; the hamburger carries the count
    /// meanwhile, and a swipe tells the server nothing.
    func testASwipePutsItAwayAndTheHamburgerKeepsTheCount() throws {
        let view = try banner
        XCTAssertTrue(view.contains(".swipesAway { model.dismissNeedsYou() }"))
        let swipe = try slice(view, from: "private struct SwipeAway: ViewModifier {", to: "\n}\n")
        XCTAssertTrue(swipe.contains("value.translation.height < -22 || value.predictedEndTranslation.height < -60"))
        XCTAssertTrue(swipe.contains(".accessibilityAction(named: \"Dismiss\") { dismiss() }"))
        let model = code(try source("AppModel.swift"))
        let dismiss = try slice(model, from: "func dismissNeedsYou() {", to: "\n    }")
        XCTAssertTrue(dismiss.contains("needsYouDismissed = NeedsYouLogic.dismissalKeys(waiting: needsYouSessions)"))
        XCTAssertFalse(dismiss.contains("api") || dismiss.contains("Task {"), "nothing is sent")
        XCTAssertTrue(model.contains("NeedsYouLogic.isDismissed(waiting: needsYouSessions, excluding: focused, dismissed: needsYouDismissed)"))
        let arrival = try slice(model, from: "func noteNeedsYouArrival(", to: "\n    }\n")
        XCTAssertTrue(arrival.contains("needsYouDismissed = []"), "something new brings it back")
        let shell = code(try source("Views/CompactShell.swift"))
        let toggle = try slice(shell, from: "private struct DrawerToggleButton: View {", to: "\n}\n")
        XCTAssertTrue(toggle.contains("let waiting = model.needsYouPutAwayCount"))
        XCTAssertTrue(toggle.contains(".background(Color.orange, in: Capsule())"))
    }
}
