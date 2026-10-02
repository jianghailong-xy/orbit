import XCTest
@testable import OrbitKit

/// The folder fields on the wire (docs/session-folders-move-design.md §3.2, §5.6): a session row's
/// `folderId`, the folder list, the folder a new session is filed in, the move's body and the
/// user-scoped `folder.changed` event.
final class SessionFolderCodableTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    /// An older server never sends `folderId`; its rows still decode, and are in no folder.
    func testAMissingFolderIdDecodesAsNoFolder() throws {
        XCTAssertNil(try session(#"{"id":"s1","status":"RUNNING"}"#).folderId)
        XCTAssertNil(try session(#"{"id":"s1","status":"RUNNING","folderId":null}"#).folderId)
        XCTAssertEqual(try session(#"{"id":"s1","status":"RUNNING","folderId":"f1"}"#).folderId, "f1")
    }

    /// `GET /session-folders` answers `{ id, workspaceId, name }` per folder.
    func testTheFolderListDecodes() throws {
        let folders = try JSONDecoder().decode([SessionFolder].self, from: Data(#"""
        [{"id":"f1","workspaceId":"w1","name":"Notes"},{"id":"f2","workspaceId":"w2","name":"Drafts"}]
        """#.utf8))
        XCTAssertEqual(folders, [SessionFolder(id: "f1", workspaceId: "w1", name: "Notes"),
                                 SessionFolder(id: "f2", workspaceId: "w2", name: "Drafts")])
    }

    /// A session started from a folder's page names that folder; any other leaves the key out, so
    /// it is in no folder exactly as before.
    func testANewSessionCanNameItsFolder() throws {
        let filed = try jsonObject(CreateSessionRequest(prompt: "do it", agentId: "w1", folderId: "f1"))
        XCTAssertEqual(filed["folderId"] as? String, "f1")
        XCTAssertEqual(filed["agentId"] as? String, "w1")
        XCTAssertFalse(try jsonObject(CreateSessionRequest(prompt: "do it", agentId: "w1")).keys.contains("folderId"))
    }

    /// The move says where the session goes, and "No Folder" is said as an explicit null.
    func testAMoveNamesTheFolderOrNull() throws {
        XCTAssertEqual(try jsonObject(MoveSessionRequest(folderId: "f1"))["folderId"] as? String, "f1")
        let out = try jsonObject(MoveSessionRequest(folderId: nil))
        XCTAssertTrue(out.keys.contains("folderId"))
        XCTAssertTrue(out["folderId"] is NSNull)
    }

    /// `folder.changed` is the server's name for a folder created, renamed or deleted; it belongs
    /// to the owner, so its `sessionId` is empty.
    func testFolderChangedIsRecognizedAsAUserScopedEvent() throws {
        let event = try JSONDecoder().decode(ControlEvent.self, from: Data(#"""
        {"type":"folder.changed","sessionId":"","agentId":null,"ts":"2026-10-02T12:00:00.000Z","data":{"id":"f1"}}
        """#.utf8))
        XCTAssertEqual(event.type, .folderChanged)
        XCTAssertEqual(ControlEventType.folderChanged.rawValue, "folder.changed")
        XCTAssertEqual(event.sessionId, "")
    }
}

/// A move made elsewhere reaches a loaded row through the `session.updated` summary, whose
/// `folderId` is a value even when null; and nothing that carries no folder may lose the row's.
final class SessionFolderUpsertTests: XCTestCase {
    private func row(folder: String?) throws -> Session {
        let key = folder.map { #","folderId":"\#($0)""# } ?? ""
        return try JSONDecoder().decode(Session.self, from: Data(#"""
        {"id":"s1","title":"Fix bug","status":"RUNNING","runState":"RUNNING","pendingApprovals":0\#(key)}
        """#.utf8))
    }

    private func summary(_ extra: String) throws -> ControlSessionSummary {
        try JSONDecoder().decode(ControlSessionSummary.self, from: Data(#"""
        {"id":"s1","status":"RUNNING","runState":"RUNNING","pendingApprovals":0\#(extra)}
        """#.utf8))
    }

    func testTheSummaryMovesTheRowBetweenFolders() throws {
        let filed = try row(folder: "f1")
        XCTAssertEqual(filed.applying(try summary(#","folderId":"f2""#)).folderId, "f2")
        XCTAssertNil(filed.applying(try summary(#","folderId":null"#)).folderId)
        XCTAssertEqual(try row(folder: nil).applying(try summary(#","folderId":"f1""#)).folderId, "f1")
    }

    /// An older control plane never sends the key: the row keeps the folder the list said.
    func testASummaryWithoutTheKeyKeepsTheRowsFolder() throws {
        XCTAssertEqual(try row(folder: "f1").applying(try summary("")).folderId, "f1")
    }

    func testChangesThatCarryNoFolderKeepIt() throws {
        let filed = try row(folder: "f1")
        XCTAssertEqual(filed.settingTitle("Renamed").folderId, "f1")
        XCTAssertEqual(filed.settingPendingApprovals(2).folderId, "f1")
        XCTAssertEqual(filed.applyingProjectRelation(try summary(#","projectId":null"#)).folderId, "f1")
    }
}
