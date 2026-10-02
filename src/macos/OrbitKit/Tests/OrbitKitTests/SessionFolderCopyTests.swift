import XCTest
@testable import OrbitKit

/// The words folder management says (docs/session-folders-move-design.md §3.4): the two entries a
/// folder offers, the delete confirmation — which promises nothing is deleted — and the refusals, a
/// duplicate name among them.
final class SessionFolderCopyTests: XCTestCase {
    /// The two management acts, as the row's long-press menu and the page's ⋯ spell them.
    func testTheTwoEntriesAreTheDesignsWords() {
        XCTAssertEqual(SessionFolderCopy.rename, "Rename…")
        XCTAssertEqual(SessionFolderCopy.delete, "Delete Folder…")
        XCTAssertEqual(SessionFolderCopy.newFolder, "New Folder…")
        XCTAssertEqual(SessionFolderCopy.newFolder, SessionMoveCopy.newFolder,
                       "the list's entry and the Move panel's are the same entry")
    }

    /// §3.4's confirmation, word for word — `Delete “<name>”?`, and the body that says the sessions
    /// move back to the list and nothing is deleted.
    func testTheDeleteConfirmationSaysNothingIsDeleted() {
        XCTAssertEqual(SessionFolderCopy.deleteTitle("Release"), "Delete “Release”?")
        XCTAssertEqual(SessionFolderCopy.deleteMessage(sessionCount: 4),
                       "The 4 sessions in it move back to the list. No session is deleted.")
        XCTAssertEqual(SessionFolderCopy.deleteMessage(sessionCount: 1),
                       "The 1 session in it moves back to the list. No session is deleted.")
        XCTAssertEqual(SessionFolderCopy.deleteMessage(sessionCount: 0),
                       "The 0 sessions in it move back to the list. No session is deleted.")
    }

    /// A name its workspace already has is a 409 — the sentence names the name and the workspace and
    /// says what to do, exactly as the Move panel says it for New Folder….
    func testADuplicateNameIsSaidInSoManyWords() {
        let refused = APIError.http(status: 409,
                                    body: #"{"statusCode":409,"message":"a folder with that name already exists in this workspace","error":"Conflict"}"#)
        let sentence = SessionFolderCopy.renameFailure(refused, name: "Release", workspace: "orbit")
        XCTAssertEqual(sentence, "There’s already a folder named “Release” in orbit. Choose another name.")
        XCTAssertEqual(SessionMoveCopy.createFailure(refused, name: "Release", workspace: "orbit"), sentence,
                       "creating one and renaming one are refused in the same words")
    }

    /// Anything else is the server's own reason, said as one sentence with the verb that failed.
    func testAnyOtherFailureCarriesTheServersReason() {
        let offline = URLError(.notConnectedToInternet)
        XCTAssertTrue(SessionFolderCopy.renameFailure(offline, name: "Release", workspace: "orbit")
            .hasPrefix("The folder couldn’t be renamed: "))
        XCTAssertTrue(SessionFolderCopy.deleteFailure(offline)
            .hasPrefix("The folder couldn’t be deleted: "))
    }
}
