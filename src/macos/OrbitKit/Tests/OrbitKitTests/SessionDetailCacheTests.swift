import XCTest
@testable import OrbitKit

final class SessionDetailCacheTests: XCTestCase {
    private func session(_ id: String, filing: SessionFilingState,
                         capabilities: SessionCapabilities) -> Session {
        Session(id: id, title: "Cold route", status: .succeeded,
                runState: .succeeded, filingState: filing, capabilities: capabilities,
                agentId: "agent-1", assignedRunnerId: "runner-1",
                pendingApprovals: 0, branch: nil, updatedAt: nil)
    }

    func testColdArchivedDetailSuppliesHeaderFilingAndComposerCapabilities() {
        let archived = session(
            "archived", filing: .archived,
            capabilities: SessionCapabilities(canSend: true, canResume: true,
                                              canArchive: false, canRestore: true))
        var cache = SessionDetailCache()

        XCTAssertNil(cache.resolve(archived.id, preferring: [], []))
        cache.store(archived)

        let resolved = cache.resolve(archived.id, preferring: [], [])
        XCTAssertEqual(resolved?.effectiveFilingState, .archived)
        XCTAssertEqual(SessionHeader.subtitle(for: resolved), "Succeeded · Archived")
        XCTAssertEqual(resolved?.capabilities?.canResume, true)
        XCTAssertEqual(resolved?.capabilities?.canRestore, true)
    }

    func testColdTrashDetailSuppliesBlockedComposerCapabilities() {
        let trash = session(
            "trash", filing: .trash,
            capabilities: SessionCapabilities(canSend: false, canResume: false,
                                              resumeBlockedReason: .trashed,
                                              canArchive: false, canRestore: true))
        var cache = SessionDetailCache()
        cache.store(trash)

        let resolved = cache.resolve(trash.id, preferring: [], [])
        XCTAssertEqual(resolved?.effectiveFilingState, .trash)
        XCTAssertEqual(SessionHeader.subtitle(for: resolved), "Succeeded · Trash")
        XCTAssertEqual(resolved?.capabilities?.canSend, false)
        XCTAssertEqual(resolved?.capabilities?.resumeBlockedReason, .trashed)
    }

    func testRefreshedListWinsAndUpdatesCachedFallback() {
        let old = session(
            "session", filing: .archived,
            capabilities: SessionCapabilities(canSend: true, canResume: true,
                                              canArchive: false, canRestore: true))
        let refreshed = session(
            "session", filing: .open,
            capabilities: SessionCapabilities(canSend: false, canResume: false,
                                              resumeBlockedReason: .runnerOffline,
                                              canArchive: true, canRestore: false))
        var cache = SessionDetailCache()
        cache.store(old)

        XCTAssertEqual(cache.resolve(old.id, preferring: [refreshed])?.effectiveFilingState, .open)
        cache.reconcile(with: [refreshed])

        let fallback = cache.resolve(old.id, preferring: [])
        XCTAssertEqual(fallback?.effectiveFilingState, .open)
        XCTAssertEqual(fallback?.capabilities?.resumeBlockedReason, .runnerOffline)
    }

    func testExactRefreshIsNeededOnlyForCachedRowsMissingFromLoadedLists() {
        let archived = session(
            "archived", filing: .archived,
            capabilities: SessionCapabilities(canSend: true, canResume: true,
                                              canArchive: false, canRestore: true))
        var cache = SessionDetailCache()

        XCTAssertFalse(cache.needsExactRefresh(archived.id, preferring: [], []))
        cache.store(archived)
        XCTAssertTrue(cache.needsExactRefresh(archived.id, preferring: [], []))
        XCTAssertFalse(cache.needsExactRefresh(archived.id, preferring: [archived], []))
    }

    func testRemoveAndRemoveAllDropOnlyDetailFallbacks() {
        let capabilities = SessionCapabilities(canSend: false, canResume: false,
                                               resumeBlockedReason: .trashed,
                                               canArchive: false, canRestore: true)
        var cache = SessionDetailCache()
        cache.store(session("one", filing: .trash, capabilities: capabilities))
        cache.store(session("two", filing: .trash, capabilities: capabilities))

        cache.remove("one")
        XCTAssertNil(cache.resolve("one", preferring: []))
        XCTAssertNotNil(cache.resolve("two", preferring: []))

        cache.removeAll()
        XCTAssertNil(cache.resolve("two", preferring: []))
    }
}
