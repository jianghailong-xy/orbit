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
