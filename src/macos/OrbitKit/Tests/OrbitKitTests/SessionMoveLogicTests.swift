import Foundation
import XCTest
@testable import OrbitKit

/// The Move panel's folder group (docs/session-folders-move-design.md §4): which places it offers a
/// session, in what order, with what counts and which one ticked; the name New Folder… sends; the
/// words a move and a refused folder leave; and the row patch a move is drawn with before the server
/// answers.
final class SessionMoveLogicTests: XCTestCase {
    private func folder(_ id: String, _ name: String, workspace: String = "w1") -> SessionFolder {
        SessionFolder(id: id, workspaceId: workspace, name: name)
    }

    private func session(_ id: String, folder: String? = nil) -> Session {
        Session(id: id, title: id, status: .awaitingInput, agentId: "w1", assignedRunnerId: nil,
                pendingApprovals: 0, branch: nil, updatedAt: nil, folderId: folder)
    }

    private func options(_ session: Session, folders: [SessionFolder],
                         listed: [Session]) -> [SessionMoveFolderOption] {
        SessionMoveLogic.folderOptions(for: session, workspaceID: "w1", folders: folders, listed: listed)
    }

    // MARK: the places a session can go

    /// No Folder heads the group, then the workspace's folders as Finder orders names — and only
    /// that workspace's: the library holds every workspace's folders.
    func testNoFolderThenTheWorkspacesOwnFoldersByName() {
        let folders = [folder("f3", "sprint 10"), folder("f1", "Release"), folder("f2", "Sprint 2"),
                       folder("x1", "Elsewhere", workspace: "w2")]
        let me = session("s1")
        let rows = options(me, folders: folders, listed: [me])
        XCTAssertEqual(rows.map { $0.folder?.name }, [nil, "Release", "Sprint 2", "sprint 10"])
        XCTAssertNil(rows[0].sessionCount, "No Folder counts nothing")
        XCTAssertEqual(rows[0].id, "", "and its id can't be a folder's")
    }

    /// Each folder carries how many of the list's sessions are in it, the empty ones too — the panel
    /// files the session anywhere in its workspace, whichever scope the list shows.
    func testEachFolderCountsTheListsSessionsInIt() {
        let folders = [folder("f1", "Release"), folder("f2", "iOS polish"), folder("f3", "Empty")]
        let me = session("s1")
        let listed = [me, session("s2", folder: "f1"), session("s3", folder: "f1"),
                      session("s4", folder: "f2"), session("s5")]
        let counts = Dictionary(uniqueKeysWithValues: options(me, folders: folders, listed: listed)
            .compactMap { row in row.folder.map { ($0.name, row.sessionCount) } })
        XCTAssertEqual(counts, ["Release": 2, "iOS polish": 1, "Empty": 0])
    }

    /// The tick is where the session is: No Folder while it's in none, its folder once it's in one.
    func testTheTickIsWhereTheSessionIs() {
        let folders = [folder("f1", "Release"), folder("f2", "iOS polish")]
        let loose = session("s1")
        XCTAssertEqual(options(loose, folders: folders, listed: [loose]).filter(\.isCurrent).map(\.id), [""])

        let filed = session("s1", folder: "f2")
        let rows = options(filed, folders: folders, listed: [filed])
        XCTAssertEqual(rows.filter(\.isCurrent).map { $0.folder?.name }, ["iOS polish"])
        XCTAssertEqual(rows.filter(\.isCurrent).count, 1, "one tick")
    }

    /// The panel reads the row as the list has it now, so a move made since the panel was handed
    /// its copy — on another device, or the last tap here — is where the tick goes.
    func testTheRowIsReadAsTheListHasItNow() {
        let folders = [folder("f1", "Release"), folder("f2", "iOS polish")]
        let handed = session("s1", folder: "f1")
        let rows = options(handed, folders: folders, listed: [session("s1", folder: "f2")])
        XCTAssertEqual(rows.filter(\.isCurrent).map { $0.folder?.id }, ["f2"])
        // A row the list no longer has is read as it was handed over.
        XCTAssertEqual(options(handed, folders: folders, listed: []).filter(\.isCurrent).map { $0.folder?.id },
                       ["f1"])
    }

    /// A folder that isn't among the workspace's — deleted since the row was read — ticks No Folder,
    /// which is where the list shows such a session (`SessionFolderGrouping.listing`).
    func testAFolderNobodyKnowsTicksNoFolder() {
        let gone = session("s1", folder: "deleted")
        let rows = options(gone, folders: [folder("f1", "Release")], listed: [gone])
        XCTAssertEqual(rows.filter(\.isCurrent).map(\.id), [""])
        XCTAssertEqual(SessionFolderGrouping.listing([gone], folders: [folder("f1", "Release")], view: .open,
                                                     byTag: false).sessions.map(\.id), ["s1"])
    }

    /// A workspace with no folders yet still offers No Folder, ticked.
    func testAWorkspaceWithoutFoldersOffersNoFolderAlone() {
        let me = session("s1")
        let rows = options(me, folders: [folder("x1", "Elsewhere", workspace: "w2")], listed: [me])
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].folder)
        XCTAssertTrue(rows[0].isCurrent)
    }

    // MARK: New Folder…

    /// The name goes as the server stores it, without the space around it; spaces alone send nothing.
    func testTheNewFoldersNameIsTrimmedAndABlankOneIsNoName() {
        XCTAssertEqual(SessionMoveLogic.folderName("  Release \n"), "Release")
        XCTAssertEqual(SessionMoveLogic.folderName("iOS polish"), "iOS polish")
        XCTAssertNil(SessionMoveLogic.folderName("   "))
        XCTAssertNil(SessionMoveLogic.folderName(""))
    }

    /// A name the workspace already has comes back as a 409, and is said in so many words; anything
    /// else is the server's own reason.
    func testARefusedFolderSaysWhy() {
        let duplicate = APIError.http(status: 409, body: #"{"statusCode":409,"message":"a folder with that name already exists in this workspace","error":"Conflict"}"#)
        XCTAssertEqual(SessionMoveCopy.createFailure(duplicate, name: "Release", workspace: "orbit"),
                       "There’s already a folder named “Release” in orbit. Choose another name.")

        let tooLong = APIError.http(status: 400, body: #"{"statusCode":400,"message":["name must be shorter than or equal to 60 characters"],"error":"Bad Request"}"#)
        XCTAssertEqual(SessionMoveCopy.createFailure(tooLong, name: "x", workspace: "orbit"),
                       "The folder couldn’t be created: name must be shorter than or equal to 60 characters.")
        XCTAssertEqual(SessionMoveCopy.createFailure(URLError(.networkConnectionLost), name: "x", workspace: "orbit"),
                       "The folder couldn’t be created: the connection dropped.")
    }

    // MARK: what a move says

    /// Into a folder, the toast names it; out of one (No Folder), it names the folder left.
    func testTheToastNamesWhereTheSessionWent() {
        let release = folder("f1", "Release")
        let polish = folder("f2", "iOS polish")
        XCTAssertEqual(SessionMoveCopy.moved(to: polish, from: nil), "Moved to “iOS polish”")
        XCTAssertEqual(SessionMoveCopy.moved(to: polish, from: release), "Moved to “iOS polish”")
        XCTAssertEqual(SessionMoveCopy.moved(to: nil, from: release), "Moved out of “Release”")
        XCTAssertEqual(SessionMoveCopy.moved(to: nil, from: nil), "Moved out of its folder")
        XCTAssertEqual(SessionMoveCopy.folderGroup(workspace: "orbit"), "Folder in orbit")
    }

    // MARK: the row a move draws before the server answers

    /// A move is drawn at once by filing the row; writing back the folder it had puts it back.
    /// Nothing else on the row changes.
    func testSettingTheFolderFilesTheRowAndPutsItBack() {
        let row = Session(id: "s1", title: "Release notes", status: .awaitingInput, agentId: "w1",
                          assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                          pinnedAt: "2026-09-01T00:00:00Z", folderId: "f1")
        let moved = row.settingFolder("f2")
        XCTAssertEqual(moved.folderId, "f2")
        XCTAssertEqual(moved.settingFolder(nil).folderId, nil, "No Folder clears it")
        XCTAssertEqual(moved.settingFolder("f1"), row, "and the folder it had restores the row exactly")
        XCTAssertEqual(moved.title, "Release notes")
        XCTAssertEqual(moved.pinnedAt, "2026-09-01T00:00:00Z")
    }
}
