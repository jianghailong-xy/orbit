import Foundation
import XCTest
@testable import OrbitKit

/// The wiki chat's SwiftUI wiring (docs/wiki-chat-design.md §9, board 42 ⑤), held on Linux, where OrbitApp does not
/// compile: OrbitApp's sources read as text. What it holds is where each piece is hung and what it is handed — the
/// logic itself is `WikiChatLogic`'s, tested beside this.
///
/// Every check is a failure, never an `XCTSkip`, when the file or the line it reads goes missing.
final class WikiChatWiringTests: XCTestCase {

    private static let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String { "\(file) was not found above this test file." }
    }

    private func source(_ file: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.app + file)
            if FileManager.default.fileExists(atPath: candidate.path) { return try String(contentsOf: candidate, encoding: .utf8) }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: Self.app + file)
    }

    /// A source without its comment lines.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex), "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "\(what): lost \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    // MARK: the panel's place

    /// On a phone the panel is a sheet of two heights whose half height leaves the page readable and scrollable
    /// (design §9: `presentationBackgroundInteraction`, iOS 17); on an iPad or a Mac it is the third column beside
    /// the page (docs/wiki-design.md §12.3.5), 400 wide by default between 320 and 560 as the web's docked panel.
    func testThePanelIsATwoHeightSheetOnAPhoneAndTheThirdColumnElsewhere() throws {
        let views = code(try source("Views/WikiChatViews.swift"))
        let host = try slice(views, from: "struct WikiChatHost: ViewModifier {", to: "extension View {")
        let sheet = try slice(host, from: "if compact {", to: "} else {")
        assertOrder(sheet, [".sheet(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.close() } })) {",
                            ".presentationDetents([.medium, .large], selection: $detent)",
                            ".presentationBackgroundInteraction(.enabled(upThrough: .medium))",
                            ".presentationDragIndicator(.visible)"], "the phone's sheet")
        XCTAssertTrue(host.contains(".inspector(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.close() } })) {"))
        XCTAssertTrue(host.contains("panel.inspectorColumnWidth(min: 320, ideal: 400, max: 560)"))
        XCTAssertTrue(host.contains("return hSize == .compact"), "a sheet exactly where the width is compact")
        // The deployment target is iOS 17, where every one of these exists.
        let project = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("src/ios/project.yml"), encoding: .utf8)
        XCTAssertTrue(project.contains("deploymentTarget: \"17.0\""))
    }

    /// The panel is hung where every page of the Wiki section is: the iPhone's Wiki stack, and the wide shells' Wiki
    /// detail pane — so the third column stands beside whichever page the detail shows.
    func testThePanelIsHungOnTheWikiSectionInBothShells() throws {
        let compact = code(try source("Views/CompactShell.swift"))
        let stack = try slice(compact, from: "case .wiki:\n            NavigationStack(path: $model.nav.path) {", to: "case .runners:")
        assertOrder(stack, ["WikiHomeView(rowNavigation: .push)", "default:                      EmptyView()", ".wikiChatHost()"],
                    "the iPhone's Wiki stack")
        let main = code(try source("Views/MainView.swift"))
        let detail = try slice(main, from: "struct SectionDetail: View {", to: "struct ComingSoon: View {")
        XCTAssertTrue(detail.contains("case .wiki:\n            WikiDetailPane().wikiChatHost()"))
    }

    // MARK: the round button

    /// The button stands at the bottom right of every page of a space but its Settings, folded away while the
    /// panel shows (design §3): 56 across and 16 from the edges on a phone, 52 and 24 wider; it opens the chat that
    /// needs the owner, at its card. The line a rewrite floats stands at the bottom left beside it.
    func testTheButtonIsOnEveryPageButSettings() throws {
        let views = code(try source("Views/WikiChatViews.swift"))
        let host = try slice(views, from: "struct WikiChatHost: ViewModifier {", to: "extension View {")
        XCTAssertTrue(host.contains("WikiChatLogic.fabShown(settingsOnTop: model.nav.wikiSettingsOnTop, hasSpace: true)"))
        assertOrder(host, [".overlay(alignment: .bottomTrailing) {", "if shown && !chat.presented {",
                           "WikiChatFab(look: chat.fab(space.id),", "chat.openFromButton(spaceID: space.id)",
                           ".overlay(alignment: .bottomLeading) {", "if shown && !chat.presented, let card = chat.updatedCard {",
                           "WikiChatUpdatedPill(card: card, chat: chat, space: space)"], "the button and the line")
        XCTAssertTrue(host.contains("CGFloat(compact ? WikiChatLogic.Fab.phoneInset : WikiChatLogic.Fab.wideInset)"))
        XCTAssertTrue(host.contains("diameter: CGFloat(compact ? WikiChatLogic.Fab.phoneDiameter : WikiChatLogic.Fab.wideDiameter)"))
        let fab = try slice(views, from: "struct WikiChatFab: View {", to: "struct WikiChatHost: ViewModifier {")
        assertOrder(fab, ["Circle()", ".fill(Color.accentColor)", "if look.state == .working {", ".trim(from: 0, to: 0.3)",
                          "case .needsYou:", "Text(\"\\(look.count)\")", ".background(Color.orange, in: Capsule())",
                          "case .updated:", "Image(systemName: \"checkmark\")", ".background(Color.green, in: Circle())"],
                    "the button's four looks")
        XCTAssertTrue(fab.contains(".accessibilityLabel(look.label)"), "its words are the web's hover")
        // The document's foot keeps 88 clear for it.
        let screens = code(try source("Views/WikiDocScreens.swift"))
        XCTAssertTrue(screens.contains("footClearance: model.wikiChat == nil ? 0 : CGFloat(WikiChatLogic.Fab.footClearance)"))
    }

    // MARK: the conversation

    /// The conversation is the session page's own transcript (design §9), handed what its rows ask the page around
    /// them for — a missing observable object is a crash on screen, not a compile error.
    func testTheConversationIsTheSessionPagesTranscript() throws {
        let views = code(try source("Views/WikiChatViews.swift"))
        XCTAssertTrue(views.contains("init(wikiChat console: ConsoleModel) {\n        self.console = console\n        self.hidesStickyQuestion = true"))
        let conversation = try slice(views, from: "private struct WikiChatConversation: View {", to: "struct WikiChatComposer: View {")
        assertOrder(conversation, ["TranscriptView(wikiChat: console)", ".environment(registry.attachments)",
                                   ".environment(console.createdTasks)", ".environment(approvalReviewDrafts)",
                                   ".environment(\\.openApprovalReview, { target in approvalReview = target })",
                                   "ApprovalReviewSheet(console: console, target: target)"], "the transcript's surroundings")
        // Every observable object a transcript row reads is handed down.
        let console = code(try source("Views/Console/ConsoleView.swift"))
        let body = try slice(console, from: "} else if let console = registry.peek(sessionID) {", to: ".imagePreview(")
        for object in [".environment(registry.attachments)", ".environment(console.createdTasks)"] {
            XCTAssertTrue(body.contains(object), "the session page hands \(object) down; so must the panel")
        }
        // The panel's chat streams while it shows: the console focus falls back to it.
        let model = code(try source("AppModel.swift"))
        XCTAssertTrue(model.contains("let id = focusedConsoleSessionID ?? wikiChat?.focusedSessionID"))
        XCTAssertTrue(model.contains("wikiChat = WikiChatModel(baseURL: url, tokenStore: tokenStore)"))
        let arm = try slice(model, from: "case .wikiChanged:", to: "case .providerChanged:")
        XCTAssertTrue(arm.contains("wikiChat?.nudge()"), "a card made, replaced or pressed is read again")
        let chat = code(try source("WikiChatModel.swift"))
        XCTAssertTrue(chat.contains("presented && chat != WikiChatLogic.newChat ? chat : nil"))
        XCTAssertTrue(views.contains(".onChange(of: chat.focusedSessionID) { _, _ in model.syncConsoleFocus() }"))
    }

    /// The composer sends a running chat's message through its console — queued behind a running turn, the page and
    /// the quote beside the words — and lets the attachments go only once the server took it.
    func testTheComposerSendsTheAttachmentsBesideTheWords() throws {
        let views = code(try source("Views/WikiChatViews.swift"))
        let composer = try slice(views, from: "struct WikiChatComposer: View {", to: "private func pageChip(")
        XCTAssertTrue(composer.contains("await console.send(queueForNextTurn: true, wikiContext: context, accepted: { chat.sent() })"))
        XCTAssertTrue(composer.contains("if await chat.create(spaceID: space.id, text: words) { focused = false }"))
        let console = code(try source("ConsoleModel.swift"))
        let send = try slice(console, from: "func send(authoritative: RunStatus? = nil,", to: "} catch {")
        assertOrder(send, ["wikiContext: WikiChatContext? = nil, accepted onAccepted: (@MainActor () -> Void)? = nil) async {",
                           "queueForNextTurn: queueForNextTurn, wikiContext: wikiContext)",
                           "statusMessage = ComposerLogic.statusAfterAcceptedSend(statusMessage)", "onAccepted?()"],
                    "a chat's send")
        let post = try slice(console, from: "private func postTurn(", to: "private func retryingTransientFailures<T>(")
        XCTAssertTrue(post.contains("stopSessionId: confirmedStopSessionID,\n"))
        XCTAssertTrue(post.contains("wikiContext: wikiContext)\n        let turnRequest = ComposerLogic.makeTurn("))
        XCTAssertTrue(post.contains("queueForNextTurn: queueForNextTurn, wikiContext: wikiContext)"))
    }

    // MARK: Ask, the cards, Updated

    /// A paragraph's long press — a Mac's right click — offers Ask, which opens the Ask sheet in the panel over the
    /// paragraph's sentences (design §9, docs/wiki-comment-to-session-design.md §5); the sentences tapped go into the
    /// composer as the quote.
    func testAskIsOnAParagraphAndItsSentencesAreTapped() throws {
        let page = code(try source("Views/WikiDocView.swift"))
        let blocks = try slice(page, from: "private func blockView(", to: "private func askRequest(")
        XCTAssertEqual(blocks.components(separatedBy: ".modifier(WikiDocAsk(request: askRequest(block, section: section), ask: actions.ask))").count - 1,
                       2, "a paragraph and a list item each offer Ask")
        let ask = try slice(page, from: "private struct WikiDocAsk: ViewModifier {", to: "struct WikiDocCode: View {")
        assertOrder(ask, ["content.contextMenu {", "ask(request)", "Label(WikiChatCopy.ask, systemImage: \"ellipsis.bubble\")"],
                    "the paragraph's menu")
        let views = code(try source("Views/WikiChatViews.swift"))
        let sheet = try slice(views, from: "struct WikiChatAskSheet: View {", to: "struct WikiDraftCardSlot: View {")
        assertOrder(sheet, ["WikiChatLogic.quote(docSlug: request.docSlug, order: request.sentences, picked: picked)",
                            "Button(WikiChatCopy.ask) {", "if let quote { chat.quote(quote) }",
                            "Text(\"\\(request.place) · \\(WikiChatCopy.pickSentences)\")"], "the Ask sheet")
        let panel = try slice(views, from: "struct WikiChatPanel: View {", to: "private var title: String {")
        XCTAssertTrue(panel.contains("if let asking = chat.asking {\n                WikiChatAskSheet(request: asking, chat: chat)"),
                      "drawn in the panel, so a phone's one sheet stays the chat's")
    }

    /// A drafting call's card is drawn wherever the transcript shows the call — the panel, the session page — read
    /// off its answer (contract `chat.drafts.toolResult`), and its result fetched whole like `session_create`'s.
    func testACardIsDrawnFromTheDraftingCallsAnswer() throws {
        let cards = code(try source("Views/Console/ToolCards.swift"))
        XCTAssertTrue(cards.contains("return WikiChatLogic.draftID(toolName: card.name, result: result)"))
        XCTAssertTrue(cards.contains("card.name == \"mcp__orbit__session_create\" || WikiChatLogic.isDraftTool(card.name)"))
        let body = try slice(cards, from: "if let payload = sessionCreate {", to: "} else if showsHeader {")
        assertOrder(body, ["SessionCreateCardView(payload: payload)", "} else if let draft = wikiDraftID {", "WikiDraftCardSlot(draftID: draft)"],
                    "the card's place in a tool call's row")
        let views = code(try source("Views/WikiChatViews.swift"))
        let card = try slice(views, from: "struct WikiDraftCardView: View {", to: "struct WikiDraftEditForm: View {")
        // Its body: the state's line, what it is about, its fields, its buttons, then the line its rewrite reads.
        assertOrder(card, ["stateLine", "Text(WikiChatLogic.cardHeadline(card))", "fields", "buttons", "resultLine(rewrite)"],
                    "the card's parts, board 42 ⑤")
        assertOrder(card, ["Text(WikiChatLogic.cardTitle(card.state, label: card.label).uppercased())",
                           "WikiChatCopy.cardSources", "WikiChatCopy.cardRewrites",
                           "let presses: [WikiChatAction] = [.apply, .rewrite, .applyRebuild, .redo]",
                           ".buttonStyle(.borderedProminent)", "HStack(spacing: 8) {", ".buttonStyle(.bordered)\n",
                           "Text(WikiChatLogic.resultLine(rewrite.card))"], "the card's words and buttons, board 42 ⑤")
        XCTAssertTrue(card.contains("private var actions: [WikiChatAction] { WikiChatLogic.cardActions(card.card) }"))
        let slot = try slice(views, from: "struct WikiDraftCardSlot: View {", to: "struct WikiDraftCardView: View {")
        assertOrder(slot, ["case .apply, .rewrite, .applyRebuild:", "await chat.press(card, .apply)",
                           "case .discard:", "await chat.press(card, .discard)", "case .undo:", "await chat.press(card, .undo)",
                           "case .tryAgain:", "await chat.press(card, .retry)", "case .redo:",
                           "console.send(overrideText: WikiChatCopy.cardRedoMessage, queueForNextTurn: true)",
                           "case .seeChanges:"], "a card's presses")
    }

    /// A section written since the reader last looked wears Updated beside its title, its new sentences a green
    /// line (board 42 ⑤, third phone); See changes compares them sentence by sentence.
    func testUpdatedIsBesideTheSectionAndSeeChangesComparesItsSentences() throws {
        let page = code(try source("Views/WikiDocView.swift"))
        let heading = try slice(page, from: "private func sectionHeading(_ section: WikiDocSection) -> some View {", to: "private func blockView(")
        assertOrder(heading, ["Text(section.title)", "if WikiChatLogic.sectionUpdated(section.change, seen: seen) {",
                              "Text(WikiChatCopy.sectionUpdated)", "if section.stale == true {"], "a section's heading")
        XCTAssertTrue(page.contains("if added[section.key]?.contains(WikiDocPage.sentenceKey(sentence.text)) == true {"))
        let screens = code(try source("Views/WikiDocScreens.swift"))
        assertOrder(screens, ["let key = WikiChatLogic.seenKey(space: slug, doc: address.slug)",
                              "seen = stored > 0 ? stored : now", "UserDefaults.standard.set(now, forKey: key)"],
                    "the document's stamp: the look before this one, else this visit's start")
        let views = code(try source("Views/WikiChatViews.swift"))
        let changes = try slice(views, from: "struct WikiSeeChangesSheet: View {", to: "private func sentence(")
        assertOrder(changes, ["read?.versions.first { $0.id == target.versionID } ?? read?.versions.first",
                              "version.reason.map(WikiChatLogic.versionHeading)", "WikiChatLogic.changed(version.changed)",
                              "await chat.loadVersions(", "chat.markSeen(card)"], "See changes")
    }

    /// W's chat part is one amber line on Activity, after the proposals', opening the chat that holds the rewrite.
    func testActivityDrawsTheChatsLineOfW() throws {
        let activity = code(try source("Views/WikiActivityView.swift"))
        XCTAssertTrue(activity.contains(".environment(\\.wikiChatBanner, WikiChatLogic.waitingBanner(WikiSpaceLogic.chatWaiting(wiki.spaces)))"))
        let bands = try slice(activity, from: "case .reviewBanner, .planBanners, .otherPlanBanners:", to: "case .runs:")
        assertOrder(bands, ["WikiActivityBannerRow(banner: banner) { actions.openBanner(banner) }",
                            "if band == .reviewBanner, let chatBanner {",
                            "WikiActivityBannerRow(text: chatBanner, amber: true) { actions.openChat() }"], "Activity's banners")
        XCTAssertTrue(activity.contains("chat.openFromButton(spaceID: space.id)"))
    }
}
