import Foundation
import XCTest
@testable import OrbitKit

/// Where a watch's notification takes you. The server's push for a NOTIFY_USER match names the watch
/// (`watchID`, its UUID) and no session (apiserver `PushService.notifyWatchMatched`); before this, the
/// tap resolved to nothing because `Notifications.intent` only read `sessionID`.
final class WatchDeepLinkTests: XCTestCase {
    private typealias F = WatchFixture

    func testWatchRouteRoundTripsThroughTheURLScheme() {
        XCTAssertEqual(DeepLink.parse(DeepLink.url(for: .watch("4ZcDj8QnWm0KxO4hQ2Hn9V"))),
                       .watch("4ZcDj8QnWm0KxO4hQ2Hn9V"))
        XCTAssertEqual(DeepLink.parse(URL(string: "orbit://watch/4ZcDj8QnWm0KxO4hQ2Hn9V")!),
                       .watch("4ZcDj8QnWm0KxO4hQ2Hn9V"))
        XCTAssertEqual(DeepLink.url(for: .watch("W1")).absoluteString, "orbit://watch/W1")
        XCTAssertNil(DeepLink.parse(URL(string: "orbit://watch")!))   // a watch link names one
    }

    func testAWatchRouteLandsOnFollowing() {
        XCTAssertEqual(AppSection.forRoute(.watch("W1")), .following)
    }

    /// The push as `NotificationManager` hands it over: string values only, so `generation` is gone.
    func testTappingTheServersWatchPushOpensTheWatch() {
        let uuid = "0191f0a4-6c2e-7d3a-9b1e-2f4a5c6d7e8f"
        let userInfo = [Notifications.keyWatch: uuid, "kind": "watch-matched"]
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                            userInfo: userInfo),
                       .open(.watch(uuid)))
    }

    func testASessionAlertStillOpensItsSession() {
        let userInfo = [Notifications.keySession: "s1", Notifications.keyWatch: "w1"]
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                            userInfo: userInfo),
                       .open(.session("s1")))
        XCTAssertNil(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: [:]))
    }

    /// Keyed like the server's push (`watch-<uuid>-<generation>`), so a device that gets both shows one.
    func testTheLocalMatchAlertCollapsesWithTheServersPushAndOpensTheWatch() throws {
        let publicID = PublicID.newToken()
        let uuid = try XCTUnwrap(PublicID.toUUID(publicID))
        let content = Notifications.content(for: .watchMatched(watchID: publicID, generation: 1,
                                                               condition: "All tasks finish"))
        XCTAssertEqual(content.identifier, "watch-\(uuid)-1")
        XCTAssertEqual(content.threadIdentifier, "watch-\(uuid)")
        XCTAssertEqual(content.title, "Watch matched")
        XCTAssertEqual(content.body, "All tasks finish")
        XCTAssertEqual(content.categoryIdentifier, "")
        XCTAssertEqual(content.route, .watch(publicID))
        XCTAssertEqual(Notifications.intent(actionId: "com.apple.UNNotificationDefaultActionIdentifier",
                                            userInfo: content.userInfo),
                       .open(.watch(publicID)))
    }

    func testOnlyANotifyWatchSeenLiveIsAnnouncedWhenItMatches() {
        let seen = PublicID.newToken()
        let previous = [
            F.watch(id: try! XCTUnwrap(PublicID.toUUID(seen)), action: "NOTIFY_USER", observer: nil),
            F.watch(id: "resume"),
            F.watch(id: "old-news", state: "MATCHED", action: "NOTIFY_USER", observer: nil),
        ]
        let current = [
            F.watch(id: seen, state: "MATCHED", action: "NOTIFY_USER", observer: nil, targets: F.tasks(2, met: 2),
                    generation: 1),
            F.watch(id: "resume", state: "MATCHED"),
            F.watch(id: "old-news", state: "MATCHED", action: "NOTIFY_USER", observer: nil),
            F.watch(id: "first-sight", state: "MATCHED", action: "NOTIFY_USER", observer: nil),
        ]
        XCTAssertEqual(WatchDelta.matched(previous: previous, current: current),
                       [.watchMatched(watchID: seen, generation: 1, condition: "All tasks finish")])
        XCTAssertEqual(WatchDelta.matched(previous: [], current: current), [])
    }
}
