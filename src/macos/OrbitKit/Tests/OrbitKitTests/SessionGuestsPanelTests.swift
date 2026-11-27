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
        // A session that names no mode runs in the account's, else Auto — and so it warns.
        XCTAssertEqual(SessionGuestContext(runnerName: "x", permissionMode: nil).permissionMode, "auto")
        XCTAssertEqual(SessionGuestContext(runnerName: "x", permissionMode: nil, accountDefault: "plan").permissionMode, "plan")
        XCTAssertEqual(SessionGuestContext(runnerName: "x", permissionMode: "default", accountDefault: "auto").permissionMode, "default")
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
        XCTAssertTrue(sheet.contains("api.sessionGuestSuggestions(rootID)"))
        XCTAssertTrue(sheet.contains("self.people?.pick(person)"))
    }

    // MARK: suggestions (board docs/mocks/share-links/14-guest-suggestions)

    private let invitedBefore = [
        SessionGuestSuggestion(name: "Alice Chen", email: "alice@example.com", lastInvitedAt: "2026-11-16T03:00:00.000Z"),
        SessionGuestSuggestion(name: "Paula Ortiz", email: "paula.ortiz@example.com", lastInvitedAt: "2026-11-13T09:00:00.000Z"),
        SessionGuestSuggestion(name: "Sam Wu", email: "sam@example.org", lastInvitedAt: "2026-11-09T09:00:00.000Z"),
        SessionGuestSuggestion(name: "Pat Lee", email: "patlee@example.net", lastInvitedAt: "2026-10-30T09:00:00.000Z"),
        SessionGuestSuggestion(name: "Jo Park", email: "jo@example.com", lastInvitedAt: "2026-10-20T09:00:00.000Z"),
        SessionGuestSuggestion(name: "Max Bell", email: "max@example.com", lastInvitedAt: "2026-10-10T09:00:00.000Z"),
    ]

    func testAnEmptyFieldOffersTheFiveNewest() {
        XCTAssertEqual(SessionGuestSuggestions.matching("  ", in: invitedBefore).map(\.name),
                       ["Alice Chen", "Paula Ortiz", "Sam Wu", "Pat Lee", "Jo Park"])
    }

    func testTypingKeepsWhoseNameOrEmailHasAWordStartingWithIt() {
        XCTAssertEqual(SessionGuestSuggestions.matching("pa", in: invitedBefore).map(\.name),
                       ["Paula Ortiz", "Pat Lee", "Jo Park"], "a name word, an email start")
        XCTAssertEqual(SessionGuestSuggestions.matching("ORTIZ", in: invitedBefore).map(\.name), ["Paula Ortiz"],
                       "case does not matter; an email word after the dot")
        XCTAssertEqual(SessionGuestSuggestions.matching("org", in: invitedBefore).map(\.name), ["Sam Wu"], "the last word of an email")
        XCTAssertEqual(SessionGuestSuggestions.matching("lice", in: invitedBefore), [], "the middle of a word is no match")
        XCTAssertEqual(SessionGuestSuggestions.matching("zz", in: invitedBefore), [])
        XCTAssertEqual(SessionGuestSuggestions.matching("Alice@Example.com", in: invitedBefore), [],
                       "nothing left to fill in")
    }

    func testTheQueryIsBoldWhereItStartsAWord() {
        typealias R = SessionGuestSuggestions.Run
        XCTAssertEqual(SessionGuestSuggestions.runs("Paula Ortiz", query: "pa"), [R("Pa", bold: true), R("ula Ortiz", bold: false)])
        XCTAssertEqual(SessionGuestSuggestions.runs("paula.ortiz@example.com", query: "or"),
                       [R("paula.", bold: false), R("or", bold: true), R("tiz@example.com", bold: false)])
        XCTAssertEqual(SessionGuestSuggestions.runs("Jo Park", query: ""), [R("Jo Park", bold: false)])
    }

    func testTheDateSaysTodayOrTheDay() {
        let utc = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2026-11-16T12:00:00Z")!
        XCTAssertEqual(SessionGuestSuggestions.date("2026-11-16T03:00:00.000Z", now: now, timeZone: utc), "Today")
        XCTAssertEqual(SessionGuestSuggestions.date("2026-11-13T09:00:00.000Z", now: now, timeZone: utc), "Nov 13")
    }

    func testPickingFillsTheEmailAndNeverInvites() {
        var panel = SessionGuestsPanel(context: SessionGuestContext(runnerName: "workstation-gpu", permissionMode: "auto"))
        panel.loaded([])
        panel.suggestionsLoaded(invitedBefore)
        panel.editEmail("pa")
        XCTAssertFalse(panel.pickHighlighted(), "no row highlighted yet: Return invites what was typed")
        panel.moveHighlight(by: 1)
        XCTAssertEqual(panel.highlighted, 0, "↓ goes to the first row")
        panel.moveHighlight(by: 5)
        XCTAssertEqual(panel.highlighted, 2, "the highlight stays within the list")
        panel.moveHighlight(by: -1)
        XCTAssertTrue(panel.pickHighlighted())
        XCTAssertEqual(panel.email, "patlee@example.net")
        XCTAssertEqual(panel.shownSuggestions, [], "the list closes")
        XCTAssertFalse(panel.inviting)
        XCTAssertFalse(panel.canInvite, "a session in Auto still needs the tick")
        XCTAssertFalse(panel.pickHighlighted(), "Return with the list closed invites as before")
        panel.editEmail("")
        XCTAssertEqual(panel.shownSuggestions.count, 5, "editing opens it again")
        panel.closeSuggestions()
        XCTAssertEqual(panel.shownSuggestions, [], "Esc")
    }

    func testTheSuggestionsDecodeAsTheServerAnswers() throws {
        let json = #"{"people":[{"name":"Alice Chen","email":"alice@example.com","lastInvitedAt":"2026-11-16T03:00:00.000Z"}]}"#
        let list = try JSONDecoder().decode(SessionGuestSuggestionList.self, from: Data(json.utf8))
        XCTAssertEqual(list.people, [invitedBefore[0]])
    }
}
