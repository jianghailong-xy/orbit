import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold every card that names a task to the one door out of a phone's conversation: the app's
/// Orbit-link opener, told `overConsole` by the console's environment. The owner's rule
/// (2026-11-12) is that a task opens over the page it was pressed on and Back returns there; a card
/// that calls SwiftUI's `openURL` itself reaches the app-level action instead, which routes the task
/// to the Tasks section and loses the page underneath.
///
/// Each check reads the slice of the file it is about, so a match somewhere else cannot pass it.
final class TaskEntryPointsWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this "
                + "check at its new home — don't delete the check."
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

    /// Every card in a conversation that names a task goes through the app's own link door with the
    /// console's `overConsole` answer — the same door prose already uses (`SelectableText`,
    /// `OrbitLinkCardView`). SwiftUI's `openURL` stays only as the fallback for a URL that door does
    /// not understand.
    func testEveryConversationCardOpensItsTaskThroughTheConsoleDoor() throws {
        let card = code(try source("Views/TaskStartCardView.swift"))
        XCTAssertTrue(card.contains("@Environment(\\.opensPagesOverConsole) private var overConsole"))
        XCTAssertTrue(card.contains("Button(TaskStartCard.openTask) { openTaskLink(url) }"))
        XCTAssertTrue(card.contains("if app?.openOrbitLink(url, overConsole: overConsole, overPage: opensTasksOverPage) != true { openURL(url) }"),
                      "the task-started card routes its task through the console's door")

        let message = code(try source("Views/SessionMessageCardView.swift"))
        XCTAssertTrue(message.contains("@Environment(\\.opensPagesOverConsole) private var overConsole"))
        XCTAssertTrue(message.contains("Button(SessionMessageCard.openTask) { openLink(url) }"),
                      "the session-message card's `Its task`")
        XCTAssertTrue(message.contains("if app?.openOrbitLink(url, overConsole: overConsole, overPage: opensTasksOverPage) != true { openURL(url) }"),
                      "…and its sender's title, through the same door")

        let item = code(try source("Views/OpenItemDeliveryCardView.swift"))
        XCTAssertTrue(item.contains("@Environment(\\.opensPagesOverConsole) private var overConsole"))
        XCTAssertTrue(item.contains("Button(OpenItemDeliveryCard.openTask) { openLink(url) }"))
        XCTAssertTrue(item.contains("if app?.openOrbitLink(url, overConsole: overConsole, overPage: opensTasksOverPage) != true { openURL(url) }"),
                      "the open-item delivery card's task, session and landing links")

        let delivery = code(try source("Views/CoordinatorDeliveryLineView.swift"))
        XCTAssertTrue(delivery.contains("@Environment(\\.opensPagesOverConsole) private var overConsole"))
        let itsTask = try slice(delivery, from: "Button(CoordinatorDeliveryCard.itsTask) {",
                                to: "}\n                        .buttonStyle")
        XCTAssertTrue(itsTask.contains("dismiss()"), "the sheet goes before the page under it is pushed")
        XCTAssertTrue(itsTask.contains("app?.openOrbitLink(url, overConsole: overConsole, overPage: opensTasksOverPage)"),
                      "the delivery line's `Its task` is pushed over the conversation, not routed")

        let referenced = code(try source("Views/Console/AttachedNoteView.swift"))
        XCTAssertTrue(referenced.contains("@Environment(\\.opensPagesOverConsole) private var overConsole"))
        XCTAssertTrue(referenced.contains("app?.openOrbitLink(url, overConsole: overConsole, overPage: opensTasksOverPage) != true"),
                      "a referenced task's card opens over the conversation it was named in")

        let wake = code(try source("Views/WatchWakeCardView.swift"))
        XCTAssertTrue(wake.contains("@Environment(\\.opensPagesOverConsole) private var overConsole"))
        // On a wide shell the same door opens a task over the page instead of pushing it
        // (owner decision 2026-11-12), so the answer carries both flags.
        XCTAssertTrue(wake.contains("model.openFromConversation(destination, overConsole: overConsole,"))
        XCTAssertTrue(wake.contains("overPage: opensTasksOverPage)"),
                      "a wake's target opens over the conversation/page, not in another section")
        XCTAssertTrue(wake.contains("case .task: return .task(PublicID.toPublic(target.id))"),
                      "the wake spells its target by the stored UUID; the page reads the public one")
    }

    /// A reference in prose is written as either spelling, and both open the task page: the route
    /// hands the page the public id the store and the page compare.
    func testAProseTaskReferenceLandsOnThePageInEitherSpelling() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var deepLink = ""
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitKit/Sources/OrbitKit/App/DeepLink.swift")
            if FileManager.default.fileExists(atPath: candidate.path) {
                deepLink = try String(contentsOf: candidate, encoding: .utf8)
                break
            }
            dir.deleteLastPathComponent()
        }
        XCTAssertFalse(deepLink.isEmpty, "OrbitKit/App/DeepLink.swift wasn't found above this test")
        let route = try slice(code(deepLink), from: "public static func route(_ url: URL) -> Route? {", to: "\n    }\n")
        XCTAssertTrue(route.contains("case \"task\":    return .task(PublicID.toPublic(ref.id))"),
                      "a task reference opens the page whatever the link spelled")
        XCTAssertTrue(route.contains("case \"session\": return .session(PublicID.toPublic(ref.id))"))
    }

    /// The two Wiki pages that can cite a task: an entry's source and a document's footnote. On the
    /// phone's stacks both push the task over the page that cited it; on the wide shells the same
    /// press opens the task over the page as the over-page panel (owner decision 2026-11-12).
    func testWikiEntrySourcesAndDocFootnotesPushOverThePageOnAPhone() throws {
        let entries = code(try source("Views/WikiScreens.swift"))
        XCTAssertTrue(entries.contains("var rowNavigation: SessionRowNavigation = .selection"),
                      "the entry page knows its shell's way of navigating")
        let entryActions = try slice(entries, from: "private func actions(_ wiki: WikiModel, _ detail: WikiEntryDetail)",
                                     to: "\n    }\n")
        XCTAssertTrue(entryActions.contains("if rowNavigation == .push { model.push(.taskDetail(taskID: PublicID.toPublic(id))) }"))
        XCTAssertTrue(entryActions.contains("else { model.open(.task(id: PublicID.toPublic(id)), overPage: opensTasksOverPage) }"),
                      "the wide shells open the task over the entry, not in another section")

        let docs = code(try source("Views/WikiDocScreens.swift"))
        XCTAssertTrue(docs.contains("var rowNavigation: SessionRowNavigation = .selection"),
                      "the document page knows its shell's way of navigating")
        let open = try slice(docs, from: "private func open(_ target: WikiDocLogic.OpenTarget)", to: "\n    }\n")
        XCTAssertTrue(open.contains("if rowNavigation == .push { model.push(.taskDetail(taskID: PublicID.toPublic(id))) }"))
        XCTAssertTrue(open.contains("else { model.open(.task(id: PublicID.toPublic(id)), overPage: opensTasksOverPage) }"),
                      "a phone pushes a footnote's task over the document; a wide shell opens it over the page")

        let shell = code(try source("Views/CompactShell.swift"))
        XCTAssertTrue(shell.contains("WikiEntryView(entryID: entryID, rowNavigation: .push)"),
                      "the phone's stacks are the ones that say push")
        XCTAssertTrue(shell.contains("WikiDocScreen(address: WikiDocAddress(slug: slug, section: section), rowNavigation: .push)"))
        let wikiStack = try slice(shell, from: "case .wiki:", to: "case .following:")
        XCTAssertTrue(wikiStack.contains("case .taskDetail(let taskID): TaskDetailPage(taskID: taskID)"),
                      "the Wiki stack renders the task page it is asked to push")
    }
}
