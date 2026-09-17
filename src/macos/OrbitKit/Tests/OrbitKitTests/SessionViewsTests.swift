import XCTest
@testable import OrbitKit

final class SessionViewsTests: XCTestCase {

    func testLifecycleViewTitlesAndQueryValues() {
        XCTAssertEqual(SessionView.open.queryValue, "open")
        XCTAssertEqual(SessionView.completed.queryValue, "completed")
        XCTAssertEqual(SessionView.trash.queryValue, "trash")
        XCTAssertEqual(SessionView.open.legacyQueryValue, "active")
        XCTAssertEqual(SessionView.completed.legacyQueryValue, "archived")
        XCTAssertEqual(SessionView.trash.legacyQueryValue, "deleted")
        XCTAssertEqual(SessionView.allCases.map(\.title), ["Open", "Completed", "Trash"])
    }

    /// The console switcher mirrors the web Agent console's views, in order.
    func testPickerCasesMatchWebTabs() {
        XCTAssertEqual(SessionView.pickerCases, [.open, .completed, .trash])
    }

    func testCompletionUsesOneImmediateActionLabel() {
        XCTAssertEqual(SessionCompletionPresentation.actionTitle, "Complete")
    }

    func testSessionListPresentationKeepsRowAndScopeDensityInLockstep() {
        let compact = SessionListPresentation.resolve(isCompactWidth: true)
        let regular = SessionListPresentation.resolve(isCompactWidth: false)

        XCTAssertEqual(compact, .compact)
        XCTAssertFalse(compact.showsPersistentScope)
        XCTAssertEqual(regular, .regular)
        XCTAssertTrue(regular.showsPersistentScope)
    }

    /// An older control plane sends no `currentTurnStartedAt`. Falling back to `lastTurnAt` here is
    /// what the row must never do: that field is rewritten on every state move, so it would print
    /// "just now" against every spinner in the list at once. Bare is the honest answer.
    func testAWorkingRowStaysBareWhenTheServerDoesNotDateTheTurn() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-08-26T12:00:00Z"))
        let running = Session(id: "run", title: "Running", status: .running,
                              agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
                              branch: nil, updatedAt: nil,
                              lastTurnAt: "2026-08-26T11:59:30Z")
        let selfDriven = Session(id: "self", title: "Self-driven", status: .awaitingInput,
                                 agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
                                 branch: nil, updatedAt: nil, engineTurnActive: true,
                                 lastTurnAt: "2026-08-26T11:59:30Z")

        XCTAssertNil(SessionListTime.format(for: running, now: now))
        XCTAssertNil(SessionListTime.format(for: selfDriven, now: now))
    }

    /// The point of the whole field: with several rows spinning at once, this is what separates a
    /// turn that just started from one that has been stuck for forty minutes. Both fixtures carry a
    /// seconds-old `lastTurnAt` — the clock that cannot tell them apart.
    func testAWorkingRowReportsHowLongThisTurnHasBeenGoing() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-08-26T12:00:00Z"))
        let fresh = Session(id: "fresh", title: "Fresh", status: .running,
                            agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
                            branch: nil, updatedAt: nil,
                            lastTurnAt: "2026-08-26T11:59:55Z",
                            currentTurnStartedAt: "2026-08-26T11:59:12Z")
        let wedged = Session(id: "wedged", title: "Wedged", status: .running,
                             agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
                             branch: nil, updatedAt: nil,
                             lastTurnAt: "2026-08-26T11:59:58Z",
                             currentTurnStartedAt: "2026-08-26T11:20:00Z")

        XCTAssertEqual(SessionListTime.format(for: fresh, now: now), "48s")
        XCTAssertEqual(SessionListTime.format(for: wedged, now: now), "40m")
        // Same two rows, one clock apart: lastTurnAt would have called both of them "just now".
        XCTAssertEqual(RelativeTime.format(try XCTUnwrap(fresh.lastTurnAt), now: now), "just now")
        XCTAssertEqual(RelativeTime.format(try XCTUnwrap(wedged.lastTurnAt), now: now), "just now")
    }

    /// A settled row is unaffected: it still dates its last activity, and a stale
    /// `currentTurnStartedAt` left over from a finished turn must not leak into it.
    func testASettledRowIgnoresTheTurnClock() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-08-26T12:00:00Z"))
        let done = Session(id: "done", title: "Done", status: .awaitingInput,
                           agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
                           branch: nil, updatedAt: nil,
                           lastTurnAt: "2026-08-26T11:57:00Z",
                           currentTurnStartedAt: "2026-08-26T11:20:00Z")

        XCTAssertEqual(SessionListTime.format(for: done, now: now), "3m ago")
    }

    func testCompactListTimeRemainsForRowsWithoutWorkingSpinner() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-08-26T12:00:00Z"))
        let idle = Session(id: "idle", title: "Idle", status: .awaitingInput,
                           agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
                           branch: nil, updatedAt: nil,
                           lastTurnAt: "2026-08-26T11:57:00Z")
        let approval = Session(id: "approval", title: "Approval", status: .running,
                               agentId: nil, assignedRunnerId: nil, pendingApprovals: 1,
                               branch: nil, updatedAt: nil,
                               lastTurnAt: "2026-08-26T11:59:30Z")

        XCTAssertEqual(SessionListTime.format(for: idle, now: now), "3m ago")
        XCTAssertEqual(SessionListTime.format(for: approval, now: now), "just now")
    }

    /// The list nests the agent — filtering must read `agent.id`, not the (absent) flat `agentId`.
    func testForAgentFiltersByNestedAgent() throws {
        let json = """
        [{"id":"s1","status":"AWAITING_INPUT","agent":{"id":"a1","name":"dev"}},
         {"id":"s2","status":"SUCCEEDED","agent":{"id":"a2","name":"other"}},
         {"id":"s3","status":"RUNNING","agent":{"id":"a1","name":"dev"}}]
        """
        let sessions = try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        let mine = SessionFilter.forAgent(sessions, agentID: "a1")
        XCTAssertEqual(mine.map(\.id), ["s1", "s3"])   // order preserved, a2 excluded
    }

    func testSessionToleratesMissingAgent() throws {
        let s = try JSONDecoder().decode(Session.self, from: Data(#"{"id":"s1","status":"PENDING"}"#.utf8))
        XCTAssertNil(s.agent)
        XCTAssertTrue(SessionFilter.forAgent([s], agentID: "a1").isEmpty)
    }

    func testRemovingAuthoritativelyMissingSessionIsScopedAndIdempotent() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(#"[{"id":"gone","status":"SUCCEEDED"},{"id":"kept","status":"FAILED"}]"#.utf8)
        )

        let once = SessionFilter.removing("gone", from: sessions)
        XCTAssertEqual(once.map(\.id), ["kept"])
        XCTAssertEqual(SessionFilter.removing("gone", from: once), once)
    }

    /// The removed System list must not strand rows from an older server/cache. Legacy
    /// `source=system` rows remain visible in Active alongside every other active session.
    func testForAgentViewKeepsLegacySystemSessionsOnActive() throws {
        let json = """
        [{"id":"s1","status":"RUNNING","source":"user","agent":{"id":"a1","name":"dev"}},
         {"id":"s2","status":"RUNNING","source":"system","agent":{"id":"a1","name":"dev"}},
         {"id":"s3","status":"PENDING","agent":{"id":"a1","name":"dev"}}]
        """
        let sessions = try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        XCTAssertEqual(
            Set(SessionFilter.forAgent(sessions, agentID: "a1", view: .open).map(\.id)),
            Set(["s1", "s2", "s3"])
        )
        // Completed preserves the server response order.
        XCTAssertEqual(SessionFilter.forAgent(sessions, agentID: "a1", view: .completed).map(\.id), ["s1", "s2", "s3"])
    }

    /// The Agent console orders like web's `AgentView`: pinned first, then most-recent activity
    /// first — a never-run (queued) session ranks by `createdAt`, so a freshly queued session sits
    /// among recent work rather than sinking to the bottom (the server's `NULLS LAST` order).
    func testForAgentViewSortsLikeWebConsole() throws {
        let json = """
        [{"id":"run","status":"RUNNING","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T04:00:00.000Z","lastTurnAt":"2026-07-04T05:00:00.000Z"},
         {"id":"queued","status":"PENDING","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T05:25:00.000Z"},
         {"id":"old","status":"AWAITING_INPUT","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T02:00:00.000Z","lastTurnAt":"2026-07-04T03:00:00.000Z"},
         {"id":"pinned","status":"SUCCEEDED","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T01:00:00.000Z","lastTurnAt":"2026-07-04T01:30:00.000Z",
          "pinnedAt":"2026-07-04T06:00:00.000Z"}]
        """
        let sessions = try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        // Pinned floats first despite being oldest; the queued session (ranked by createdAt 05:25)
        // sits above the running one (lastTurnAt 05:00); the older awaiting session sinks last.
        XCTAssertEqual(
            SessionFilter.forAgent(sessions, agentID: "a1", view: .open).map(\.id),
            ["pinned", "queued", "run", "old"]
        )
    }

    /// Completed preserves the server's order verbatim. The server sorts it by completion time
    /// (newest filed first) and deliberately ignores pinning — but that timestamp
    /// isn't in the list payload, so the client can't reproduce it and must not re-sort (web does
    /// the same: `if view === 'completed' return rows`). This fixture is shaped so the old
    /// `consoleSorted` pass would visibly reorder it — floating the pinned row "b" to the top and
    /// ranking "c" (newest `lastTurnAt`) above "a" — proving Completed bypasses that sort.
    func testForAgentCompletedPreservesServerOrder() throws {
        let json = """
        [{"id":"a","status":"SUCCEEDED","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T00:30:00.000Z","lastTurnAt":"2026-07-04T01:00:00.000Z"},
         {"id":"b","status":"SUCCEEDED","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T00:20:00.000Z","lastTurnAt":"2026-07-04T02:00:00.000Z",
          "pinnedAt":"2026-07-04T06:00:00.000Z"},
         {"id":"c","status":"SUCCEEDED","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T00:10:00.000Z","lastTurnAt":"2026-07-04T09:00:00.000Z"}]
        """
        let sessions = try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        XCTAssertEqual(
            SessionFilter.forAgent(sessions, agentID: "a1", view: .completed).map(\.id),
            ["a", "b", "c"]   // server order held: no pin-floating ("b"), no lastTurnAt re-sort ("c")
        )
    }

    /// Trash (deleted) is activity-ordered client-side like Active — web sorts every
    /// non-Completed view by pinned-first then most-recent activity. (Only Completed, above, is
    /// left in the server's order.) Fixture is in input order oldest-first to prove the re-sort.
    func testForAgentTrashSortsByActivity() throws {
        let json = """
        [{"id":"old","status":"SUCCEEDED","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T01:00:00.000Z","lastTurnAt":"2026-07-04T02:00:00.000Z"},
         {"id":"new","status":"SUCCEEDED","source":"user","agent":{"id":"a1","name":"dev"},
          "createdAt":"2026-07-04T03:00:00.000Z","lastTurnAt":"2026-07-04T09:00:00.000Z"}]
        """
        let sessions = try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        XCTAssertEqual(
            SessionFilter.forAgent(sessions, agentID: "a1", view: .trash).map(\.id),
            ["new", "old"]   // most-recent activity first, unlike the oldest-first input
        )
    }
}
