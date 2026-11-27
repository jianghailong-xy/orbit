import Foundation
import XCTest
@testable import OrbitKit

/// The Drive chat's SwiftUI wiring (board docs/mocks/drive-chat/02-native), held on Linux, where OrbitApp does not
/// compile: OrbitApp's sources read as text, as `WikiChatWiringTests` reads the Wiki chat's. What it holds is where
/// each piece is hung and what it is handed — the rules are `DriveChatLogic`'s, tested beside this.
///
/// Every check is a failure, never an `XCTSkip`, when the file or the line it reads goes missing.
final class DriveChatWiringTests: XCTestCase {

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

    // MARK: one chat, the Wiki's, docked on Drive

    /// The Drive chat is the Wiki chat's model with another origin, not a copy: its own instance on the app model,
    /// read again when Drive changes, and streaming while its panel shows.
    func testTheDriveChatIsTheWikiChatsModelDockedOnDrive() throws {
        let model = code(try source("AppModel.swift"))
        XCTAssertTrue(model.contains("driveChat = WikiChatModel(baseURL: url, tokenStore: tokenStore, origin: .drive)"))
        let drive = try slice(model, from: "whenSeen(\"drive\") {", to: "case .wiki:")
        XCTAssertTrue(drive.contains("$0.driveChat?.nudge()"), "a Drive write reads the cards and the marks again")
        XCTAssertTrue(model.contains(": selectedSection == .drive ? driveChat?.focusedSessionID : nil)"),
                      "the panel's chat streams while it shows on Drive")
        let chat = code(try source("WikiChatModel.swift"))
        // Its words, its reads and its make go by origin.
        XCTAssertTrue(chat.contains("case .drive:\n            return Copy(history: DriveChatCopy.history"))
        XCTAssertTrue(chat.contains("if origin == .drive { return await loadDrive() }"))
        XCTAssertTrue(chat.contains("if origin == .drive { return await loadDriveCards(chat: sessionID) }"))
        assertOrder(chat, ["if origin == .drive {", "DriveChatLogic.createRequest(first, workspaceId: workspaceID, context: driveContext,",
                           "made = try await api.createDriveChat(request).sessionId"], "a new Drive chat is made by /drive/chats")
        XCTAssertTrue(chat.contains("origin == .drive ? DriveChatLogic.toOpen(chats) : WikiChatLogic.toOpen(chats)"))
    }

    // MARK: where the panel is (frames 1-4, 5-8)

    /// iPad at a regular width and the Mac: the third column, in place of the empty detail (iPad) or the inspector
    /// (Mac). iPhone and a compact iPad: the two-height sheet the round button opens.
    func testTheThirdColumnOnIPadAndMacAndASheetOnIPhone() throws {
        let main = code(try source("Views/MainView.swift"))
        let detail = try slice(main, from: "struct SectionDetail: View {", to: "case .scheduled:")
        XCTAssertTrue(detail.contains("case .drive:\n            DriveChatColumn()"))
        let shell = code(try source("Views/CompactShell.swift"))
        let drive = try slice(shell, from: "case .drive:", to: "case .scheduled:")
        XCTAssertTrue(drive.contains(".driveChatSheetHost()"), "the iPhone's Drive stack hosts the sheet")

        let views = code(try source("Views/DriveChatViews.swift"))
        let column = try slice(views, from: "struct DriveChatColumn: View {", to: "private func panel(")
        assertOrder(column, ["if shown && chat.presented {", "panel(chat)", "} else {", "base",
                             ".frame(maxWidth: .infinity, maxHeight: .infinity)", ".overlay(alignment: .bottomTrailing) {",
                             "if shown { DriveChatButton(chat: chat, compact: false) }",
                             ".driveChatLive(chat, sheet: false, shown: shown)"], "the column, or the button at its bottom right")
        let sheet = try slice(views, from: "private struct DriveChatSheetHost: ViewModifier {", to: "extension View {")
        assertOrder(sheet, [".overlay(alignment: .bottomTrailing) {", "if shown && !chat.presented { DriveChatButton(chat: chat, compact: true) }",
                            ".sheet(isPresented: Binding(get: { chat.presented }, set: { if !$0 { chat.close() } })) {",
                            "WikiChatPanel(chat: chat, scope: DriveChatLogic.scope, compact: true)",
                            ".presentationDetents([.medium, .large], selection: $detent)",
                            ".presentationBackgroundInteraction(.enabled(upThrough: .medium))",
                            ".driveChatLive(chat, sheet: true, shown: shown)"], "the iPhone's sheet")
    }

    /// Trash and Storage wear no chat and no button (frame 1 note 6), on every shell.
    func testTrashAndStorageHaveNoChat() throws {
        let views = code(try source("Views/DriveChatViews.swift"))
        XCTAssertTrue(views.contains("return DriveChatLogic.shown(drive.place)"), "the Mac's sidebar place")
        XCTAssertEqual(views.components(separatedBy: "case .driveTrash?, .driveStorage?: return false").count - 1, 2,
                       "the iPad's column and the iPhone's stack both leave Trash and Storage bare")
        XCTAssertTrue(DriveChatLogic.shown(.drive))
        XCTAssertFalse(DriveChatLogic.shown(.trash))
        XCTAssertFalse(DriveChatLogic.shown(.storage))
    }

    /// Open by default where it is a column, never as a sheet, and ✕ kept on this device per account until the
    /// button is pressed (frame 1 note 5).
    func testOpenByDefaultInAColumnAndXIsKeptPerAccount() throws {
        let views = code(try source("Views/DriveChatViews.swift"))
        let live = try slice(views, from: "private struct DriveChatLive: ViewModifier {", to: "private var choices:")
        assertOrder(live, ["chat.signedIn(app.user?.id)", "await chat.load(spaceID: DriveChatLogic.scope)",
                           "chat.openByDefault(spaceID: DriveChatLogic.scope, settingsOnTop: !shown)",
                           ".onChange(of: sheet, initial: true) { _, sheet in", "chat.asSheet = sheet"], "the default opening")
        let chat = code(try source("WikiChatModel.swift"))
        XCTAssertTrue(chat.contains("if origin == .drive { return account.map { UserDefaults.standard.bool(forKey: DriveChatLogic.closedKey(account: $0)) } ?? false }"))
        XCTAssertTrue(chat.contains("if hidden { UserDefaults.standard.set(true, forKey: DriveChatLogic.closedKey(account: account)) }"))
        XCTAssertNotEqual(DriveChatLogic.closedKey(account: "a"), DriveChatLogic.closedKey(account: "b"))
    }

    // MARK: what a message carries (frames 1, 3, 6)

    /// The folder open is the first chip and the file open (iPhone, iPad) or the Mac's selection the next; what they
    /// show is what the message carries beside the words, on a new chat and on every later message.
    func testTheChipsFollowTheFolderAndTheFilesAndGoBesideTheWords() throws {
        let views = code(try source("Views/DriveChatViews.swift"))
        let follow = try slice(views, from: "private func follow() {", to: "extension View {")
        assertOrder(follow, ["chat.follow(spaceID: DriveChatLogic.scope,",
                             "page: .folder(folderId: page.folderID, label: DriveChatCopy.folderLabel(page.folderName)))",
                             "chat.files(page.fileIDs.isEmpty ? nil : WikiChatLogic.Files(ids: page.fileIDs, names: page.fileNames))"],
                    "the chips")
        XCTAssertTrue(views.contains("let rows = drive.rows.filter { drive.selection.contains($0.id) }"), "the Mac's selection")
        XCTAssertTrue(views.contains("if case .driveFile(let id)? = app.nav.path.last, let entry = drive.known[id] {"),
                      "the file page open elsewhere")
        let console = code(try source("ConsoleModel.swift"))
        XCTAssertTrue(console.contains("let driveContext = driveContext ?? (fromComposer ? wikiChat?.driveContext() : nil)"))
        let panel = code(try source("Views/WikiChatViews.swift"))
        XCTAssertTrue(panel.contains("if let files = WikiChatLogic.shownFiles(chat.attachments) { filesChip(files) }"))
    }

    // MARK: the cards and the marks (frames 2, 3, 5, 7, 8)

    /// A chat's change groups and questions hang after their turn in the session page's own transcript, drawn by
    /// the Drive cards.
    func testTheCardsAreDrawnInTheConversationAfterTheirTurn() throws {
        let panel = code(try source("Views/WikiChatViews.swift"))
        XCTAssertTrue(panel.contains(".environment(\\.transcriptChatCards, chat.origin == .drive ? driveCards : nil)"))
        XCTAssertTrue(panel.contains("render: { id in AnyView(DriveChatCardSlot(chat: chat, id: id)) })"))
        let transcript = code(try source("Views/Console/ConsoleView.swift"))
        XCTAssertTrue(transcript.contains("chatCards: chatCards?.cards ?? [])"))
        XCTAssertTrue(transcript.contains("if let chatCards { chatCards.render(card.id).orbitCardWidth() }"))
        let views = code(try source("Views/DriveChatViews.swift"))
        let slot = try slice(views, from: "struct DriveChatCardSlot: View {", to: "private struct DriveCardFrame")
        assertOrder(slot, ["case .changes(let group)?:", "DriveChangesCard(chat: chat, group: group)",
                           "case .question(let question)?:", "DriveReplaceCard(chat: chat, question: question)"], "the slot")
        // Undo and Apply on a change card, Keep both above Replace on a phone's overwrite card.
        XCTAssertTrue(views.contains("Task { await chat.press(group, apply: true) }"))
        XCTAssertTrue(views.contains("Task { await chat.press(group, apply: false) }"))
        let replace = try slice(views, from: "struct DriveReplaceCard: View {", to: "private func file(")
        assertOrder(replace, ["Task { await chat.answer(question, .keepBoth) }", "Task { await chat.answer(question, .replace) }",
                              "if stacked {", "VStack(spacing: 8) { keep; replace }"], "the overwrite card")
    }

    /// What a chat made, moved in or renamed carries its mark after the name, on a light green row, until the row is
    /// opened — on the iPhone's and iPad's folder page and in the Mac's table.
    func testTheListsCarryTheMarksUntilOpened() throws {
        let phone = code(try source("Views/DrivePhoneViews.swift"))
        assertOrder(phone, ["let mark = app.driveChat?.mark(entry.id)", "mark: mark) {", ".listRowBackground(mark != nil ? Color.driveMarkedRow : nil)"],
                    "the folder page's rows")
        XCTAssertTrue(phone.contains("if let mark { DriveMarkPill(mark: mark) }"))
        XCTAssertTrue(phone.contains("app.driveChat?.opened(entry.id)"))
        let mac = code(try source("Views/DriveViews.swift"))
        XCTAssertTrue(mac.contains("if let mark = app.driveChat?.mark(entry.id) { DriveMarkPill(mark: mark) }"))
        XCTAssertEqual(mac.components(separatedBy: ".modifier(MarkedCell(marked: marked(entry)))").count - 1, 4,
                       "every column of a marked row is green")
        XCTAssertTrue(mac.contains("if selection.count == 1, let id = selection.first { app.driveChat?.opened(id) }"))
    }

    /// On a Mac, while the chat holds the third column, a file's details overlay the list's right side — 280 wide,
    /// closed by ✕ or Esc, never for several rows — and stand beside the chat at 1760 or wider (frame 3).
    func testMacDetailsOverlayTheListWhileTheChatIsOpen() throws {
        let mac = code(try source("Views/DriveViews.swift"))
        let overlay = try slice(mac, from: ".overlay(alignment: .trailing) {", to: ".onChange(of: model.selection)")
        assertOrder(overlay, ["if overlaysDetails {", "DriveInspector(model: model)", ".frame(width: 280)",
                              "Button { overlayClosedFor = model.selection }", ".keyboardShortcut(.cancelAction)", ".shadow("],
                    "the overlay")
        let rule = try slice(mac, from: "private var overlaysDetails: Bool {", to: "private var table: some View {")
        assertOrder(rule, ["chat.presented, !chat.asSheet, model.selection.count == 1",
                           "DriveChatLogic.detailsOverlay(chatOpen: true, windowWidth: Double(chat.windowWidth))"], "when it overlays")
        let views = code(try source("Views/DriveChatViews.swift"))
        assertOrder(views, ["if !DriveChatLogic.detailsOverlay(chatOpen: true, windowWidth: Double(chat.windowWidth)), drive.selection.count == 1 {",
                            "DriveDetailColumn().frame(width: 280)", "panel(chat)"], "four columns at 1760")
    }
}
