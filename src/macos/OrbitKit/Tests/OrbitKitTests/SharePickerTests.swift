import XCTest
@testable import OrbitKit

final class SharePickerTests: XCTestCase {
    private let mb: Int64 = 1024 * 1024

    func testFilesOverTheAttachCapAreStruckOutAndTheRestGo() {
        let ok = SharePickerItem(id: 0, name: "notes.txt", kind: .file(mime: "text/plain", bytes: 25 * 1024))
        let big = SharePickerItem(id: 1, name: "dump.zip", kind: .file(mime: "application/zip", bytes: 26 * mb))
        let edge = SharePickerItem(id: 2, name: "edge.bin", kind: .file(mime: "application/octet-stream", bytes: 25 * mb))
        XCTAssertNil(ok.rejectReason)
        XCTAssertEqual(big.rejectReason, "Too large (max 25 MB)")
        XCTAssertNil(edge.rejectReason)
        XCTAssertEqual([ok, big, edge].filter(\.goes).map(\.id), [0, 2])
    }

    func testAnInlineImageIsHeldToTheComposersImageCap() {
        let photo = SharePickerItem(id: 0, name: "IMG_1.png", kind: .file(mime: "image/png", bytes: 6 * mb))
        XCTAssertEqual(photo.rejectReason, "Too large (max 5 MB)")
    }

    func testUnsupportedAndEmptyItemsAreStruckOut() {
        XCTAssertEqual(SharePickerItem(id: 0, name: "x", kind: .unsupported).rejectReason, "Not supported")
        XCTAssertEqual(SharePickerItem(id: 0, name: "x", kind: .file(mime: "text/plain", bytes: 0)).rejectReason,
                       "Not supported")
        XCTAssertNil(SharePickerItem(id: 0, name: "x", kind: .text("hi", isURL: false)).rejectReason)
    }

    func testChipBadges() {
        XCTAssertEqual(SharePickerItem(id: 0, name: "a.txt", kind: .file(mime: "text/plain", bytes: 1)).badge, "TXT")
        XCTAssertEqual(SharePickerItem(id: 0, name: "https://x", kind: .text("https://x", isURL: true)).badge, "LINK")
    }

    func testRowsAreNewestFirstAndSearchMatchesTitleOrWorkspace() {
        let snap = RecentSessionsSnapshot(sessions: [
            .init(id: "a", title: "Release notes for 0.9", workspaceId: "w1", workspaceName: "orbit-develop",
                  updatedAt: Date(timeIntervalSince1970: 100)),
            .init(id: "b", title: "Fix login redirect", workspaceId: "w1", workspaceName: "orbit-develop",
                  updatedAt: Date(timeIntervalSince1970: 300)),
            .init(id: "c", title: "Android cold-start crash", workspaceId: "w2", workspaceName: "orbit-android",
                  updatedAt: Date(timeIntervalSince1970: 200)),
        ])
        XCTAssertEqual(SharePicker.rows(snap, query: "").map(\.id), ["b", "c", "a"])
        XCTAssertEqual(SharePicker.rows(snap, query: "LOGIN").map(\.id), ["b"])
        XCTAssertEqual(SharePicker.rows(snap, query: "android").map(\.id), ["c"])
    }

    func testDefaultWorkspaceIsTheAppsElseTheNewestSessions() {
        let row = RecentSessionsSnapshot.Row(id: "a", title: "t", workspaceId: "w9", workspaceName: "nine",
                                             updatedAt: Date())
        XCTAssertEqual(RecentSessionsSnapshot(sessions: [row]).defaultWorkspace?.id, "w9")
        XCTAssertEqual(RecentSessionsSnapshot(sessions: [row], workspaces: [.init(id: "w1", name: "one")])
            .defaultWorkspace?.id, "w1")
        XCTAssertNil(RecentSessionsSnapshot(sessions: []).defaultWorkspace)
    }

    func testASnapshotWithoutWorkspacesStillDecodes() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = #"{"version":1,"snapshot":{"sessions":[]}}"#
        try Data(json.utf8).write(to: dir.appendingPathComponent("RecentSessions.json"))
        XCTAssertEqual(RecentSessionsSnapshotStore(root: dir).load(), RecentSessionsSnapshot(sessions: []))
    }

    func testComposerTextJoinsSharedTextThenTheNote() {
        XCTAssertEqual(SharePicker.composerText(sharedTexts: ["https://x.dev"], note: " look "), "https://x.dev\n\nlook")
        XCTAssertNil(SharePicker.composerText(sharedTexts: [], note: "  "))
    }

    func testNotificationAndToastCopy() {
        XCTAssertEqual(ShareCopy.notificationBody(files: 1, title: "Fix login redirect"),
                       "1 file ready in “Fix login redirect” — tap to finish")
        XCTAssertEqual(ShareCopy.notificationBody(files: 3, title: "T"), "3 files ready in “T” — tap to finish")
        XCTAssertEqual(ShareCopy.notificationBody(files: 0, title: "T"), "Your text is ready in “T” — tap to finish")
        XCTAssertEqual(ShareCopy.filesAdded(1), "1 shared file added")
        XCTAssertEqual(ShareCopy.filesAdded(2), "2 shared files added")
        XCTAssertEqual(ShareCopy.added(to: "T"), "Added to “T”")
    }

    func testShareLinkRoundTripsAndBecomesAnIntent() {
        let url = ShareHandoffLink.url(target: .session(id: "5rYtl8WA1NSca2rDrCMHmW"), entryID: "E1")
        XCTAssertEqual(url.absoluteString, "orbit-session://5rYtl8WA1NSca2rDrCMHmW?share=E1")
        XCTAssertEqual(ShareHandoffLink.entryID(in: url), "E1")
        XCTAssertEqual(ShareHandoffLink.url(target: .newSession(workspaceId: "w"), entryID: "E2").absoluteString,
                       "orbit-session://new?share=E2")
        XCTAssertNil(ShareHandoffLink.entryID(in: URL(string: "orbit://session/abc?share=E1")!))
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                            userInfo: [ShareHandoffLink.userInfoKey: url.absoluteString]),
                       .openShare(entryID: "E1"))
    }
}
