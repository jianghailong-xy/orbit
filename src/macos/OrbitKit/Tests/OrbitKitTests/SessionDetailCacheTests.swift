import XCTest
@testable import OrbitKit

final class SessionDetailCacheTests: XCTestCase {
    private func session(_ id: String, lifecycle: SessionLifecycleState,
                         capabilities: SessionCapabilities) -> Session {
        Session(id: id, title: "Cold route", status: .succeeded,
                runState: .succeeded, lifecycleState: lifecycle, capabilities: capabilities,
                agentId: "agent-1", assignedRunnerId: "runner-1",
                pendingApprovals: 0, branch: nil, updatedAt: nil)
    }

    func testColdCompletedDetailSuppliesHeaderLifecycleAndComposerCapabilities() {
        let completed = session(
            "completed", lifecycle: .completed,
            capabilities: SessionCapabilities(canSend: true, canResume: true,
                                              canComplete: false, canRestore: true))
        var cache = SessionDetailCache()

        XCTAssertNil(cache.resolve(completed.id, preferring: [], []))
        cache.store(completed)

        let resolved = cache.resolve(completed.id, preferring: [], [])
        XCTAssertEqual(resolved?.effectiveLifecycleState, .completed)
        XCTAssertEqual(SessionHeader.subtitle(for: resolved), "Succeeded · Completed")
        XCTAssertEqual(resolved?.capabilities?.canResume, true)
        XCTAssertEqual(resolved?.capabilities?.canRestore, true)
    }

    func testColdTrashDetailSuppliesBlockedComposerCapabilities() {
        let trash = session(
            "trash", lifecycle: .trash,
            capabilities: SessionCapabilities(canSend: false, canResume: false,
                                              resumeBlockedReason: .trashed,
                                              canComplete: false, canRestore: true))
        var cache = SessionDetailCache()
        cache.store(trash)

        let resolved = cache.resolve(trash.id, preferring: [], [])
        XCTAssertEqual(resolved?.effectiveLifecycleState, .trash)
        XCTAssertEqual(SessionHeader.subtitle(for: resolved), "Succeeded · Trash")
        XCTAssertEqual(resolved?.capabilities?.canSend, false)
        XCTAssertEqual(resolved?.capabilities?.resumeBlockedReason, .trashed)
    }

    func testRefreshedListWinsAndUpdatesCachedFallback() {
        let old = session(
            "session", lifecycle: .completed,
            capabilities: SessionCapabilities(canSend: true, canResume: true,
                                              canComplete: false, canRestore: true))
        let refreshed = session(
            "session", lifecycle: .open,
            capabilities: SessionCapabilities(canSend: false, canResume: false,
                                              resumeBlockedReason: .runnerOffline,
                                              canComplete: true, canRestore: false))
        var cache = SessionDetailCache()
        cache.store(old)

        XCTAssertEqual(cache.resolve(old.id, preferring: [refreshed])?.effectiveLifecycleState, .open)
        cache.reconcile(with: [refreshed])

        let fallback = cache.resolve(old.id, preferring: [])
        XCTAssertEqual(fallback?.effectiveLifecycleState, .open)
        XCTAssertEqual(fallback?.capabilities?.resumeBlockedReason, .runnerOffline)
    }

    func testExactRefreshIsNeededOnlyForCachedRowsMissingFromLoadedLists() {
        let completed = session(
            "completed", lifecycle: .completed,
            capabilities: SessionCapabilities(canSend: true, canResume: true,
                                              canComplete: false, canRestore: true))
        var cache = SessionDetailCache()

        XCTAssertFalse(cache.needsExactRefresh(completed.id, preferring: [], []))
        cache.store(completed)
        XCTAssertTrue(cache.needsExactRefresh(completed.id, preferring: [], []))
        XCTAssertFalse(cache.needsExactRefresh(completed.id, preferring: [completed], []))
    }

    func testFocusedOpenSnapshotBecomesFallbackAndRefreshCandidateAfterListRemoval() {
        let focused = session(
            "focused-open", lifecycle: .open,
            capabilities: SessionCapabilities(canSend: true, canResume: false,
                                              canComplete: true, canRestore: false))
        var cache = SessionDetailCache()

        cache.store(focused) // AppModel.syncConsoleFocus seeds the loaded snapshot.
        XCTAssertFalse(cache.needsExactRefresh(focused.id, preferring: [focused], []))
        XCTAssertTrue(cache.needsExactRefresh(focused.id, preferring: [], []))
        XCTAssertEqual(cache.resolve(focused.id, preferring: [])?.effectiveLifecycleState, .open)
    }

    func testRemoveAndRemoveAllDropOnlyDetailFallbacks() {
        let capabilities = SessionCapabilities(canSend: false, canResume: false,
                                               resumeBlockedReason: .trashed,
                                               canComplete: false, canRestore: true)
        var cache = SessionDetailCache()
        cache.store(session("one", lifecycle: .trash, capabilities: capabilities))
        cache.store(session("two", lifecycle: .trash, capabilities: capabilities))

        cache.remove("one")
        XCTAssertNil(cache.resolve("one", preferring: []))
        XCTAssertNotNil(cache.resolve("two", preferring: []))

        cache.removeAll()
        XCTAssertNil(cache.resolve("two", preferring: []))
    }

    func testNotFoundInvalidationDropsOnlyTheAuthoritativeGhost() {
        let capabilities = SessionCapabilities(canSend: false, canResume: false,
                                               resumeBlockedReason: .trashed,
                                               canComplete: false, canRestore: true)
        var cache = SessionDetailCache()
        cache.store(session("purged", lifecycle: .trash, capabilities: capabilities))
        cache.store(session("still-there", lifecycle: .trash, capabilities: capabilities))

        XCTAssertTrue(cache.invalidateNotFound("purged"))
        XCTAssertNil(cache.resolve("purged", preferring: []))
        XCTAssertNotNil(cache.resolve("still-there", preferring: []))
        XCTAssertFalse(cache.invalidateNotFound("purged"), "a repeated 404 stays idempotent")
    }

    /// The real pair from 2026-09-23: an owner-item push opened a project's coordinator by the UUID
    /// the server stored, the Open list held the row as base62, and the header drew the agent's name.
    /// `AppModel.route(to:)` opens the console under `PublicID.toPublic` of the pushed id — this is
    /// the lookup the header then makes.
    func testAPushedUUIDFindsItsListRowUnderTheSpellingTheRouteOpens() {
        let row = Session(id: "34TYUP5wb87XfuYCInJRY", title: "Codex 多账户：一台机器上登录多个 Codex",
                          status: .awaitingInput, runState: .awaitingInput, lifecycleState: .open,
                          agentId: "agent-1", assignedRunnerId: "runner-1",
                          pendingApprovals: 0, branch: nil, updatedAt: nil)
        let routed = PublicID.toPublic("01a0cc01-771c-767d-846b-8fddfa669490")

        let resolved = SessionDetailCache().resolve(routed, preferring: [row], [])
        XCTAssertEqual(resolved?.id, row.id)
        XCTAssertEqual(SessionHeader.title(for: resolved, fallbackAgent: "orbit"),
                       "Codex 多账户：一台机器上登录多个 Codex")
    }
}
