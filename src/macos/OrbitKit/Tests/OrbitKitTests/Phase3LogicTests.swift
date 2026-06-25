import XCTest
@testable import OrbitKit

final class Phase3LogicTests: XCTestCase {

    private func session(_ id: String, _ status: RunStatus, approvals: Int = 0, title: String? = nil) -> Session {
        Session(id: id, title: title ?? id, status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: approvals, branch: nil, updatedAt: nil)
    }

    // MARK: deep links

    func testDeepLinkRoundTrip() {
        for route: Route in [.active, .session("abc"), .task("t1"), .runner("r9")] {
            XCTAssertEqual(DeepLink.parse(DeepLink.url(for: route)), route)
        }
    }

    func testDeepLinkParsing() {
        XCTAssertEqual(DeepLink.parse(URL(string: "orbit://session/019ef")!), .session("019ef"))
        XCTAssertEqual(DeepLink.parse(URL(string: "orbit://active")!), .active)
        XCTAssertNil(DeepLink.parse(URL(string: "https://session/x")!))   // wrong scheme
        XCTAssertNil(DeepLink.parse(URL(string: "orbit://bogus/x")!))     // unknown host
    }

    // MARK: poll-diff → notification events

    func testNeedsApprovalTransition() {
        let prev = [session("a", .running, approvals: 0)]
        let cur = [session("a", .running, approvals: 2, title: "Fix bug")]
        XCTAssertEqual(SessionDelta.diff(previous: prev, current: cur),
                       [.needsApproval(sessionID: "a", title: "Fix bug", count: 2)])

        // No re-fire when it was already pending.
        XCTAssertTrue(SessionDelta.diff(previous: cur, current: cur).isEmpty)
    }

    func testFocusedSessionIsSkipped() {
        let prev = [session("a", .running, approvals: 0)]
        let cur = [session("a", .running, approvals: 1)]
        XCTAssertTrue(SessionDelta.diff(previous: prev, current: cur, focusedSessionID: "a").isEmpty)
    }

    func testFinishedWhenDroppedFromActiveList() {
        let prev = [session("a", .running)]
        let cur: [Session] = []   // 'a' left the Active list → finished, status unknown
        XCTAssertEqual(SessionDelta.diff(previous: prev, current: cur),
                       [.finished(sessionID: "a", title: "a", status: nil)])
    }

    func testFinishedWithTerminalStatusInSnapshot() {
        let prev = [session("a", .running)]
        let cur = [session("a", .failed)]
        XCTAssertEqual(SessionDelta.diff(previous: prev, current: cur),
                       [.finished(sessionID: "a", title: "a", status: .failed)])
    }

    // MARK: notification content + intent

    func testNotificationContent() {
        let approval = Notifications.content(for: .needsApproval(sessionID: "s1", title: "Deploy", count: 3))
        XCTAssertEqual(approval.identifier, "approval-s1")
        XCTAssertEqual(approval.categoryIdentifier, Notifications.approvalCategory)
        XCTAssertEqual(approval.route, .session("s1"))
        XCTAssertEqual(approval.body, "Deploy — 3 pending")

        let failed = Notifications.content(for: .finished(sessionID: "s2", title: "Migrate", status: .failed))
        XCTAssertEqual(failed.title, "Session failed")
        XCTAssertEqual(failed.identifier, "finished-s2")
    }

    func testNotificationIntent() {
        let ui = ["sessionID": "s1", "kind": "approval"]
        XCTAssertEqual(Notifications.intent(actionId: Notifications.actionAllow, userInfo: ui),
                       .approve(sessionID: "s1", behavior: .allow))
        XCTAssertEqual(Notifications.intent(actionId: Notifications.actionDeny, userInfo: ui),
                       .approve(sessionID: "s1", behavior: .deny))
        XCTAssertEqual(Notifications.intent(actionId: Notifications.actionReply, userInfo: ui, responseText: "ship it"),
                       .reply(sessionID: "s1", text: "ship it"))
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: ui),
                       .open(.session("s1")))
        XCTAssertNil(Notifications.intent(actionId: Notifications.actionReply, userInfo: ui, responseText: "   "))
        XCTAssertNil(Notifications.intent(actionId: Notifications.actionAllow, userInfo: [:]))   // no session
    }

    // MARK: menu-bar summary

    func testMenuBarSummary() {
        let sessions = [
            session("a", .running, approvals: 2, title: "A"),
            session("b", .running, title: "B"),
            session("c", .pending, title: "C"),
            session("d", .succeeded),   // excluded from Active
        ]
        let s = MenuBar.summary(from: sessions)
        XCTAssertEqual(s.needsYou, 1)
        XCTAssertEqual(s.running, 1)
        XCTAssertEqual(s.queued, 1)
        XCTAssertEqual(s.badge, "1")
        // needsYou first, then running; queued/terminal not in quick items.
        XCTAssertEqual(s.items.map(\.id), ["a", "b"])
        XCTAssertEqual(s.items.first?.subtitle, "2 pending approvals")
    }

    func testBadgeCap() {
        XCTAssertNil(MenuBar.badge(0))
        XCTAssertEqual(MenuBar.badge(5), "5")
        XCTAssertEqual(MenuBar.badge(150), "99+")
    }
}
