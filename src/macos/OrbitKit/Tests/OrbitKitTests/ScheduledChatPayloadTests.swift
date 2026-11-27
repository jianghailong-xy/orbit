import Foundation
import XCTest
@testable import OrbitKit

/// The Scheduled page chat's reads exactly as this branch's apiserver answered them (Tests/Fixtures/scheduled-chat, see
/// its README), decoded into the types the Apple panel uses: Orbit's opening and the open chat, the open answer, the
/// Open list's rows with `chatOrigin` (plain and as the clients read it, `{full, sessions, cursor}`), and the schedule
/// list the Run now card is titled from.
final class ScheduledChatPayloadTests: XCTestCase {

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String { "Fixtures/scheduled-chat/\(file) was not found: if it moved, move this test with it." }
    }

    private func fixture(_ name: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<4 {
            let candidate = dir.appendingPathComponent("Fixtures/scheduled-chat/\(name)")
            if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: name)
    }

    func testTheOpeningAndTheOpenChat() throws {
        let read = try JSONDecoder().decode(SchedulePageChatResponse.self, from: fixture("get-schedules-chat.json"))
        XCTAssertEqual(read.sessionId, "354zfIXDCMY10mXloUYjO")
        XCTAssertEqual(read.opening.summary, "You have 4 scheduled tasks: 2 active, 2 paused, none failing.")
        XCTAssertEqual(read.opening.nextText, "Next: Codex stable check, today at 06:00 on apiserver.")
        XCTAssertEqual(read.opening.examplesLead, "Ask about them, or tell me what to change. For example:")
        XCTAssertEqual(read.opening.examples.count, 3)
        XCTAssertTrue(read.opening.closing.hasPrefix("Moving a time"))
    }

    func testTheOpenAnswerNamesTheSameChat() throws {
        let answer = try JSONDecoder().decode(SchedulePageChatOpenAnswer.self, from: fixture("post-schedules-chat.json"))
        let read = try JSONDecoder().decode(SchedulePageChatResponse.self, from: fixture("get-schedules-chat.json"))
        XCTAssertTrue(answer.created)
        XCTAssertEqual(answer.sessionId, read.sessionId)
    }

    func testTheOpenListsRowsCarryThePageChatsOrigin() throws {
        let rows = try JSONDecoder().decode([Session].self, from: fixture("session-rows.json"))
        XCTAssertEqual(rows.count, 2)
        let chat = try XCTUnwrap(rows.first { $0.chatOrigin == "SCHEDULE_CHAT" })
        XCTAssertEqual(chat.title, "What runs tomorrow?")
        XCTAssertEqual(ScheduledChatLogic.originTag(chat.chatOrigin), "From Scheduled")
        XCTAssertNil(ScheduledChatLogic.originTag(rows.first { $0.id != chat.id }?.chatOrigin), "an ordinary session has no tag")

        let list = ScheduledChatLogic.hostList(sessions: rows, workspace: nil, choices: [])
        XCTAssertEqual(list.chats.map(\.sessionId), [chat.id], "the panel lists the page chat alone")
        let read = try JSONDecoder().decode(SchedulePageChatResponse.self, from: fixture("get-schedules-chat.json"))
        XCTAssertEqual(ScheduledChatLogic.toOpen(list.chats, openID: read.sessionId), chat.id, "the button opens it")
    }

    func testTheOpenListAsTheClientsReadIt() throws {
        let read = try OpenListRead.decode(try fixture("session-rows-since.json"), with: JSONDecoder())
        guard case .full(let rows, let cursor) = read else { return XCTFail("a since=0 read is the whole list") }
        XCTAssertNotNil(cursor)
        XCTAssertEqual(rows.filter(ScheduledChatLogic.isScheduledChat).map(\.title), ["What runs tomorrow?"])
    }

    func testRunNowIsTitledFromTheServersList() throws {
        let list = try JSONDecoder().decode(ScheduleListResponse.self, from: fixture("get-schedules.json"))
        XCTAssertEqual(list.schedules.count, 4)
        let audit = try XCTUnwrap(list.schedules.first { $0.title == "Nightly dependency audit" })
        var answer = AssistantBubble(id: "a1", text: "", streamingText: "", seq: 3)
        answer.text = "[Run now](orbit-run-now:\(audit.id))"
        answer.turnId = "t1"
        let cards = ScheduledChatLogic.runNowCards([.assistant(answer)], chatOrigin: "SCHEDULE_CHAT", schedules: list.schedules)
        XCTAssertEqual(cards.map(\.title), ["Nightly dependency audit"])
        XCTAssertEqual(cards.first?.scheduleID, audit.id)
    }
}
