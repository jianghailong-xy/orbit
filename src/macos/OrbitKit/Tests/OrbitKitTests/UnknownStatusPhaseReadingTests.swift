import Foundation
import XCTest
@testable import OrbitKit

/// A session whose legacy `status` is a word this build does not know reads its phase when the new fields are
/// present (web `runStateFromPhaseFields`), and keeps the old reading when they are absent; the task run label
/// reads the same facts.
final class UnknownStatusPhaseReadingTests: XCTestCase {
    private func session(_ fields: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data("{\"id\":\"s\",\(fields)}".utf8))
    }

    private func run(_ fields: String) throws -> SessionRef {
        try JSONDecoder().decode(SessionRef.self, from: Data("{\"id\":\"r\",\(fields)}".utf8))
    }

    func testHeldUnknownStatusReadsItsPhaseInTheHeaderRowAndGlyph() throws {
        let cases: [(String, String)] = [
            (#""status":"MYSTERY","released":false,"phase":"IDLE""#, "Waiting for your reply"),
            (#""status":"MYSTERY","released":false,"phase":"RUNNING""#, "Running"),
            (#""status":"MYSTERY","released":false,"phase":"PENDING""#, "Queued"),
            (#""status":"MYSTERY","released":false,"phase":"IDLE","lastTurnOutcome":"INTERRUPTED""#, "Interrupted"),
        ]
        for (json, word) in cases {
            let s = try session(json)
            XCTAssertEqual(SessionHeader.statusWord(for: s), word, json)
        }
    }

    func testHeldUnknownStatusDrawsTheGlyphOfItsPhase() throws {
        let twins: [(String, String)] = [
            ("IDLE", #""status":"AWAITING_INPUT""#), ("RUNNING", #""status":"RUNNING""#),
            ("PENDING", #""status":"PENDING""#),
        ]
        for (phase, legacy) in twins {
            let unknown = try session(#""status":"MYSTERY","released":false,"phase":"\#(phase)""#)
            XCTAssertEqual(SessionStatusGlyph.make(for: unknown), SessionStatusGlyph.make(for: try session(legacy)), phase)
        }
        XCTAssertNotEqual(SessionStatusGlyph.make(for: try session(#""status":"MYSTERY""#)),
                          SessionStatusGlyph.make(for: try session(#""status":"AWAITING_INPUT""#)))
    }

    func testHeldUnknownStatusWithActivityTurnReadsRunning() throws {
        XCTAssertEqual(SessionHeader.statusWord(for: try session(#""status":"MYSTERY","released":false,"phase":"RUNNING","activity":"TURN""#)), "Running")
        XCTAssertEqual(SessionHeader.statusWord(for: try session(#""status":"MYSTERY","released":false,"phase":"PENDING","activity":"TURN""#)), "Queued")
    }

    /// Apple resumes a released session whatever the capabilities say about canSend (the server sends both true).
    func testAReleasedSessionResumesWhenCapabilitiesSayBoth() {
        let both = SessionCapabilities(canSend: true, canResume: true, canComplete: true, canRestore: false)
        XCTAssertTrue(ComposerLogic.shouldResume(status: .awaitingInput, released: true, capabilities: both))
        XCTAssertFalse(ComposerLogic.shouldResume(status: .awaitingInput, released: false, capabilities: both))
        XCTAssertTrue(ComposerLogic.shouldResume(status: .failed, released: nil, capabilities: both))
        XCTAssertFalse(ComposerLogic.shouldResume(status: .awaitingInput, released: nil, capabilities: both))
    }

    func testUnknownStatusWithoutTheFieldsKeepsItsOldReading() throws {
        XCTAssertEqual(SessionHeader.statusWord(for: try session(#""status":"MYSTERY""#)), "Ended")
        // `phase` without `released` is not the new fields.
        XCTAssertEqual(SessionHeader.statusWord(for: try session(#""status":"MYSTERY","phase":"IDLE""#)), "Ended")
    }

    func testReleasedUnknownStatusReadsByTheReleaseRules() throws {
        let cases: [(String, String)] = [
            (#""status":"MYSTERY","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED""#, "Failed"),
            (#""status":"MYSTERY","released":true,"phase":"IDLE","endReason":"task_done""#, "Finished"),
            (#""status":"MYSTERY","released":true,"phase":"IDLE","lastTurnOutcome":"ANSWERED""#, "Ended"),
        ]
        for (json, word) in cases {
            XCTAssertEqual(SessionHeader.statusWord(for: try session(json)), word, json)
        }
    }

    func testTaskRunLabelReadsTheSessionFactsAndFallsBack() throws {
        // With the facts: the state word from `phase` and the marks beside it (`SessionDisplay`, the approved board).
        let cases: [(String, String)] = [
            (#""status":"MYSTERY","released":false,"phase":"IDLE""#, "Idle"),
            (#""status":"MYSTERY","released":false,"phase":"RUNNING""#, "Running"),
            (#""status":"MYSTERY","released":false,"phase":"PENDING""#, "Queued"),
            (#""status":"MYSTERY","released":false,"phase":"IDLE","lastTurnOutcome":"INTERRUPTED""#, "Idle"),
            (#""status":"RUNNING","released":true,"phase":"IDLE","endReason":"task_done""#, "Idle"),
            (#""status":"RUNNING","released":true,"phase":"IDLE","lastTurnOutcome":"FAILED""#, "Idle · Failed"),
            (#""status":"RUNNING","released":true,"phase":"IDLE","endReason":"ended","lastTurnOutcome":"FAILED""#, "Idle"),
            // Absent fields: the legacy reading, as before.
            (#""status":"RUNNING""#, "Running"),
            (#""status":"SUCCEEDED""#, "Finished"),
            (#""status":"MYSTERY""#, "Ended"),
            (#""status":"RUNNING","released":true"#, "Running"),
            (#""status":"RUNNING","released":false,"phase":"RUNNING","activity":"TURN""#, "Running"),
            (#""status":"PENDING","released":false,"phase":"PENDING","activity":"TURN""#, "Queued"),
            // A RUNNING phase is Running whatever runs: the engine's own turn, or a job (drawn as a row icon, not a mark).
            (#""status":"AWAITING_INPUT","released":false,"phase":"RUNNING","activity":"TURN""#, "Running"),
            (#""status":"MYSTERY","released":false,"phase":"RUNNING","activity":"TURN""#, "Running"),
            (#""status":"MYSTERY","released":false,"phase":"RUNNING","activity":"BACKGROUND_JOB""#, "Running"),
            (#""status":"AWAITING_INPUT","released":false,"phase":"RUNNING","activity":"BACKGROUND_JOB""#, "Running"),
            // A held queued run is Queued with On hold beside it; a finished or ended run is Idle alone.
            (#""status":"PENDING","released":false,"phase":"PENDING","activity":"TURN","waitingOn":"HOLD""#, "Queued · On hold"),
            (#""status":"SUCCEEDED","released":true,"phase":"IDLE","workFinished":true"#, "Idle"),
            (#""status":"SUCCEEDED","released":true,"phase":"IDLE","lastTurnOutcome":"ANSWERED""#, "Idle"),
        ]
        for (json, label) in cases {
            XCTAssertEqual(ShareMarkdown.runLabel(try run(json)), label, json)
        }
    }
}
