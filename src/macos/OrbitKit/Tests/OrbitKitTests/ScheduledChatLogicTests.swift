import Foundation
import XCTest
@testable import OrbitKit

/// The Scheduled page chat on iOS and macOS (docs/scheduled-chat-design.md §3, §4, §6; board scheduled-chat 01 part 4):
/// which chats it lists and opens, what a message carries, when the page shows it, what a schedule's name in a change
/// line does in a column and in a sheet, ‹ Chat, and the Run now buttons an answer offers.
final class ScheduledChatLogicTests: XCTestCase {

    private func session(_ id: String, title: String? = nil, origin: String? = "SCHEDULE_CHAT",
                         status: String = "AWAITING_INPUT", lifecycle: String = "OPEN", lastTurnAt: String,
                         approvals: Int = 0, waitingOn: String? = nil, phase: String? = nil) throws -> Session {
        var json: [String: Any] = [
            "id": id, "status": status, "lifecycleState": lifecycle, "lastTurnAt": lastTurnAt,
            "createdAt": "2026-11-20T08:00:00.000Z", "pendingApprovals": approvals,
        ]
        if let title { json["title"] = title }
        if let origin { json["chatOrigin"] = origin }
        if let waitingOn { json["waitingOn"] = waitingOn }
        if let phase { json["phase"] = phase }
        if lifecycle == "COMPLETED" { json["completedAt"] = lastTurnAt }
        return try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: json))
    }

    // MARK: the chats

    func testTheListReadsOnlyOpenPageChatsNewestFirstAndCountsWhatWaits() throws {
        let rows = [
            try session("s1", title: "Move the audit", lastTurnAt: "2026-11-27T09:00:00.000Z"),
            try session("s2", title: "Wiki chat", origin: "WIKI_CHAT", lastTurnAt: "2026-11-27T11:00:00.000Z"),
            try session("s3", title: nil, lastTurnAt: "2026-11-27T10:00:00.000Z", approvals: 2, phase: "RUNNING"),
            try session("s4", title: "Done", lifecycle: "COMPLETED", lastTurnAt: "2026-11-27T12:00:00.000Z"),
            try session("s5", title: "Plain", origin: nil, lastTurnAt: "2026-11-27T13:00:00.000Z"),
        ]
        let ws = WikiChatWorkspace(id: "w1", name: "dev-box", runner: "Mac mini", online: true)
        let list = ScheduledChatLogic.hostList(sessions: rows, workspace: ws, choices: [ws], waitingCards: 1)
        XCTAssertEqual(list.chats.map(\.sessionId), ["s3", "s1"], "open page chats only, newest spoken in first")
        XCTAssertEqual(list.chats.first?.title, ScheduledChatCopy.title, "an untitled chat is called Scheduled chat")
        XCTAssertEqual(list.fab.needsYou, 3, "the chats' approvals and the cards waiting in them")
        XCTAssertTrue(list.fab.working)
        XCTAssertEqual(list.workspace?.eligible, true, "Runs in shows the default at once")
        XCTAssertEqual(WikiChatLogic.fab(list.fab).state, .needsYou)
    }

    func testTheRowTagIsFromScheduledForAPageChatAlone() {
        XCTAssertEqual(ScheduledChatLogic.originTag("SCHEDULE_CHAT"), "From Scheduled")
        XCTAssertNil(ScheduledChatLogic.originTag("WIKI_CHAT"))
        XCTAssertNil(ScheduledChatLogic.originTag(nil))
    }

    func testTheSessionDecodesItsChatOrigin() throws {
        XCTAssertEqual(try session("s1", lastTurnAt: "2026-11-27T09:00:00.000Z").chatOrigin, "SCHEDULE_CHAT")
        XCTAssertNil(try session("s1", origin: nil, lastTurnAt: "2026-11-27T09:00:00.000Z").chatOrigin)
    }

    func testTheHistoryListsOpenAndCompletedSearchedByTitle() throws {
        let open = [try session("s1", title: "Move the audit", lastTurnAt: "2026-11-27T09:00:00.000Z")]
        let completed = [
            try session("s2", title: "Pause the laptop", lifecycle: "COMPLETED", lastTurnAt: "2026-11-27T10:00:00.000Z"),
            try session("s3", title: "Not a chat", origin: nil, lifecycle: "COMPLETED", lastTurnAt: "2026-11-27T11:00:00.000Z"),
        ]
        XCTAssertEqual(ScheduledChatLogic.history(open: open, completed: completed, query: "").map(\.sessionId), ["s2", "s1"])
        XCTAssertEqual(ScheduledChatLogic.history(open: open, completed: completed, query: " AUDIT ").map(\.sessionId), ["s1"])
        XCTAssertEqual(ScheduledChatLogic.history(open: open, completed: completed, query: "").first?.completed, true)
    }

    func testTheButtonOpensTheChatWithACardThenTheAccountsOpenOneThenTheNewestThenANewOne() {
        let quiet = WikiChatRow(sessionId: "a", open: true)
        let waiting = WikiChatRow(sessionId: "b", open: true, needsYou: 1)
        let done = WikiChatRow(sessionId: "c", open: false, completed: true, needsYou: 3)
        XCTAssertEqual(ScheduledChatLogic.toOpen([quiet, waiting], openID: "z"), "b")
        XCTAssertEqual(ScheduledChatLogic.toOpen([quiet, done], openID: "z"), "z")
        XCTAssertEqual(ScheduledChatLogic.toOpen([quiet, done], openID: nil), "a")
        XCTAssertEqual(ScheduledChatLogic.toOpen([done], openID: nil), WikiChatLogic.newChat)
        XCTAssertEqual(ScheduledChatLogic.toOpen(nil, openID: nil), WikiChatLogic.newChat)
    }

    func testRunsInStartsOnTheFilterElseTheFirstWorkspaceWithAMachine() {
        let a = WikiChatWorkspace(id: "w1", name: "dev-box")
        let b = WikiChatWorkspace(id: "w2", name: "orbit-ws01")
        XCTAssertEqual(ScheduledChatLogic.defaultWorkspace(filter: "w2", choices: [a, b])?.id, "w2")
        XCTAssertEqual(ScheduledChatLogic.defaultWorkspace(filter: "gone", choices: [a, b])?.id, "w1")
        XCTAssertEqual(ScheduledChatLogic.defaultWorkspace(filter: nil, choices: [a, b])?.id, "w1")
        XCTAssertNil(ScheduledChatLogic.defaultWorkspace(filter: nil, choices: []))
    }

    // MARK: what a message carries

    func testAMessageCarriesTheFilterAndTheChipUntilItIsCrossedOut() throws {
        var attachments = WikiChatLogic.Attachments()
        XCTAssertNil(ScheduledChatLogic.context(filter: nil, attachments: attachments))
        XCTAssertEqual(ScheduledChatLogic.context(filter: "w1", attachments: attachments),
                       SchedulePageChatContext(scheduleFilter: "w1"))
        attachments = WikiChatLogic.attach(attachments, .files(ScheduledChatLogic.chip(scheduleID: "sch1", title: "Nightly audit")))
        XCTAssertEqual(ScheduledChatLogic.context(filter: nil, attachments: attachments),
                       SchedulePageChatContext(scheduleId: "sch1"))
        attachments = WikiChatLogic.attach(attachments, .crossFiles)
        XCTAssertNil(ScheduledChatLogic.context(filter: nil, attachments: attachments), "a chip crossed out is not sent")
        // Selecting another row swaps the chip back in.
        attachments = WikiChatLogic.attach(attachments, .files(ScheduledChatLogic.chip(scheduleID: "sch2", title: "Codex check")))
        XCTAssertEqual(ScheduledChatLogic.context(filter: "w1", attachments: attachments)?.scheduleId, "sch2")
    }

    func testTheContextGoesOutAsContextAndNilsAreLeftOut() throws {
        let turn = ComposerLogic.makeTurn(clientTurnId: "t", text: "hi", shell: false, attachmentIds: [],
                                          context: SchedulePageChatContext(scheduleId: "sch1"))
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(turn)) as? [String: Any]
        XCTAssertEqual((body?["context"] as? [String: Any])?["scheduleId"] as? String, "sch1")
        XCTAssertNil((body?["context"] as? [String: Any])?["scheduleFilter"])
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ComposerLogic.makeTurn(clientTurnId: "t", text: "hi", shell: false, attachmentIds: []))) as? [String: Any]
        XCTAssertNil(plain?["context"], "every other session's body is what it was")
        let resume = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ResumeRequest(clientTurnId: "t", content: "hi", context: SchedulePageChatContext(scheduleFilter: "w1")))) as? [String: Any]
        XCTAssertEqual((resume?["context"] as? [String: Any])?["scheduleFilter"] as? String, "w1")
    }

    func testTheDoorsDecodeAndEncode() throws {
        let read = try JSONDecoder().decode(SchedulePageChatResponse.self, from: Data("""
        {"sessionId":null,"opening":{"counts":{"total":4,"active":2,"paused":2,"held":0,"failing":0},"next":null,
         "summary":"You have 4 scheduled tasks: 2 active, 2 paused, none failing.","nextText":null,
         "examplesLead":"Ask about them, or tell me what to change. For example:","examples":["a","b"],"closing":"c"}}
        """.utf8))
        XCTAssertNil(read.sessionId)
        XCTAssertEqual(read.opening.examples, ["a", "b"])
        let answer = try JSONDecoder().decode(SchedulePageChatOpenAnswer.self, from: Data(#"{"sessionId":"s9","created":true}"#.utf8))
        XCTAssertEqual(answer, SchedulePageChatOpenAnswer(sessionId: "s9", created: true))
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SchedulePageChatOpenRequest(workspaceId: "w1", text: "Pause it"))) as? [String: String]
        XCTAssertEqual(body, ["workspaceId": "w1", "text": "Pause it"])
    }

    // MARK: the panel and its navigation (board 4)

    func testThePageShowsTheChatOnlyWhereItIsAColumnAndWasLeftOpen() {
        XCTAssertTrue(ScheduledChatLogic.opensOnPage(sheet: false, remembered: true))
        XCTAssertFalse(ScheduledChatLogic.opensOnPage(sheet: false, remembered: false), "never open by itself")
        XCTAssertFalse(ScheduledChatLogic.opensOnPage(sheet: true, remembered: true), "a phone's sheet never opens on its own")
        XCTAssertFalse(ScheduledChatLogic.opensOnPage(sheet: true, remembered: false))
    }

    func testTheRememberedStateIsKeptPerAccountOnThisDevice() {
        XCTAssertEqual(ScheduledChatLogic.shownKey(account: "user_1"), ScheduledChatLogic.shownKey(account: "user_1"))
        XCTAssertNotEqual(ScheduledChatLogic.shownKey(account: "user_1"), ScheduledChatLogic.shownKey(account: "user_2"))
        XCTAssertTrue(ScheduledChatLogic.shownKey(account: "user_1").hasPrefix("orbit.scheduledChat.shown."))
    }

    func testANameInAChangeLineOpensTheScheduleBesideAColumnAndInPlaceOfASheet() {
        XCTAssertEqual(ScheduledChatLogic.nameTapped("sch1", sheet: false),
                       [.openSchedule(id: "sch1", backToChat: false)], "the column stays; the inspector opens")
        XCTAssertEqual(ScheduledChatLogic.nameTapped("sch1", sheet: true),
                       [.closeChat, .openSchedule(id: "sch1", backToChat: true)],
                       "the sheet folds, then the schedule's own sheet opens with ‹ Chat")
        XCTAssertEqual(ScheduledChatLogic.backToChat(), [.closeSchedule, .openChat])
        XCTAssertEqual(ScheduledChatCopy.back, "Chat")
    }

    // MARK: Run now (design §4.6)

    func testRunNowOffersAreReadFromTheAnswersOncePerScheduleAndMessage() {
        var ask = UserBubble(id: "u1", text: "Run the audit now", turnId: "turn1", pending: false)
        ask.turnId = "turn1"
        var answer = AssistantBubble(id: "a1", text: "", streamingText: "", seq: 4)
        answer.text = "Here: [Run now](orbit-run-now:sch_1). Or [Run now](orbit-run-now:sch_1) and orbit-run-now:sch-2!"
        answer.turnId = "turn1"
        var later = AssistantBubble(id: "a2", text: "", streamingText: "", seq: 9)
        later.text = "No offer here, only orbit-task:abc."
        let offers = ScheduledChatLogic.runNowOffers([.user(ask), .assistant(answer), .assistant(later)])
        XCTAssertEqual(offers.map(\.scheduleID), ["sch_1", "sch-2"])
        XCTAssertEqual(offers.map(\.turnID), ["turn1", "turn1"])
        XCTAssertEqual(Set(offers.map(\.id)).count, 2)
    }

    func testRunNowIsDrawnOnlyForAListedScheduleThatHasNotEnded() {
        func schedule(_ state: String) -> ScheduleView {
            ScheduleView(id: "sch1", title: "Nightly audit", rule: .daily(time: "06:00"), timezone: "UTC",
                         workspaceId: "w1", workspaceName: "dev-box", accessLevel: "CHECK_ONLY", state: state)
        }
        XCTAssertFalse(ScheduledChatLogic.runNowShown(nil), "a link naming no listed schedule draws nothing")
        XCTAssertTrue(ScheduledChatLogic.runNowShown(schedule("ACTIVE")))
        XCTAssertTrue(ScheduledChatLogic.runNowShown(schedule("PAUSED")))
        XCTAssertFalse(ScheduledChatLogic.runNowShown(schedule("ENDED")))
    }
}
