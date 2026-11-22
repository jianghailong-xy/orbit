import Foundation
import XCTest
@testable import OrbitKit

final class ShareInboxTests: XCTestCase {
    private var root: URL!
    private var sources: URL!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShareInboxTests-\(UUID().uuidString)", isDirectory: true)
        root = base.appendingPathComponent("group", isDirectory: true)
        sources = base.appendingPathComponent("sources", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }

    private func source(_ name: String, _ contents: String, mime: String = "text/plain") throws -> ShareInbox.Source {
        let url = sources.appendingPathComponent(UUID().uuidString)
        try Data(contents.utf8).write(to: url)
        return ShareInbox.Source(url: url, name: name, mime: mime)
    }

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: write

    func testWriteCopiesItemsBesideEntryJSON() throws {
        let inbox = ShareInbox(root: root)
        let entry = try inbox.write(target: .session(id: "s1"),
                                    items: [try source("notes.txt", "hello"),
                                            try source("photo.png", "PNGDATA!", mime: "image/png")],
                                    note: "look at this", now: t0)

        let dir = root.appendingPathComponent("ShareInbox/\(entry.id)")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("entry.json").path))
        XCTAssertEqual(entry.items.map(\.name), ["notes.txt", "photo.png"])
        XCTAssertEqual(entry.items.map(\.mime), ["text/plain", "image/png"])
        XCTAssertEqual(entry.items.map(\.bytes), [5, 8])
        for item in entry.items {
            XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent(item.file).path))
        }
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent(entry.items[0].file), encoding: .utf8),
                       "hello")
        XCTAssertEqual(inbox.list(), [entry])
        XCTAssertEqual(inbox.list().first?.note, "look at this")
        // Nothing half-written is left behind.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.directory.path), [entry.id])
    }

    func testEntryJSONShapeMatchesTheDesign() throws {
        let inbox = ShareInbox(root: root)
        let entry = try inbox.write(target: .newSession(workspaceId: "w9"), items: [try source("a.txt", "x")],
                                    note: nil, now: t0)
        let data = try Data(contentsOf: root.appendingPathComponent("ShareInbox/\(entry.id)/entry.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["id"] as? String, entry.id)
        XCTAssertNotNil(json["createdAt"])
        XCTAssertEqual(json["target"] as? [String: String], ["newIn": "w9"])
        let item = try XCTUnwrap((json["items"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(item.keys), ["file", "name", "mime", "bytes"])

        let session = try JSONEncoder().encode(ShareTarget.session(id: "s1"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: session) as? [String: String], ["sessionId": "s1"])
        XCTAssertEqual(try JSONDecoder().decode(ShareTarget.self, from: Data(#"{"newIn":"w"}"#.utf8)),
                       .newSession(workspaceId: "w"))
        XCTAssertThrowsError(try JSONDecoder().decode(ShareTarget.self, from: Data("{}".utf8)))
    }

    func testWriteFailureLeavesNoEntry() throws {
        let inbox = ShareInbox(root: root)
        let missing = ShareInbox.Source(url: sources.appendingPathComponent("gone"), name: "gone", mime: "x/y")
        XCTAssertThrowsError(try inbox.write(target: .session(id: "s"), items: [missing], note: nil, now: t0))
        XCTAssertEqual(inbox.list(), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.directory.path), [])
    }

    func testUnsafeItemNamesStayInsideTheEntry() throws {
        let inbox = ShareInbox(root: root)
        let entry = try inbox.write(target: .session(id: "s"),
                                    items: [try source("../../evil.txt", "1"), try source("..", "2")],
                                    note: nil, now: t0)
        XCTAssertFalse(entry.items.contains { $0.file.contains("/") })
        XCTAssertEqual(entry.items[0].name, "../../evil.txt")
        let claimed = try XCTUnwrap(inbox.claim(id: entry.id))
        for url in claimed.itemURLs {
            XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL, claimed.directory.standardizedFileURL)
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        }
    }

    // MARK: list

    func testListIsNewestFirstAndSkipsIncompleteEntries() throws {
        let inbox = ShareInbox(root: root)
        let old = try inbox.write(target: .session(id: "a"), items: [], note: nil, now: t0)
        let new = try inbox.write(target: .session(id: "b"), items: [], note: nil, now: t0.addingTimeInterval(60))
        let mid = try inbox.write(target: .session(id: "c"), items: [], note: nil, now: t0.addingTimeInterval(30))
        // A directory with no entry.json yet, and one being written, are not entries.
        try FileManager.default.createDirectory(at: inbox.directory.appendingPathComponent(UUID().uuidString),
                                                withIntermediateDirectories: false)
        try FileManager.default.createDirectory(
            at: inbox.directory.appendingPathComponent(UUID().uuidString + ".writing"),
            withIntermediateDirectories: false)
        XCTAssertEqual(inbox.list().map(\.id), [new.id, mid.id, old.id])
    }

    func testListOfAMissingInboxIsEmpty() {
        XCTAssertEqual(ShareInbox(root: root.appendingPathComponent("nowhere")).list(), [])
    }

    // MARK: claim and delete

    func testClaimHidesTheEntryAndDeleteRemovesIt() throws {
        let inbox = ShareInbox(root: root)
        let entry = try inbox.write(target: .session(id: "s"), items: [try source("a.txt", "abc")],
                                    note: "n", now: t0)
        let claimed = try XCTUnwrap(inbox.claim(id: entry.id))
        XCTAssertEqual(claimed.entry, entry)
        XCTAssertEqual(try String(contentsOf: claimed.itemURLs[0], encoding: .utf8), "abc")
        XCTAssertEqual(inbox.list(), [], "a claimed entry is consumed")
        XCTAssertNil(inbox.claim(id: entry.id), "a second claim gets nothing")

        inbox.delete(claimed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: claimed.directory.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.directory.path), [])
    }

    func testClaimRefusesMissingAndPathLikeIds() throws {
        let inbox = ShareInbox(root: root)
        let entry = try inbox.write(target: .session(id: "s"), items: [], note: nil, now: t0)
        XCTAssertNil(inbox.claim(id: UUID().uuidString))
        XCTAssertNil(inbox.claim(id: ""))
        XCTAssertNil(inbox.claim(id: "../\(entry.id)"))
        XCTAssertNil(inbox.claim(id: entry.id + ".claimed"))
        XCTAssertNotNil(inbox.claim(id: entry.id))
    }

    func testConcurrentClaimersOnlyOneWins() throws {
        let inbox = ShareInbox(root: root)
        for round in 0..<20 {
            let entry = try inbox.write(target: .session(id: "s\(round)"), items: [try source("f", "x")],
                                        note: nil, now: t0)
            let lock = NSLock()
            var wins = 0
            DispatchQueue.concurrentPerform(iterations: 16) { _ in
                if ShareInbox(root: root).claim(id: entry.id) != nil {
                    lock.lock(); wins += 1; lock.unlock()
                }
            }
            XCTAssertEqual(wins, 1, "round \(round)")
        }
    }

    // MARK: sweep

    func testSweepRemovesEntriesOlderThan24Hours() throws {
        let inbox = ShareInbox(root: root)
        let now = t0.addingTimeInterval(ShareInbox.maxAge + 3600)
        let stale = try inbox.write(target: .session(id: "a"), items: [try source("a", "1")], note: nil, now: t0)
        let staleClaimed = try inbox.write(target: .session(id: "b"), items: [], note: nil,
                                           now: t0.addingTimeInterval(60))
        _ = try XCTUnwrap(inbox.claim(id: staleClaimed.id))
        let fresh = try inbox.write(target: .session(id: "c"), items: [], note: nil,
                                    now: now.addingTimeInterval(-3600))
        let edge = try inbox.write(target: .session(id: "d"), items: [], note: nil,
                                   now: now.addingTimeInterval(-ShareInbox.maxAge))

        XCTAssertEqual(inbox.sweep(now: now), 2)
        XCTAssertEqual(inbox.list().map(\.id), [fresh.id, edge.id])
        let left = Set(try FileManager.default.contentsOfDirectory(atPath: inbox.directory.path))
        XCTAssertEqual(left, [fresh.id, edge.id])
        XCTAssertFalse(left.contains(stale.id))
    }

    func testSweepDatesUnreadableEntriesByTheirDirectory() throws {
        let inbox = ShareInbox(root: root)
        let torn = inbox.directory.appendingPathComponent(UUID().uuidString + ".writing")
        try FileManager.default.createDirectory(at: torn, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.modificationDate: t0], ofItemAtPath: torn.path)
        XCTAssertEqual(inbox.sweep(now: t0.addingTimeInterval(3600)), 0)
        XCTAssertEqual(inbox.sweep(now: t0.addingTimeInterval(ShareInbox.maxAge + 1)), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: torn.path))
    }

    // MARK: 10-minute rule

    func testOpenRoutesToTheNewestUnconsumedEntryYoungerThan10Minutes() throws {
        let inbox = ShareInbox(root: root)
        XCTAssertNil(inbox.entryForOpen(now: t0))
        let older = try inbox.write(target: .session(id: "a"), items: [], note: nil, now: t0)
        let newer = try inbox.write(target: .session(id: "b"), items: [], note: nil, now: t0.addingTimeInterval(120))

        XCTAssertEqual(inbox.entryForOpen(now: t0.addingTimeInterval(180))?.id, newer.id)
        XCTAssertEqual(inbox.entryForOpen(now: t0.addingTimeInterval(120 + 599))?.id, newer.id)
        XCTAssertNil(inbox.entryForOpen(now: t0.addingTimeInterval(120 + 600)), "10 minutes is too old")

        // Once the newest is consumed, the next one routes if it is still young enough.
        _ = try XCTUnwrap(inbox.claim(id: newer.id))
        XCTAssertEqual(inbox.entryForOpen(now: t0.addingTimeInterval(300))?.id, older.id)
        XCTAssertNil(inbox.entryForOpen(now: t0.addingTimeInterval(700)))
    }

    func testOpenRuleOverAList() {
        let a = ShareEntry(id: "a", createdAt: t0, target: .session(id: "1"), items: [], note: nil)
        let b = ShareEntry(id: "b", createdAt: t0.addingTimeInterval(10), target: .session(id: "2"), items: [], note: nil)
        XCTAssertEqual(ShareInbox.entryForOpen(in: [a, b], now: t0.addingTimeInterval(20))?.id, "b")
        XCTAssertNil(ShareInbox.entryForOpen(in: [], now: t0))
    }

    // MARK: text rule

    func testShortTextAndURLsGoToTheComposer() {
        XCTAssertEqual(SharedText.route("hello"), .composerText("hello"))
        let limit = String(repeating: "é", count: 2_000)
        XCTAssertEqual(SharedText.route(limit), .composerText(limit), "2,000 characters, not bytes")
        let longURL = "https://example.com/?q=" + String(repeating: "a", count: 3_000)
        XCTAssertEqual(SharedText.route(longURL, isURL: true), .composerText(longURL))
    }

    func testLongTextBecomesSharedTextTxt() {
        let long = String(repeating: "a", count: 2_001)
        XCTAssertEqual(SharedText.route(long), .attachment(name: "shared-text.txt", data: Data(long.utf8)))
    }

    func testSharedTextAppendsAfterTheDraftWithABlankLine() {
        XCTAssertEqual(SharedText.appending("link", to: ""), "link")
        XCTAssertEqual(SharedText.appending("link", to: "  \n"), "link")
        XCTAssertEqual(SharedText.appending("link", to: "Please read\n"), "Please read\n\nlink")
    }

    // MARK: recent-sessions snapshot

    func testSnapshotRoundTripsThroughANewStoreWithNoToken() throws {
        let snapshot = RecentSessionsSnapshot(sessions: [
            .init(id: "s1", title: "Fix login redirect", workspaceId: "w1", workspaceName: "orbit",
                  updatedAt: t0),
            .init(id: "s2", title: "Docs", workspaceId: "w2", workspaceName: "site",
                  updatedAt: t0.addingTimeInterval(-60)),
        ])
        try RecentSessionsSnapshotStore(root: root).save(snapshot)
        // The extension's side: a separate store over the same container, file access only.
        XCTAssertEqual(RecentSessionsSnapshotStore(root: root).load(), snapshot)

        let updated = RecentSessionsSnapshot(sessions: [snapshot.sessions[1]])
        try RecentSessionsSnapshotStore(root: root).save(updated)
        XCTAssertEqual(RecentSessionsSnapshotStore(root: root).load(), updated)
    }

    func testMissingOrUnreadableSnapshotMeansSignedOut() throws {
        let store = RecentSessionsSnapshotStore(root: root)
        XCTAssertNil(store.load())
        try store.save(RecentSessionsSnapshot(sessions: []))
        XCTAssertNotNil(store.load())
        store.remove()
        XCTAssertNil(store.load())
        try Data("{not json".utf8).write(to: store.file)
        XCTAssertNil(store.load())
    }
}
