import Foundation
import XCTest
@testable import OrbitKit

/// People who can reply, the Share panel's section for a session (docs/session-guests-design.md §3;
/// board docs/mocks/share-links/10-session-guests-2): what it says, when Invite can be pressed, and the
/// tick the first invite to a session that will not ask needs. Ports web's `ShareModal.people.test.tsx`.
final class SessionGuestsPanelTests: XCTestCase {
    private func person(_ name: String, today: Int = 0, opened: Bool = false) -> SessionGuestPerson {
        SessionGuestPerson(userId: "u-\(name)", name: name, email: "\(name.lowercased())@example.com",
                           addedAt: "2026-11-12T10:00:00.000Z", messagesToday: today, opened: opened)
    }

    func testTheConsequenceNamesTheRunnerAndTheMode() {
        let asks = SessionGuestsCopy.consequence(runnerName: "build-box", permissionMode: "acceptEdits")
        XCTAssertEqual(asks.text, "They can send messages to this session. The agent runs them on build-box as Accept "
            + "edits, using your accounts. Approvals and the agent’s questions still come only to you.")
        XCTAssertFalse(asks.warns)
        let bypass = SessionGuestsCopy.consequence(runnerName: "build-box", permissionMode: "bypassPermissions")
        XCTAssertEqual(bypass.text, "They can send messages to this session. The agent runs them on build-box as Bypass "
            + "permissions, using your accounts — it won’t ask before acting.")
        XCTAssertTrue(bypass.warns)
        for mode in ["auto", "dontAsk"] {
            XCTAssertTrue(SessionGuestsCopy.consequence(runnerName: "x", permissionMode: mode).warns, mode)
        }
        for mode in ["default", "plan", "acceptEdits"] {
            XCTAssertFalse(SessionGuestsCopy.consequence(runnerName: "x", permissionMode: mode).warns, mode)
        }
        // A session that names no mode runs in Default.
        XCTAssertEqual(SessionGuestContext(runnerName: "x", permissionMode: nil).permissionMode, "default")
    }

    func testEachGuestSaysTodaysMessagesOrNotOpenedYet() {
        XCTAssertEqual(SessionGuestsCopy.activity(person("Alice Chen", today: 12, opened: true)), "12 messages today")
        XCTAssertEqual(SessionGuestsCopy.activity(person("Alice Chen", today: 1, opened: true)), "1 message today")
        XCTAssertEqual(SessionGuestsCopy.activity(person("Alice Chen", today: 0, opened: true)), "0 messages today")
        XCTAssertEqual(SessionGuestsCopy.activity(person("Ravi Kumar")), "Not opened yet")
    }

    func testInviteNeedsAnEmailAndSendsItTrimmed() {
        var panel = SessionGuestsPanel(context: SessionGuestContext(runnerName: "build-box", permissionMode: "acceptEdits"))
        panel.loaded([])
        XCTAssertFalse(panel.canInvite)
        XCTAssertNil(panel.beginInvite())
        panel.editEmail("  alice@example.com ")
        XCTAssertFalse(panel.needsAcknowledge, "a session that asks needs no tick")
        XCTAssertEqual(panel.beginInvite(), "alice@example.com")
        XCTAssertFalse(panel.canInvite, "one invite at a time")
        panel.invited([person("Alice Chen")])
        XCTAssertEqual(panel.email, "")
        XCTAssertEqual(panel.guests?.map(\.name), ["Alice Chen"])
    }

    func testARefusalStaysUnderTheFieldUntilTheEmailChanges() {
        var panel = SessionGuestsPanel(context: SessionGuestContext(runnerName: "build-box", permissionMode: "default"))
        panel.loaded([])
        panel.editEmail("bob@example.com")
        _ = panel.beginInvite()
        panel.inviteFailed("No Orbit account uses this email.")
        XCTAssertEqual(panel.error, "No Orbit account uses this email.")
        XCTAssertEqual(panel.email, "bob@example.com", "the email stays to be corrected")
        XCTAssertTrue(panel.canInvite)
        panel.editEmail("bob@example.org")
        XCTAssertNil(panel.error)
    }

    func testTheFirstInviteInAModeThatWontAskNeedsTheTick() {
        var panel = SessionGuestsPanel(context: SessionGuestContext(runnerName: "build-box",
                                                                    permissionMode: "bypassPermissions"))
        XCTAssertFalse(panel.needsAcknowledge, "not before the people are read")
        panel.loaded([])
        panel.editEmail("bob@example.com")
        XCTAssertTrue(panel.needsAcknowledge)
        XCTAssertFalse(panel.canInvite)
        panel.acknowledged = true
        XCTAssertTrue(panel.canInvite)
        // Once somebody can reply, the next invite asks no more.
        var later = SessionGuestsPanel(context: panel.context)
        later.loaded([person("Alice Chen")])
        later.editEmail("bob@example.com")
        XCTAssertFalse(later.needsAcknowledge)
        XCTAssertTrue(later.canInvite)
    }

    func testThePeopleDecodeAsTheServerAnswers() throws {
        let json = #"{"guests":[{"userId":"u1","name":"Alice Chen","email":"alice@example.com","addedAt":"2026-11-12T10:00:00.000Z","messagesToday":12,"opened":true}]}"#
        let list = try JSONDecoder().decode(SessionGuestList.self, from: Data(json.utf8))
        XCTAssertEqual(list.guests, [SessionGuestPerson(userId: "u1", name: "Alice Chen", email: "alice@example.com",
                                                        addedAt: "2026-11-12T10:00:00.000Z", messagesToday: 12,
                                                        opened: true)])
    }

    func testWithNoLinkAccessSaysTheInvitedCanStillReply() {
        XCTAssertEqual(SharePanel(kind: .session, invitesPeople: true).accessDetail,
                       "No public link. People you invite below can still open and reply.")
        XCTAssertEqual(SharePanel(kind: .session).accessDetail, SharePanelCopy.privateDetail)
        XCTAssertEqual(SharePanel(kind: .task, invitesPeople: true).accessDetail, SharePanelCopy.privateDetail,
                       "only a session has people who can reply")
    }

    /// The panel builds the section only for a session, with the line under Access saying the people
    /// below can still reply while no public link is open.
    func testTheSharePanelDrawsPeopleForASessionOnly() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<3 { dir = dir.deletingLastPathComponent() }
        let sheet = try String(contentsOf: dir.appendingPathComponent("OrbitApp/Sources/OrbitApp/Views/ShareSheet.swift"),
                               encoding: .utf8)
        XCTAssertTrue(sheet.contains("kind == .session ? guests.map(SessionGuestsPanel.init(context:)) : nil"))
        XCTAssertTrue(sheet.contains("SharePanel(kind: kind, invitesPeople: guests != nil)"))
        XCTAssertTrue(sheet.contains("api.inviteSessionGuest(rootID, email: email)"))
        XCTAssertTrue(sheet.contains("api.removeSessionGuest(rootID, userID: guest.userId)"))
        XCTAssertTrue(sheet.contains("if people.needsAcknowledge {"))
    }
}
