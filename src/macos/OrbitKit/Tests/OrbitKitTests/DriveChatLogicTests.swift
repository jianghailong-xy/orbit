import Foundation
import XCTest
@testable import OrbitKit

/// The Drive chat's reads, writes and rules on iOS and macOS (board docs/mocks/drive-chat/02-native; the web's
/// driveChat.ts and driveChanges.ts, which these hold the Swift side to).
final class DriveChatLogicTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func encoded<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: the reads decode as the server writes them

    func testChatsListDecodesTheServersAnswer() throws {
        let list = try decode(DriveChatList.self, """
        {"workspace":{"id":"ws1","name":"Orbit Cloud","runner":"cloud-1","online":true},"workspaceFrom":"ORBIT_CLOUD",
         "fab":{"needsYou":1,"working":true},
         "chats":[{"sessionId":"s1","title":"Sort October receipts","status":"RUNNING","open":true,"completed":false,
                   "working":true,"needsYou":1,"workspaceId":"ws1","createdAt":"2026-11-26T10:00:00.000Z",
                   "updatedAt":"2026-11-26T10:05:00.000Z","lastActiveAt":"2026-11-26T10:05:00.000Z"}],
         "more":false}
        """)
        XCTAssertEqual(list.workspace?.name, "Orbit Cloud")
        XCTAssertEqual(list.workspaceFrom, "ORBIT_CLOUD")
        XCTAssertEqual(list.fab, DriveChatList.Fab(needsYou: 1, working: true))
        XCTAssertEqual(list.chats.first?.title, "Sort October receipts")
        XCTAssertEqual(list.chats.first?.needsYou, 1)
        // An older or a bare answer reads as empty, never as an error.
        let bare = try decode(DriveChatList.self, "{}")
        XCTAssertNil(bare.workspace)
        XCTAssertEqual(bare.chats, [])
        XCTAssertFalse(bare.more)
    }

    func testGroupsAndQuestionsDecode() throws {
        let groups = try decode(DriveChatGroups.self, """
        {"groups":[{"id":"g1","sessionId":"s1","turnId":"t1","status":"DONE","held":false,"createdAt":"2026-11-26T10:05:00.000Z",
          "appliedAt":null,"undoneAt":null,"counts":{"NEW_FOLDER":2,"MOVE":1},"total":3,"skipped":0,
          "items":[{"id":"i1","kind":"NEW_FOLDER","entryId":"e1","entryKind":"FOLDER",
                    "before":{"parentId":null,"parentPath":null,"name":null},
                    "after":{"parentId":"p","parentPath":"/Receipts 2026","name":"2026-10"},"state":"DONE","reason":null}],
          "heldItems":[]}]}
        """).groups
        XCTAssertEqual(groups.first?.status, .done)
        XCTAssertEqual(groups.first?.items.first?.after.name, "2026-10")
        let questions = try decode(DriveChatQuestions.self, """
        {"questions":[{"id":"q1","sessionId":"s1","turnId":"t2","status":"OPEN","choice":null,
          "moving":{"entryId":"a","path":"/Scans/lease-2026.pdf","sizeBytes":2411724,"modifiedAt":"2026-09-30T09:00:00.000Z",
                    "lastWriter":{"kind":"OWNER","sessionId":null,"sessionTitle":null}},
          "existing":{"entryId":"b","path":"/Documents/Home/lease-2026.pdf","sizeBytes":419840,"modifiedAt":"2026-01-04T09:00:00.000Z",
                    "lastWriter":{"kind":"OWNER","sessionId":null,"sessionTitle":null}},
          "destination":{"parentId":"h","name":"lease-2026.pdf"},"outcome":null,"reason":null,
          "createdAt":"2026-11-26T10:06:00.000Z","answeredAt":null}]}
        """).questions
        XCTAssertEqual(questions.first?.status, .open)
        XCTAssertEqual(questions.first?.existing.path, "/Documents/Home/lease-2026.pdf")
        XCTAssertTrue(DriveChatLogic.needsYou(try XCTUnwrap(questions.first)))
    }

    // MARK: what goes to the server

    func testCreateSendsTheFolderShownOrNoFolder() throws {
        let first = WikiChatLogic.FirstMessage(words: "  Sort these  ", attachmentIds: ["f1"], model: "opus",
                                               permissionMode: "default", effort: "", fastMode: false)
        let inFolder = try XCTUnwrap(DriveChatLogic.createRequest(
            first, workspaceId: "ws1", context: DriveChatContext(folderId: "scans", entryIds: ["a", "b"]), clientTurnId: "c1"))
        let body = try encoded(inFolder)
        XCTAssertEqual(body["text"] as? String, "Sort these")
        XCTAssertEqual(body["clientTurnId"] as? String, "c1")
        XCTAssertEqual(body["workspaceId"] as? String, "ws1")
        XCTAssertEqual(body["folderId"] as? String, "scans")
        XCTAssertEqual(body["entryIds"] as? [String], ["a", "b"])
        XCTAssertEqual(body["attachmentIds"] as? [String], ["f1"])
        XCTAssertNil(body["noFolder"])
        XCTAssertNil(body["fastMode"])

        // The top level: folderId null, said rather than left out.
        let top = try encoded(try XCTUnwrap(DriveChatLogic.createRequest(
            first, workspaceId: nil, context: DriveChatContext(folderId: nil), clientTurnId: "c2")))
        XCTAssertTrue(top.keys.contains("folderId"))
        XCTAssertTrue(top["folderId"] is NSNull)
        XCTAssertNil(top["entryIds"])
        XCTAssertNil(top["workspaceId"])

        // The chip crossed out: noFolder, and neither folderId nor entryIds (the server refuses them together).
        let none = try encoded(try XCTUnwrap(DriveChatLogic.createRequest(first, workspaceId: nil, context: nil, clientTurnId: "c3")))
        XCTAssertEqual(none["noFolder"] as? Bool, true)
        XCTAssertNil(none["folderId"])
        XCTAssertNil(none["entryIds"])

        // No words, no chat.
        XCTAssertNil(DriveChatLogic.createRequest(WikiChatLogic.FirstMessage(words: "  "), workspaceId: nil, context: nil,
                                                  clientTurnId: "c4"))
    }

    func testATurnCarriesItsDriveContextBesideTheWords() throws {
        let turn = ComposerLogic.makeTurn(clientTurnId: "c", text: "and these", shell: false, attachmentIds: [],
                                          driveContext: DriveChatContext(folderId: nil, entryIds: ["x"]))
        let body = try encoded(turn)
        let context = try XCTUnwrap(body["driveContext"] as? [String: Any])
        XCTAssertTrue(context["folderId"] is NSNull)
        XCTAssertEqual(context["entryIds"] as? [String], ["x"])
        XCTAssertNil(body["wikiContext"])
        // Any other session's turn leaves the field out.
        let plain = try encoded(ComposerLogic.makeTurn(clientTurnId: "c", text: "hi", shell: false, attachmentIds: []))
        XCTAssertNil(plain["driveContext"])
        let resume = try encoded(ResumeRequest(clientTurnId: "c", content: "hi", driveContext: DriveChatContext(folderId: "f")))
        XCTAssertEqual((resume["driveContext"] as? [String: Any])?["folderId"] as? String, "f")
    }

    // MARK: the composer's chips

    func testFolderAndFilesFollowThePageAndWhatIsShownIsSent() {
        var state = WikiChatLogic.Attachments()
        state = WikiChatLogic.attach(state, .follow(.folder(folderId: "scans", label: DriveChatCopy.folderLabel("Scans"))))
        XCTAssertEqual(state.page?.label, "Folder · Scans")
        XCTAssertEqual(DriveChatLogic.context(state), DriveChatContext(folderId: "scans"))

        state = WikiChatLogic.attach(state, .files(WikiChatLogic.Files(ids: ["l"], names: ["lease-2026.pdf"])))
        XCTAssertEqual(DriveChatLogic.context(state), DriveChatContext(folderId: "scans", entryIds: ["l"]))

        // Crossed out, not sent; a new selection shows again.
        state = WikiChatLogic.attach(state, .crossFiles)
        XCTAssertNil(WikiChatLogic.shownFiles(state))
        XCTAssertEqual(DriveChatLogic.context(state), DriveChatContext(folderId: "scans"))
        state = WikiChatLogic.attach(state, .files(WikiChatLogic.Files(ids: ["a", "b"], names: ["a", "b"])))
        XCTAssertEqual(WikiChatLogic.shownFiles(state)?.ids, ["a", "b"])

        state = WikiChatLogic.attach(state, .crossPage)
        XCTAssertEqual(DriveChatLogic.context(state), DriveChatContext(folderId: nil, entryIds: ["a", "b"]))
        state = WikiChatLogic.attach(state, .crossFiles)
        XCTAssertNil(DriveChatLogic.context(state), "nothing shown: a new chat sends noFolder")

        // Sent: the next message starts with the folder and the files again.
        state = WikiChatLogic.attach(state, .sent)
        XCTAssertEqual(DriveChatLogic.context(state), DriveChatContext(folderId: "scans", entryIds: ["a", "b"]))
        // The top level is a folder too, named Drive.
        state = WikiChatLogic.attach(WikiChatLogic.Attachments(), .follow(.folder(folderId: nil, label: DriveChatCopy.folderLabel("Drive"))))
        XCTAssertEqual(DriveChatLogic.context(state), DriveChatContext(folderId: nil))
        // A folder is no Wiki page.
        XCTAssertNil(WikiChatLogic.context(state))
        XCTAssertEqual(DriveChatCopy.selection(["lease-2026.pdf"]), "lease-2026.pdf")
        XCTAssertEqual(DriveChatCopy.selection(Array(repeating: "x", count: 12)), "12 files")
    }

    // MARK: the chats read

    func testHostListAndWhichChatOpens() {
        let list = DriveChatList(
            workspace: DriveChatWorkspace(id: "cloud", name: "Orbit Cloud", runner: nil, online: true),
            fab: DriveChatList.Fab(needsYou: 2, working: true),
            chats: [DriveChatRow(sessionId: "done", completed: true),
                    DriveChatRow(sessionId: "recent"),
                    DriveChatRow(sessionId: "waits", needsYou: 1)])
        let host = DriveChatLogic.hostList(list, choices: [WikiChatWorkspace(id: "mac", name: "Mac mini")])
        XCTAssertEqual(host.spaceId, DriveChatLogic.scope)
        XCTAssertEqual(host.choices.map(\.id), ["cloud", "mac"], "the default first among the owner's workspaces")
        XCTAssertEqual(host.fab, WikiChatFabCounts(needsYou: 2, working: true, updated: 0))
        guard case .chosen(let workspace, _, _) = WikiChatLogic.runsIn(host, picked: nil) else {
            return XCTFail("Runs in names the server's default")
        }
        XCTAssertEqual(workspace.name, "Orbit Cloud")
        guard case .chosen(let picked, _, _) = WikiChatLogic.runsIn(host, picked: "mac") else { return XCTFail("a pick") }
        XCTAssertEqual(picked.id, "mac")

        XCTAssertEqual(DriveChatLogic.toOpen(host.chats), "waits")
        XCTAssertEqual(DriveChatLogic.toOpen([DriveChatLogic.hostRow(DriveChatRow(sessionId: "done", completed: true))]),
                       WikiChatLogic.newChat, "a completed chat is not continued")
        XCTAssertEqual(DriveChatLogic.toOpen(nil), WikiChatLogic.newChat)

        // No default and no workspaces: nothing to run in.
        XCTAssertEqual(WikiChatLogic.runsIn(DriveChatLogic.hostList(DriveChatList()), picked: nil), .noWorktree)
    }

    func testTheRoundButtonReadsTheDrivesCheck() {
        XCTAssertEqual(DriveChatLogic.fab(WikiChatFabCounts(updated: 1)).label, "Drive updated")
        XCTAssertEqual(DriveChatLogic.fab(WikiChatFabCounts(updated: 1)).state, .updated)
        XCTAssertEqual(DriveChatLogic.fab(WikiChatFabCounts(needsYou: 1)).label, "1 needs you")
        XCTAssertEqual(DriveChatLogic.fab(WikiChatFabCounts(working: true)).label, "Working…")
        XCTAssertEqual(DriveChatLogic.fab(nil).label, "Chat")
        XCTAssertTrue(DriveChatLogic.shown(.drive))
        XCTAssertFalse(DriveChatLogic.shown(.trash))
        XCTAssertFalse(DriveChatLogic.shown(.storage))
    }

    // MARK: the cards

    private func group(_ status: DriveChatChangeGroup.Status, items: Int = 24, skipped: Int = 0,
                       at: String = "2026-11-26T10:05:00.000Z", turn: String = "t1") -> DriveChatChangeGroup {
        let made: [DriveChatChangeItem] = [
            DriveChatChangeItem(id: "1", kind: "NEW_FOLDER", entryId: "e1", entryKind: "FOLDER",
                                after: DriveChatPlace(parentPath: "/Receipts 2026", name: "2026-10")),
            DriveChatChangeItem(id: "2", kind: "NEW_FOLDER", entryId: "e2", entryKind: "FOLDER",
                                after: DriveChatPlace(parentPath: "/Receipts 2026", name: "2026-11")),
            DriveChatChangeItem(id: "3", kind: "MOVE", entryId: "e3",
                                before: DriveChatPlace(parentPath: "/Scans", name: "2026-10-03 Blue Bottle.pdf"),
                                after: DriveChatPlace(parentPath: "/Receipts 2026/2026-10", name: "2026-10-03 Blue Bottle.pdf")),
            DriveChatChangeItem(id: "4", kind: "RENAME", entryId: "e4",
                                before: DriveChatPlace(name: "scan 13.pdf"), after: DriveChatPlace(name: "2026-10-11 AWS invoice.pdf")),
        ] + (4..<items).map { DriveChatChangeItem(id: "\($0 + 1)", kind: "TRASH", entryId: "x\($0)", before: DriveChatPlace(name: "IMG_\($0).jpg")) }
        let held = status == .pending ? (0..<212).map { DriveChatHeldItem(id: "h\($0)", kind: "MOVE", name: "f\($0)", fromPath: "/a/f\($0)", toPath: "/b") } : []
        return DriveChatChangeGroup(id: "g-\(at)", sessionId: "s1", turnId: turn, status: status, createdAt: at,
                                    total: status == .pending ? 212 : items, skipped: skipped,
                                    items: status == .pending ? [] : made, heldItems: held)
    }

    func testAChangesCardSaysWhatTheBoardSays() {
        let look = DriveChatLogic.changesLook(group(.done), all: false)
        XCTAssertEqual(look.state, "Done · 24 changes")
        XCTAssertEqual(look.tone, .done)
        XCTAssertEqual(look.lines.map { "\($0.kind) \($0.detail)" }, [
            "New folder 2026-10",
            "New folder 2026-11",
            "Moved 2026-10-03 Blue Bottle.pdf → /Receipts 2026/2026-10",
            "Renamed scan 13.pdf → 2026-10-11 AWS invoice.pdf",
        ])
        XCTAssertEqual(look.more, "and 20 more")
        XCTAssertEqual(look.toggle, "Show all")
        XCTAssertTrue(look.undo)
        XCTAssertFalse(look.apply)

        let all = DriveChatLogic.changesLook(group(.done), all: true)
        XCTAssertEqual(all.lines.count, 24)
        XCTAssertNil(all.more)
        XCTAssertEqual(all.toggle, "Show less")
        XCTAssertEqual(DriveChatLogic.lines(group(.done))[4].kind, "To Trash")

        let held = DriveChatLogic.changesLook(group(.pending), all: false)
        XCTAssertEqual(held.state, "Needs you")
        XCTAssertEqual(held.tone, .needsYou)
        XCTAssertEqual(held.pending, "212 changes waiting for Apply")
        XCTAssertTrue(held.apply)
        XCTAssertFalse(held.undo)

        let undone = DriveChatLogic.changesLook(group(.undone, skipped: 2), all: false)
        XCTAssertEqual(undone.state, "Undone")
        XCTAssertEqual(undone.tone, .quiet)
        XCTAssertEqual(undone.skipped, "2 left as they are")
        XCTAssertEqual(undone.lines, [])
        XCTAssertFalse(undone.undo)
        XCTAssertNil(undone.toggle)

        XCTAssertEqual(DriveChatLogic.changesLook(group(.undoing), all: false).state, "Undoing…")
        XCTAssertTrue(DriveChatLogic.changesLook(group(.undoing), all: false).busy)
        XCTAssertTrue(DriveChatLogic.changesLook(group(.done), all: false, pressing: true).busy)
        XCTAssertEqual(DriveChatCopy.done(1), "Done · 1 change")
        XCTAssertEqual(DriveChatCopy.skipped(1), "1 left as it is")
    }

    func testAReplaceCardNamesBothFiles() {
        let calendar = Calendar(identifier: .gregorian)
        let now = ISO8601DateFormatter().date(from: "2026-11-27T10:00:00Z")!
        let existing = DriveChatQuestionFile(entryId: "b", path: "/Documents/Home/lease-2026.pdf", sizeBytes: 419_840,
                                             modifiedAt: "2026-01-04T09:00:00.000Z", lastWriter: .init(kind: "OWNER"))
        let facts = DriveChatLogic.facts(existing, now: now, calendar: calendar)
        XCTAssertEqual(facts.path, "/Documents/Home/lease-2026.pdf")
        XCTAssertEqual(facts.writer, "You")
        XCTAssertEqual(facts.line, "\(DriveLogic.formatSize(419_840)) · You · \(DriveLogic.formatWhen("2026-01-04T09:00:00.000Z", now: now, calendar: calendar))")
        let agent = DriveChatQuestionFile(entryId: "a", path: "/a", sizeBytes: 1, modifiedAt: "2026-01-04T09:00:00.000Z",
                                          lastWriter: .init(kind: "AGENT", sessionId: "s", sessionTitle: "Weekly review"))
        XCTAssertEqual(DriveChatLogic.facts(agent).writer, "Agent in Weekly review")
        XCTAssertEqual(DriveChatLogic.facts(DriveChatQuestionFile(entryId: "a", path: "/a", sizeBytes: 1, modifiedAt: "",
                                                                  lastWriter: .init(kind: "AGENT"))).writer, "An agent")

        func question(_ status: DriveChatQuestion.Status, _ choice: DriveChatQuestion.Choice? = nil) -> DriveChatQuestion {
            DriveChatQuestion(id: "q", sessionId: "s", turnId: "t", status: status, choice: choice, moving: agent, existing: existing,
                              outcome: choice == .keepBoth ? .init(entryId: "a", path: "/Documents/Home/lease-2026 (2).pdf", name: "lease-2026 (2).pdf") : nil,
                              createdAt: "2026-11-26T10:06:00.000Z")
        }
        XCTAssertNil(DriveChatLogic.questionNote(question(.open)))
        XCTAssertEqual(DriveChatLogic.questionNote(question(.answered, .keepBoth)), "Kept both · saved as lease-2026 (2).pdf.")
        XCTAssertEqual(DriveChatLogic.questionNote(question(.answered, .replace)), "Replaced. The old file is in its versions.")
        XCTAssertEqual(DriveChatLogic.questionNote(question(.stale)), "This question is no longer open.")
        XCTAssertTrue(DriveChatLogic.needsYou(question(.answering)))
        XCTAssertFalse(DriveChatLogic.needsYou(question(.answered, .replace)))
    }

    func testCardsStandAfterTheirTurnAndTheRestUnderTheConversation() {
        let first = group(.done, at: "2026-11-26T10:05:00.000Z", turn: "t1")
        let later = group(.undone, at: "2026-11-26T11:00:00.000Z", turn: "t3")
        let lease = DriveChatQuestion(
            id: "q", sessionId: "s1", turnId: "t2", status: .open,
            moving: DriveChatQuestionFile(entryId: "a", path: "/a", sizeBytes: 1, modifiedAt: "", lastWriter: .init(kind: "OWNER")),
            existing: DriveChatQuestionFile(entryId: "b", path: "/b", sizeBytes: 1, modifiedAt: "", lastWriter: .init(kind: "OWNER")),
            createdAt: "2026-11-26T10:30:00.000Z")
        let cards = DriveChatLogic.cards(groups: [later, first], questions: [lease])
        XCTAssertEqual(cards.map(\.turnId), ["t1", "t2", "t3"], "oldest first")
        // The conversation places them (`TranscriptRows.build`, the web's `useDriveChatCards`): after the last item of
        // their turn — a turn runs from the message carrying its `turnId` to the next one that does — and a card whose
        // turn is not among the items read under the conversation.
        var reducer = TranscriptReducer()
        reducer.apply(RunEvent(seq: 1, type: .user, turnId: "t1", payload: .object(["text": .string("Sort these")])))
        reducer.apply(RunEvent(seq: 2, type: .assistant, turnId: "t1", payload: .object(["text": .string("Moved 24.")])))
        reducer.apply(RunEvent(seq: 3, type: .user, turnId: "t2", payload: .object(["text": .string("Move the lease")])))
        reducer.apply(RunEvent(seq: 4, type: .assistant, turnId: "t2", payload: .object(["text": .string("Keep both?")])))
        let rows = TranscriptRows.build(state: reducer.state, statusCards: [], canPageOlder: false, showWorkingIndicator: false,
                                        chatCards: cards.map { TranscriptChatCard(id: $0.id, turnId: $0.turnId) })
        let order = rows.compactMap { row -> String? in
            switch row {
            case .item(.user(let bubble)): return "you: \(bubble.text)"
            case .item(.assistant(let bubble)): return "agent: \(bubble.text)"
            case .chatCard(let card): return card.id
            default: return nil
            }
        }
        XCTAssertEqual(order, ["you: Sort these", "agent: Moved 24.", cards[0].id,
                               "you: Move the lease", "agent: Keep both?", cards[1].id, cards[2].id])
        XCTAssertEqual(DriveChatLogic.needYou(groups: [first, group(.pending)], questions: [lease]), 2)
    }

    // MARK: the marks

    func testMarksAreTheLatestStandingChangeOfAMadeGroup() {
        let made = DriveChatChangeGroup(id: "a", sessionId: "s", turnId: "t", status: .done, createdAt: "2026-11-26T10:00:00.000Z", total: 3, items: [
            DriveChatChangeItem(id: "1", kind: "NEW_FOLDER", entryId: "f"),
            DriveChatChangeItem(id: "2", kind: "MOVE", entryId: "m"),
            DriveChatChangeItem(id: "3", kind: "RENAME", entryId: "r", state: "SKIPPED"),
            DriveChatChangeItem(id: "4", kind: "TRASH", entryId: "t"),
        ])
        let again = DriveChatChangeGroup(id: "b", sessionId: "s", turnId: "t2", status: .done, createdAt: "2026-11-26T11:00:00.000Z", total: 1, items: [
            DriveChatChangeItem(id: "5", kind: "RENAME", entryId: "m"),
        ])
        let undone = DriveChatChangeGroup(id: "c", sessionId: "s", turnId: "t3", status: .undone, createdAt: "2026-11-26T12:00:00.000Z", total: 1, items: [
            DriveChatChangeItem(id: "6", kind: "NEW_FILE", entryId: "u"),
        ])
        let marks = DriveChatLogic.marks([again, undone, made])
        XCTAssertEqual(marks[PublicID.storageKey("f")]?.mark, .new)
        XCTAssertEqual(marks[PublicID.storageKey("m")]?.mark, .renamed, "the later change of the same entry")
        XCTAssertEqual(marks[PublicID.storageKey("m")]?.key, "5")
        XCTAssertNil(marks[PublicID.storageKey("r")], "an item Undo skipped stands as it was before")
        XCTAssertNil(marks[PublicID.storageKey("t")], "Trash leaves no row to mark")
        XCTAssertNil(marks[PublicID.storageKey("u")], "an undone group leaves no mark")

        XCTAssertEqual(DriveChatLogic.remember("5", in: ["1"]), ["1", "5"])
        XCTAssertEqual(DriveChatLogic.remember("1", in: ["1"]), ["1"])
        XCTAssertEqual(DriveChatLogic.remember("new", in: (0..<500).map(String.init)).count, 500)
        XCTAssertNotEqual(DriveChatLogic.seenKey(account: "u1"), DriveChatLogic.seenKey(account: "u2"))
        XCTAssertNotEqual(DriveChatLogic.closedKey(account: "u1"), DriveChatLogic.closedKey(account: "u2"))
    }

    func testDetailsOverlayTheListWhileTheChatIsOpenOnANarrowWindow() {
        XCTAssertTrue(DriveChatLogic.detailsOverlay(chatOpen: true, windowWidth: 1320))
        XCTAssertFalse(DriveChatLogic.detailsOverlay(chatOpen: true, windowWidth: 1760))
        XCTAssertFalse(DriveChatLogic.detailsOverlay(chatOpen: false, windowWidth: 1320))
    }

    // MARK: the note on the owner's bubble

    func testTheDriveNoteIsNamedOnTheAttachedLine() {
        let note = "\n\n<orbit_drive_chat folder=\"/Scans\" selected=\"12\">\nThe owner has the folder /Scans open (id x).\n</orbit_drive_chat>"
        XCTAssertEqual(DriveChatLogic.noteLabel(note.trimmingCharacters(in: .whitespacesAndNewlines)), "Folder · Scans · 12 files")
        XCTAssertEqual(describeNote(note), "Folder · Scans · 12 files")
        XCTAssertEqual(DriveChatLogic.noteLabel("<orbit_drive_chat folder=\"/\" selected=\"0\">\n</orbit_drive_chat>"), "Folder · Drive")
        XCTAssertEqual(DriveChatLogic.noteLabel("<orbit_drive_chat selected=\"1\">\n</orbit_drive_chat>"), "1 file")
        // The guidance alone, on a first message sent with no folder, names nothing.
        XCTAssertNil(DriveChatLogic.noteLabel("<orbit_drive_chat>\nHow to work in this chat:\n</orbit_drive_chat>"))
        XCTAssertEqual(describeNote("<orbit_drive_chat>\nHow to work in this chat:\n</orbit_drive_chat>"), "")
    }
}
