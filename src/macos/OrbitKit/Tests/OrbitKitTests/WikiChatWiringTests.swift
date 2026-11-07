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
        // The chat as a column makes the Wiki directory, page and chat (design §9's third column): the source list
        // folds while it is open, so the page keeps its width, and comes back as it was — never saved as the reader's.
        let shell = try slice(main, from: "struct MainView: View {", to: "private var sidebar: some View {")
        assertOrder(shell, [".onChange(of: columnVisibility) { _, now in", "if now == .all { foldedForChat = false }",
                            "if !foldedForChat { sidebarVisible = (now == .all) }", ".onChange(of: wikiChatColumn) { _, open in",
                            "if open, columnVisibility == .all {\n                foldedForChat = true\n                columnVisibility = .doubleColumn",
                            "} else if !open, foldedForChat {\n                columnVisibility = .all",
                            "guard model.selectedSection == .wiki, let chat = model.wikiChat else { return false }",
                            "return chat.presented && !chat.asSheet"], "the source list beside the chat's column")
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
        // Every page's foot keeps 88 clear for it, the pages inset rather than the button moved.
        assertOrder(host, ["let clear = content.safeAreaInset(edge: .bottom, spacing: 0) {",
                           "Color.clear.frame(height: shown ? CGFloat(WikiChatLogic.Fab.footClearance) : 0)",
                           "return presented(clear, chat: chat, space: space)", ".overlay(alignment: .bottomTrailing) {"],
                    "the foot kept clear")
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
        XCTAssertTrue(model.contains("let id = focusedConsoleSessionID ?? (selectedSection == .wiki ? wikiChat?.focusedSessionID : nil)"))
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
    /// off its answer (contract `chat.drafts.toolResult`), a shell's `orbit wiki draft …` too, and its result fetched
    /// whole like `session_create`'s.
    func testACardIsDrawnFromTheDraftingCallsAnswer() throws {
        let cards = code(try source("Views/Console/ToolCards.swift"))
        XCTAssertTrue(cards.contains("return WikiChatLogic.draftID(toolName: card.name, command: card.input[\"command\"]?.stringValue, result: result)"))
        XCTAssertTrue(cards.contains("|| WikiChatLogic.isDraftingCall(card.name, command: card.input[\"command\"]?.stringValue)"))
        let body = try slice(cards, from: "if let payload = sessionCreate {", to: "} else if showsHeader {")
        assertOrder(body, ["SessionCreateCardView(payload: payload)", "} else if let draft = wikiDraftID {", "WikiDraftCardSlot(draftID: draft)"],
                    "the card's place in a tool call's row")
    }

    /// The card is the web's (`WikiDraftCard`, C9): its look and face are `WikiChatLogic.cardLook` and `cardFace` —
    /// the status line and its note, an In Review card's note opening Review, what it is about, while open the amend's
    /// lines, the rows, Sources, Rewrites and Similar — then a draft's own press full width over the rest, what a press
    /// that did not go said, and the line under an applied card with its own buttons.
    func testTheCardIsTheWebsCard() throws {
        let views = code(try source("Views/WikiChatViews.swift"))
        let card = try slice(views, from: "struct WikiDraftCardView: View {", to: "struct WikiDraftEditForm: View {")
        assertOrder(card, ["let look = WikiChatLogic.cardLook(card)", "let face = WikiChatLogic.cardFace(card)",
                           "stateLine(look)", "if let note = look.note {", "if look.inReview {", "Button(note) { open(.review) }",
                           "Text(note)", "if card.tainted {", "if let heading = face.heading {", "if isOpen {", "fields(face)",
                           "buttons(look)", "if let failed {", "if let result = WikiChatLogic.resultLook(card) {",
                           "resultLine(result, actions: look.rewriteActions)"], "the card's parts, board 42 ⑤")
        assertOrder(card, ["Text(look.title.uppercased())", "ForEach(Array(face.diff.enumerated()), id: \\.offset)",
                           "let similar = card.state == .draft ? Array(card.similar.prefix(3)) : []",
                           "ForEach(Array(face.rows.enumerated()), id: \\.offset)", "label(row.label)",
                           "Text(row.value)\n                            .fixedSize(horizontal: false, vertical: true)\n                            .frame(maxWidth: .infinity, alignment: .leading)",
                           "label(WikiChatCopy.cardSources)",
                           "label(WikiChatCopy.cardRewrites)", "WikiDraftCardTarget.section(doc: $0.doc, key: $0.key)",
                           "label(WikiChatCopy.similar)", "WikiDraftCardTarget.entry($0.id)",
                           "private func label(_ text: String) -> some View {\n        Text(text)\n            .foregroundStyle(.secondary)\n            .fixedSize()",
                           "let primary: WikiChatAction? = card.state == .draft ? look.actions.first : nil",
                           ".buttonStyle(.borderedProminent)", "HStack(spacing: 8) {", ".buttonStyle(.bordered)\n",
                           "Text(result.line)", "if action == .seeChanges {"], "the card's words and buttons, board 42 ⑤")
        let slot = try slice(views, from: "struct WikiDraftCardSlot: View {", to: "enum WikiDraftCardTarget: Equatable {")
        assertOrder(slot, ["failed: chat.pressFailed(card)", "} else if model.wikiChat?.isUnread(draftID) == true {",
                           "Text(WikiChatCopy.cardUnread)"], "the card, or why it cannot be drawn")
        assertOrder(slot, ["case .apply, .rewrite, .applyRebuild:", "await chat.press(card, .apply)",
                           "case .discard:", "await chat.press(card, .discard)", "case .undo:", "await chat.press(card, .undo)",
                           "case .tryAgain:", "await chat.press(card, .retry)", "case .redo:",
                           "console.send(overrideText: WikiChatCopy.cardRedoMessage, queueForNextTurn: true)",
                           "case .seeChanges:", "WikiChatSeeChanges.of(card, spaceID: space)",
                           "chat.seeChanges = target\n            chat.markSeen(card)"],
                    "a card's presses")
        assertOrder(slot, ["case .section(let doc, let key): leave { go(.wikiDoc(slug: doc, section: key)) }",
                           "case .entry(let id):             leave { go(.wikiEntry(entryID: id)) }",
                           "case .review:                    leave { go(.wikiReview) }"], "what a card's links open")
        // A press that did not go is said in its card, in the web's words — a plan card's change the plan's gate refused
        // with every error the gate found under the reason (C12).
        let model = code(try source("WikiChatModel.swift"))
        XCTAssertTrue(model.contains("if press != .seen { pressFailures[key] = WikiChatLogic.pressRefusal(error) }"))
        // A plan card opens its document on the plan page (C12), as the web's Open in Plan does.
        assertOrder(slot, ["case .openInPlan:",
                           "let node: NavNode = card.change.map { .wikiPlanDoc(slug: $0.doc.slug, version: nil) } ?? .wikiPlan(version: nil)",
                           "leave { go(node) }"], "Open in Plan")
        XCTAssertTrue(model.contains("return WikiChatLogic.pressError(error)"), "Edit's refusal")
        XCTAssertTrue(model.contains("guard WikiChatLogic.needsSeen(card) else { return }"))
        // Edit sends only what changed, under the web's words.
        let edit = try slice(views, from: "struct WikiDraftEditForm: View {", to: "struct WikiSeeChangesSheet: View {")
        assertOrder(edit, ["Text(WikiChatCopy.editNote)", "TextField(WikiChatCopy.editTitleField,", "TextField(WikiChatCopy.editLine,",
                           ".navigationTitle(WikiChatCopy.editTitle)", "Button(WikiChatCopy.cancel) { dismiss() }",
                           "Button(WikiChatCopy.actionApply) {", ".disabled(saving || edits.isEmpty || blank)"], "Edit")
        XCTAssertTrue(edit.contains("private var edits: [WikiChatEditRequest.Op] { WikiChatLogic.editOps(card, words: words) }"))
    }

    /// A plan page attaches its document, and at one of its sections that section too (C12), by the logic the web's
    /// page hook mirrors (`WikiChatLogic.planPage`).
    func testAPlanPageAttachesItsDocumentAndTheSectionItShows() throws {
        let views = code(try source("Views/WikiChatViews.swift"))
        let follow = try slice(views, from: "private func follow(_ node: NavNode?, chat: WikiChatModel, space: WikiSpace) {",
                               to: "private func presented<Page: View>(")
        assertOrder(follow, ["case .wikiPlanDoc(let slug, _)?:", "chat.follow(spaceID: space.id, page: .plan(docSlug: slug, label: number ?? slug))",
                             "case .wikiPlanSection(let slug, let index, _)?:",
                             "chat.follow(spaceID: space.id, page: WikiChatLogic.planPage(slug: slug, index: index, number: number, plan: model.wiki?.plan))"],
                    "the plan page's chip")
    }

    /// A section written since the reader last looked wears Updated beside its title, its new sentences a green
    /// line (board 42 ⑤, third phone), and Updated opens See changes, as the web's does; See changes is the web's.
    func testUpdatedIsBesideTheSectionAndSeeChangesComparesItsSentences() throws {
        let page = code(try source("Views/WikiDocView.swift"))
        let heading = try slice(page, from: "private func sectionHeading(_ section: WikiDocSection) -> some View {", to: "private func blockView(")
        assertOrder(heading, ["Text(section.title)", "if WikiChatLogic.sectionUpdated(section.change, seen: seen) {",
                              "if let seeChanges = actions.seeChanges { present { seeChanges(section) } }",
                              "Text(WikiChatCopy.sectionUpdated)", "if section.stale == true {"], "a section's heading")
        XCTAssertTrue(page.contains("if added[section.key]?.contains(WikiDocPage.sentenceKey(sentence.text)) == true {"))
        // The sections an open card would rewrite are marked before the press (board 42 ②).
        assertOrder(page, ["sectionHeading(section)", "if would.contains(WikiChatLogic.sectionID(doc: doc.slug, key: section.key)) {",
                           "Label(WikiChatCopy.cardWouldRewrite, systemImage: \"pencil.line\")"], "a section an open card would rewrite")
        let screens = code(try source("Views/WikiDocScreens.swift"))
        assertOrder(screens, ["let key = WikiChatLogic.seenKey(space: slug, doc: address.slug)",
                              "seen = stored > 0 ? stored : now", "UserDefaults.standard.set(now, forKey: key)"],
                    "the document's stamp: the look before this one, else this visit's start")
        XCTAssertTrue(screens.contains(".onDisappear { leaveSeen(wiki) }"), "leaving moves the stamp, as the web's page does")
        XCTAssertTrue(screens.contains("would: model.wikiChat?.wouldRewrite ?? [], underSheet: model.wikiChat?.asSheet ?? false)"))
        XCTAssertTrue(page.contains("let line = headingTops.page.map { $0.minY + $0.height * CGFloat(WikiChatLogic.readingLine(underSheet: underSheet)) } ?? 300"),
                      "the page chip's section is read off the line where the page shows it")
        XCTAssertTrue(screens.contains("docSlug: doc.slug, sectionKey: section.key, place: place, versionID: section.change?.versionId)], draftID: nil)"),
                      "Updated opens the write it names")
        let views = code(try source("Views/WikiChatViews.swift"))
        let changes = try slice(views, from: "private struct WikiSeeChangesSection: View {", to: "private func sentence(")
        assertOrder(changes, ["WikiChatLogic.seeChanges(", "case .same:", "nothing(WikiChatCopy.seeChangesSame)",
                              "case .failed:", "nothing(WikiChatCopy.seeChangesFailed)", "case .none:",
                              "nothing(WikiChatCopy.seeChangesNone)", "case .shown(let current, let earlier):",
                              "WikiChatCopy.earlierChanges(earlier.count)", "await chat.loadVersions(",
                              "Text(WikiChatLogic.seeChangesCause(version))", "let rows = WikiChatLogic.changedRows(version.rows)",
                              "Text(WikiChatCopy.seeChangesSame)"], "See changes")
        let sheet = try slice(views, from: "struct WikiSeeChangesSheet: View {", to: "private struct WikiSeeChangesSection: View {")
        assertOrder(sheet, ["WikiChatCopy.seeChangesTitle(target.sections[0].place)", "chat.markSeen(card)"], "See changes' sheet")
        let model = code(try source("WikiChatModel.swift"))
        XCTAssertTrue(model.contains("let sections = WikiChatLogic.seeChangesSections(rewrite).compactMap { section -> Section? in"))
    }

    /// A chat in Trash, or ended and not about to be retried, takes no more messages: the composer's place says so and
    /// offers a new chat (C8 review, the web's `WIKI_CHAT_ENDED` and `WIKI_CHAT_TRASHED`).
    func testAnEndedChatSaysSoInsteadOfTheComposer() throws {
        let views = code(try source("Views/WikiChatViews.swift"))
        let running = try slice(views, from: "private struct WikiChatRunningBody: View {", to: "private struct WikiChatEndedLine: View {")
        assertOrder(running, ["if let ended = endedLine(console) {", "WikiChatEndedLine(text: ended) { chat.newChat() }",
                              "WikiChatComposer(chat: chat, space: space, console: console)",
                              "WikiChatLogic.endedLine(trashed: trashed, status: session.effectiveRunStatus, retryPending: session.retryPending())"],
                    "the composer, or the line once the chat ended")
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
