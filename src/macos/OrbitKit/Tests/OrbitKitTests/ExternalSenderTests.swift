import Foundation
import XCTest
@testable import OrbitKit

/// A connected Feishu group's member who sent a turn is drawn as `From Feishu · <name>`
/// (docs/feishu-bot-design.md §8.2), and a guest the owner invited as `From <name>`
/// (docs/session-guests-design.md §3): over the bubble in the conversation, and in front of the words on
/// the session row. Ports the web's `Transcript.externalSender.test.tsx` and
/// `WorkspaceView.sessionLine.test.tsx` cases, and holds the words to the web's own source: a missing
/// counterpart is a failure, never an `XCTSkip`.
final class ExternalSenderTests: XCTestCase {

    // MARK: - Reading a sender

    func testReadsAFeishuSenderAndNothingElse() {
        XCTAssertEqual(ExternalSender.parse(.object(["source": .string("FEISHU"), "name": .string(" Li Lei ")])),
                       ExternalMessageFrom(name: "Li Lei"))
        XCTAssertEqual(ExternalSender.parse(.object(["source": .string("FEISHU"), "name": .null])),
                       ExternalMessageFrom(name: nil))
        XCTAssertEqual(ExternalSender.parse(.object(["source": .string("FEISHU"), "name": .string("  ")])),
                       ExternalMessageFrom(name: nil))
        XCTAssertEqual(ExternalSender.parse(.object(["source": .string("FEISHU")])), ExternalMessageFrom(name: nil))
        for bad: JSONValue? in [nil, .null, .string("FEISHU"), .object(["source": .string("SLACK"), "name": .string("x")]),
                                .object(["name": .string("Li Lei")])] {
            XCTAssertNil(ExternalSender.parse(bad), "read a sender out of \(String(describing: bad))")
        }
    }

    func testReadsAGuestOnlyWithTheirName() {
        XCTAssertEqual(ExternalSender.parse(.object(["source": .string("ORBIT_GUEST"), "name": .string(" Alice Chen ")])),
                       ExternalMessageFrom(source: "ORBIT_GUEST", name: "Alice Chen"))
        // A guest is an Orbit account, which always has a name: one without it is no guest this build can name.
        for bad: JSONValue in [.object(["source": .string("ORBIT_GUEST"), "name": .null]),
                               .object(["source": .string("ORBIT_GUEST"), "name": .string("  ")]),
                               .object(["source": .string("ORBIT_GUEST")])] {
            XCTAssertNil(ExternalSender.parse(bad), "read a guest out of \(bad)")
        }
    }

    func testTheGuestsLabelIsFromAndTheirName() {
        XCTAssertEqual(ExternalSender.label(ExternalMessageFrom(source: "ORBIT_GUEST", name: "Alice Chen")), "From Alice Chen")
    }

    func testTheLabelNamesTheSenderOrSaysFeishuAlone() {
        XCTAssertEqual(ExternalSender.label(ExternalMessageFrom(name: "Li Lei")), "From Feishu · Li Lei")
        XCTAssertEqual(ExternalSender.label(ExternalMessageFrom(name: nil)), "From Feishu")
    }

    // MARK: - The session row

    private func row(_ extra: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(
            #"{"id":"s1","status":"RUNNING","lastUserText":"Fix **the build**"\#(extra)}"#.utf8))
    }

    func testTheRowNamesAFeishuSenderInsteadOfYou() throws {
        let named = try row(#","lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"}"#)
        XCTAssertEqual(named.lastUserFromExternal, ExternalMessageFrom(name: "Li Lei"))
        XCTAssertEqual(SessionLine.make(for: named, live: true),
                       SessionLine(text: "From Feishu · Li Lei: Fix the build", tone: .preview))
        let unnamed = try row(#","lastUserFromExternal":{"source":"FEISHU","name":null}"#)
        XCTAssertEqual(SessionLine.make(for: unnamed, live: true).text, "From Feishu: Fix the build")
        // After the turn stopped, the same line.
        let stopped = try JSONDecoder().decode(Session.self, from: Data(
            #"{"id":"s1","status":"INTERRUPTED","lastUserText":"Fix it","lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"}}"#.utf8))
        XCTAssertEqual(SessionLine.make(for: stopped, live: true).text, "From Feishu · Li Lei: Fix it")
    }

    func testTheRowNamesAGuestInsteadOfYou() throws {
        let guest = try row(#","lastUserFromExternal":{"source":"ORBIT_GUEST","name":"Alice Chen"}"#)
        XCTAssertEqual(guest.lastUserFromExternal, ExternalMessageFrom(source: "ORBIT_GUEST", name: "Alice Chen"))
        XCTAssertEqual(SessionLine.make(for: guest, live: true),
                       SessionLine(text: "From Alice Chen: Fix the build", tone: .preview))
        let stopped = try JSONDecoder().decode(Session.self, from: Data(
            #"{"id":"s1","status":"SUCCEEDED","lastUserText":"Twice is fine","lastUserFromExternal":{"source":"ORBIT_GUEST","name":"Alice Chen"}}"#.utf8))
        XCTAssertEqual(SessionLine.make(for: stopped, live: true).text, "From Alice Chen: Twice is fine")
        // Nameless, it reads as the turn always has rather than failing the row.
        let nameless = try row(#","lastUserFromExternal":{"source":"ORBIT_GUEST","name":null}"#)
        XCTAssertNil(nameless.lastUserFromExternal)
        XCTAssertEqual(SessionLine.make(for: nameless, live: true).text, "You: Fix the build")
        let again = try JSONDecoder().decode(Session.self, from: try JSONEncoder().encode(guest))
        XCTAssertEqual(again.lastUserFromExternal, guest.lastUserFromExternal)
    }

    func testTheRowToleratesAnOlderOrAnOddServer() throws {
        XCTAssertNil(try row("").lastUserFromExternal)
        XCTAssertNil(try row(#","lastUserFromExternal":null"#).lastUserFromExternal)
        XCTAssertNil(try row(#","lastUserFromExternal":{"source":"SLACK","name":"x"}"#).lastUserFromExternal)
        XCTAssertNil(try row(#","lastUserFromExternal":"Li Lei""#).lastUserFromExternal)
        XCTAssertEqual(SessionLine.make(for: try row(""), live: true).text, "You: Fix the build")
    }

    func testTheOutsidersLineIsTheLabelAndNothingForAnybodyElse() {
        XCTAssertEqual(SessionLine.externalLine("Fix **it**", ExternalMessageFrom(name: "Li Lei")),
                       SessionLine(text: "From Feishu · Li Lei: Fix it", tone: .preview))
        XCTAssertNil(SessionLine.externalLine("Fix it", nil))
        // Both of the row's pending-message lines ask Orbit, then the outsider, then the sentence that names
        // another session or "You" — the order the web's `orbitLine(s) ?? sentLine(…, sentBy(s))` asks in.
        let swift = try? String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/OrbitKit/App/SessionLine.swift").standardizedFileURL, encoding: .utf8)
        XCTAssertEqual(swift?.components(separatedBy:
            "return orbitLine(u, s.lastUserFromOrbit) ?? externalLine(u, s.lastUserFromExternal) ?? sentLine(u, from: s.lastUserFrom) }")
            .count, 3, "SessionLine.swift no longer asks the outsider between Orbit and the sentence on both lines")
    }

    func testAnEventKeepsTheSenderBesideTheMessage() throws {
        let named = try row(#","lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"}"#)
        XCTAssertEqual(named.settingTitle("Renamed").lastUserFromExternal, named.lastUserFromExternal)
        XCTAssertEqual(named.settingPendingApprovals(1).lastUserFromExternal, named.lastUserFromExternal)
        let again = try JSONDecoder().decode(Session.self, from: try JSONEncoder().encode(named))
        XCTAssertEqual(again.lastUserFromExternal, named.lastUserFromExternal)
    }

    /// The four senders a row names, each as the server's `pendingMessageColumns` gives it (at most one):
    /// Orbit, a Feishu group member, another Orbit session, and the owner.
    func testTheRowNamesEachOfTheFourSenders() throws {
        func line(_ extra: String) throws -> String {
            SessionLine.make(for: try row(extra), live: true).text
        }
        XCTAssertEqual(try line(#","lastUserFromOrbit":{"coordinatorDelivery":null}"#), "Orbit: Fix the build")
        XCTAssertEqual(try line(#","lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"}"#),
                       "From Feishu · Li Lei: Fix the build")
        XCTAssertEqual(try line(#","lastUserFrom":{"sessionId":"s2","title":"Build the package"}"#),
                       "Build the package: Fix the build")
        XCTAssertEqual(try line(""), "You: Fix the build")
        // Should two ever arrive together, the row asks in the web's order (`orbitLine(s) ?? sentLine(…, sentBy(s))`,
        // and `sentBy` asks the outsider before the session).
        XCTAssertEqual(try line(#","lastUserFromOrbit":{"coordinatorDelivery":null},"lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"}"#),
                       "Orbit: Fix the build")
        XCTAssertEqual(try line(#","lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"},"lastUserFrom":{"sessionId":"s2","title":"Build"}"#),
                       "From Feishu · Li Lei: Fix the build")
    }

    /// Both marks ride beside the message through every fold of a row, and a re-read without them clears both.
    func testBothMarksAreKeptAndClearedWithTheMessage() throws {
        let both = try row(#","lastUserFromOrbit":{"coordinatorDelivery":null},"lastUserFromExternal":{"source":"FEISHU","name":"Li Lei"}"#)
        for folded in [both.settingTitle("Renamed"), both.settingPendingApprovals(2),
                       try JSONDecoder().decode(Session.self, from: try JSONEncoder().encode(both))] {
            XCTAssertEqual(folded.lastUserFromOrbit, OrbitMessageFrom())
            XCTAssertEqual(folded.lastUserFromExternal, ExternalMessageFrom(name: "Li Lei"))
        }
        let cleared = try JSONDecoder().decode(Session.self, from: Data(
            #"{"id":"s1","status":"RUNNING","lastUserText":null,"lastUserFromOrbit":null,"lastUserFromExternal":null}"#.utf8))
        XCTAssertNil(cleared.lastUserFromOrbit)
        XCTAssertNil(cleared.lastUserFromExternal)
    }

    func testTheWebAsksOrbitBeforeTheOtherSenders() throws {
        let row = try source(Self.webRow)
        XCTAssertEqual(row.components(separatedBy: "return orbitLine(s) ?? sentLine(s.lastUserText, sentBy(s));").count - 1, 2,
                       "the web's two pending-message lines no longer ask Orbit first, then sentBy")
    }

    // MARK: - The conversation

    private func echo(_ sender: String?) throws -> RunEvent {
        let extra = sender.map { #", "externalSender": \#($0)"# } ?? ""
        let json = """
            {"seq": 4, "type": "user", "turnId": "turn-f", "ts": "2026-11-08T01:00:00.000Z",
             "payload": {"text": "Fix the build"\(extra)}}
            """
        return try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private func bubble(_ reducer: TranscriptReducer) throws -> UserBubble {
        try XCTUnwrap(reducer.state.items.first.flatMap { item -> UserBubble? in
            guard case .user(let b) = item else { return nil }
            return b
        })
    }

    func testTheBubbleCarriesTheSenderTheEchoRecorded() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(#"{"source": "FEISHU", "name": "Li Lei"}"#))
        let b = try bubble(reducer)
        XCTAssertEqual(b.externalSender, ExternalMessageFrom(name: "Li Lei"))
        XCTAssertEqual(b.text, "Fix the build", "still the sender's words, in a bubble")
        XCTAssertNil(b.sessionMessage)
    }

    func testTheBubbleCarriesTheGuestTheEchoRecorded() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(#"{"source": "ORBIT_GUEST", "name": "Alice Chen"}"#))
        let b = try bubble(reducer)
        XCTAssertEqual(b.externalSender, ExternalMessageFrom(source: "ORBIT_GUEST", name: "Alice Chen"))
        XCTAssertEqual(b.externalSender.map(ExternalSender.label), "From Alice Chen")
        XCTAssertEqual(b.text, "Fix the build")
        let back = try JSONDecoder().decode(UserBubble.self, from: try JSONEncoder().encode(b))
        XCTAssertEqual(back.externalSender, b.externalSender)
    }

    func testTheOwnersOwnMessageCarriesNoSender() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(nil))
        XCTAssertNil(try bubble(reducer).externalSender)
    }

    func testTheEchoOfAPendingBubbleTakesTheSender() throws {
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "local", text: "Fix the build")
        reducer.setOptimisticTurnId(clientTurnId: "local", turnId: "turn-f")
        reducer.apply(try echo(#"{"source": "FEISHU", "name": null}"#))
        XCTAssertEqual(reducer.state.items.count, 1)
        XCTAssertEqual(try bubble(reducer).externalSender, ExternalMessageFrom(name: nil))
    }

    func testASnapshotRoundTripsTheSenderAndAnOlderOneStillRehydrates() throws {
        let old = try JSONDecoder().decode(UserBubble.self, from: Data(#"{"id": "u1", "text": "hi", "pending": false}"#.utf8))
        XCTAssertNil(old.externalSender)
        let held = UserBubble(id: "u2", text: "hi", pending: false, externalSender: ExternalMessageFrom(name: "Li Lei"))
        let back = try JSONDecoder().decode(UserBubble.self, from: try JSONEncoder().encode(held))
        XCTAssertEqual(back.externalSender, held.externalSender)
    }

    // MARK: - The web's own words

    private static let webLib = "src/web/src/lib/externalSender.ts"
    private static let webRow = "src/web/src/components/WorkspaceView.tsx"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(ExternalSenderTests.webLib) was not found above this test file. The Feishu sender line "
                    + "is one half of a pair; if the web half moved, move this check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Point this check at its new home, or this client is mirroring "
                    + "something that no longer exists."
            }
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webLib).path) {
                let url = dir.appendingPathComponent(relative)
                guard FileManager.default.fileExists(atPath: url.path) else { throw ParityError.missing(relative) }
                return try String(contentsOf: url, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`.
        throw ParityError.noRepo
    }

    func testTheWordsAreTheWebsOwn() throws {
        let lib = try source(Self.webLib)
        XCTAssertTrue(lib.contains("export const EXTERNAL_SENDER_FROM_FEISHU = '\(ExternalSender.fromFeishu)';"),
                      "the web's EXTERNAL_SENDER_FROM_FEISHU drifted from \(ExternalSender.fromFeishu.debugDescription)")
        XCTAssertTrue(lib.contains("export const EXTERNAL_SENDER_NAME_SEPARATOR = '\(ExternalSender.nameSeparator)';"),
                      "the web's EXTERNAL_SENDER_NAME_SEPARATOR drifted from \(ExternalSender.nameSeparator.debugDescription)")
        XCTAssertTrue(lib.contains("from.source !== '\(ExternalSender.feishuSource)'"),
                      "the web reads another source than \(ExternalSender.feishuSource)")
        XCTAssertTrue(lib.contains("export const EXTERNAL_SENDER_FROM_GUEST = '\(ExternalSender.fromGuest)';"),
                      "the web's EXTERNAL_SENDER_FROM_GUEST drifted from \(ExternalSender.fromGuest.debugDescription)")
        // A guest: read only with a name, and labelled `From <name>`.
        XCTAssertTrue(lib.contains(
            "if (from.source === '\(ExternalSender.guestSource)') return name ? { source: '\(ExternalSender.guestSource)', name } : null;"),
                      "the web reads a guest by another rule")
        XCTAssertTrue(lib.contains(
            "if (from.source === '\(ExternalSender.guestSource)') return `${EXTERNAL_SENDER_FROM_GUEST} ${from.name}`;"),
                      "the web's guest label changed shape")
        // The label: the name after the separator, or the source's words alone.
        XCTAssertTrue(lib.contains(
            "return from.name ? `${EXTERNAL_SENDER_FROM_FEISHU}${EXTERNAL_SENDER_NAME_SEPARATOR}${from.name}` : EXTERNAL_SENDER_FROM_FEISHU;"),
                      "the web's externalSenderLabel changed shape")
    }

    func testTheWebDrawsItInTheSamePlaces() throws {
        // The row: the outsider is asked before the other session, and named by the label.
        let row = try source(Self.webRow)
        XCTAssertTrue(row.contains("const outsider = parseExternalSender(s.lastUserFromExternal);"),
                      "the web's row no longer reads lastUserFromExternal")
        XCTAssertTrue(row.contains("if (outsider) return externalSenderLabel(outsider);"),
                      "the web's row no longer names the outsider by the label")
        let outsider = try XCTUnwrap(row.range(of: "parseExternalSender(s.lastUserFromExternal)"))
        let session = try XCTUnwrap(row.range(of: "const from = s.lastUserFrom;"))
        XCTAssertLessThan(outsider.lowerBound, session.lowerBound, "the web no longer asks the outsider first")
        // The conversation: the `user` event's `externalSender`, as a line over the bubble.
        let transcript = try source(Self.webTranscript)
        XCTAssertTrue(transcript.contains("parseExternalSender(p.externalSender)"),
                      "the web's transcript no longer reads the echo's externalSender")
        XCTAssertTrue(transcript.contains("externalSenderLabel(node.externalSender)"),
                      "the web's bubble no longer heads itself with the label")
    }
}
