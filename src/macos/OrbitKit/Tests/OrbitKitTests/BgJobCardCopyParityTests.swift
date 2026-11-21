import Foundation
import XCTest
@testable import OrbitKit

/// The Job card says what the web's says, word for word (`src/web/src/lib/bgJobCard.ts`,
/// `components/JobCard.tsx`). The two share no compiler, so this is what holds them together; a missing
/// web half is a failure, never a skip.
final class BgJobCardCopyParityTests: XCTestCase {
    private static let webLib = "src/web/src/lib/bgJobCard.ts"
    private static let webCard = "src/web/src/components/JobCard.tsx"
    private static let webTray = "src/web/src/components/BackgroundShellsTray.tsx"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"
    private static let webWorkspace = "src/web/src/components/WorkspaceView.tsx"

    private struct Missing: Error, CustomStringConvertible {
        let what: String
        var description: String {
            "\(what) was not found. If it moved, point this check at its new home rather than deleting it."
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) {
                // Literals put back together where TypeScript wrapped them.
                return try String(contentsOf: url, encoding: .utf8)
                    .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(what: relative)
    }

    private func section(_ text: String, from: String, to: String) throws -> String {
        guard let start = text.range(of: from), let end = text.range(of: to, range: start.upperBound..<text.endIndex) else {
            throw Missing(what: "\(from) … \(to)")
        }
        return String(text[start.lowerBound..<end.lowerBound])
    }

    private func assertHas(_ text: String, _ value: String, _ file: String, line: UInt = #line) {
        XCTAssertTrue(text.contains(value), "\(file) no longer has \(value.debugDescription)", line: line)
    }

    func testTheToolAndTheReceiptAreReadTheSame() throws {
        let lib = try source(Self.webLib)
        assertHas(lib, "export const BG_RUN_TOOL = '\(BgJobCard.toolName)';", Self.webLib)
        assertHas(lib, "name === 'Bash' &&", Self.webLib)
        assertHas(lib, "id.startsWith('bgj_') &&", Self.webLib)
        assertHas(lib, "(input as Record<string, unknown>).run_in_background === true", Self.webLib)
    }

    /// R3: who stopped a killed job, one line per reason, in the same words.
    func testWhoStoppedAJobIsSaidInTheSameWords() throws {
        let lib = try source(Self.webLib)
        let killed = try section(lib, from: "export function killedByLine(", to: "\n}")
        for reason in ["requested", "stopped_by_owner", "runner_shutdown", "session_cancelled", "not_allowed"] {
            let line = try XCTUnwrap(BgJobCard.killedBy(reason), reason)
            assertHas(killed, "case '\(reason)':", Self.webLib)
            XCTAssertTrue(killed.contains("'\(line)'") || killed.contains("\"\(line)\""),
                          "\(Self.webLib) no longer says \(line.debugDescription) for \(reason)")
        }
        assertHas(killed, "case 'stop':", Self.webLib)
    }

    func testTheCardsWordsAreTheWebCards() throws {
        let card = try source(Self.webCard)
        assertHas(card, "Show full output", Self.webCard)
        assertHas(card, "Show all {lines.length} lines", Self.webCard)
        XCTAssertEqual(BgJobCard.showAll(214), "Show all 214 lines")
        assertHas(card, "Woke the agent {wakes.length} {wakes.length === 1 ? 'time' : 'times'}", Self.webCard)
        XCTAssertEqual(BgJobCard.wokeHead(1), "Woke the agent 1 time")
        assertHas(card, "<summary>\(BgJobCard.rawSummary)</summary>", Self.webCard)
        assertHas(card, "title=\"\(BgJobCard.stopConfirm)\"", Self.webCard)
        assertHas(card, "confirmText=\"\(BgJobCard.stop)\"", Self.webCard)
        assertHas(card, "quiet {formatSpan(state.quietMs)}", Self.webCard)
        assertHas(card, "exit {state.exitCode}", Self.webCard)
        assertHas(card, "is-stopped\">\(BgJobCard.killed)</span>", Self.webCard)
        // Each wake's row: when, what, and when the agent read it.
        let row = try section(card, from: "function WakeRow(", to: "\n}")
        assertHas(row, "`quiet ${formatSpan(job.stall.quietForMs ?? 0)}`", Self.webCard)
        assertHas(row, "'new output'", Self.webCard)
        assertHas(row, "`exit ${job.exitCode}`", Self.webCard)
        assertHas(row, "`read by the agent at ${clock(wake.readAt)}`", Self.webCard)
        assertHas(row, ".join(' · ')", Self.webCard)
        // The opened card's metadata line.
        assertHas(card, "`started ${clock(", Self.webCard)
        assertHas(card, "`ran ${elapsed}`", Self.webCard)
        assertHas(card, "`on ${host.where}`", Self.webCard)
        XCTAssertEqual(BgJobCard.meta(jobId: "bgj_1", kind: "job", startedAt: nil, ranFor: "3s", where: "ws"),
                       "bgj_1 · job · ran 3s · on ws")
    }

    /// R4: no word "Job" in the header; the kind chip and the elapsed time move to a second line at phone width.
    func testTheHeaderIsTheWebsHeader() throws {
        let card = try source(Self.webCard)
        let header = try section(card, from: "<div className=\"chat-tool-row\"", to: "</div>")
        XCTAssertFalse(header.contains(">Job<"), "\(Self.webCard) puts the word Job in the header again")
        assertHas(header, "{!phone && kindChip}", Self.webCard)
        assertHas(card, "<div className=\"chat-job-sub\">", Self.webCard)
        assertHas(card, "typeof input?.kind === 'string' && input.kind ? input.kind : 'job'", Self.webCard)
    }

    /// Only the folded card's last lines turn red on a failure; the opened output keeps output's own
    /// colour, and the killed line is the card's second-level size and grey (web `.chat-job-output`,
    /// `.chat-job-ending`).
    func testTheOpenedOutputIsNeverRedAndTheKilledLineIsSecondLevel() throws {
        let css = try source("src/web/src/index.css")
        let output = try section(css, from: ".chat-job-output .chat-pre {", to: "}")
        XCTAssertFalse(output.contains("--error"), "web's opened output turned red")
        let ending = try section(css, from: ".chat-job-ending {", to: "}")
        assertHas(ending, "font-size: 12px;", "src/web/src/index.css")
        let view = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/JobCardView.swift")
        let detail = try section(view, from: "private func detail(", to: "private var wakeBlock")
        XCTAssertFalse(detail.contains("Color.red"), "the opened output is drawn red again")
        XCTAssertFalse(detail.contains(".orbitSubtext"), "the killed line is larger than the card's other lines")
        let killed = try section(view, from: "case .killedBy(let line):", to: "case .ending")
        XCTAssertTrue(killed.contains(".font(.orbitLabel).foregroundStyle(.secondary)"),
                      "the folded killed line left the card's second-level size and grey")
    }

    /// R2: the route's pace and the opened card's line count.
    func testThePaceAndTheLineCountsAreTheWebs() throws {
        let card = try source(Self.webCard)
        assertHas(card, "export const TAIL_PACE_MS = \(Int(BgJobCard.tailPaceSeconds))_000;", Self.webCard)
        assertHas(card, "export const TAIL_RETRY_MS = \(Int(BgJobCard.tailRetrySeconds))_000;", Self.webCard)
        assertHas(card, "const OPEN_LINES = \(BgJobCard.openLines);", Self.webCard)
        assertHas(card, "err.status === 404 || err.status === 409", Self.webCard)
        assertHas(card, "lastLines(output, running ? 1 : 2)", Self.webCard)
        let lib = try source(Self.webLib)
        let elapsed = try section(lib, from: "export function elapsedText(", to: "\n}")
        assertHas(elapsed, "if (minutes >= 20) return `${minutes}m`;", Self.webLib)
        assertHas(elapsed, "if (hours > 0) return `${hours}h ${minutes}m`;", Self.webLib)
    }

    /// Board C1 and E1: a job's wake draws no line and no queued-tail row; a wakeup still does.
    func testTheWakeTurnAndTheQueuedTailFollowTheWeb() throws {
        let lib = try source(Self.webLib)
        let only = try section(lib, from: "export function wakeupsOnly(", to: "\n}")
        assertHas(only, "if (!wake || wake.wakeups.length === 0) return null;", Self.webLib)
        let queued = try section(lib, from: "export function queuedJobWake(", to: "\n}")
        assertHas(queued, "alone: wake.wakeups.length === 0 && !subagent && !workflow,", Self.webLib)
        let workspace = try source(Self.webWorkspace)
        assertHas(workspace, "!(!turn.sessionMessage && queuedJobWake(turn.content)?.alone)", Self.webWorkspace)
        assertHas(workspace, "if (turn.sessionMessage || turn.placement === 'steer') continue;", Self.webWorkspace)
        let transcript = try source(Self.webTranscript)
        assertHas(transcript, "node.name !== BG_RUN_TOOL &&", Self.webTranscript)
    }

    /// R1 and R3 in the Background list: a job row goes to its card; Stop only on a running stoppable job.
    func testTheBackgroundListFollowsTheWeb() throws {
        let tray = try source(Self.webTray)
        assertHas(tray, "const card = s.kind === 'job' ? jobCardOf(s.shellId) : null;", Self.webTray)
        assertHas(tray, "sessionId && s.kind === 'job' && s.status === 'running' && s.stoppable", Self.webTray)
        assertHas(tray, "title=\"\(BgJobCard.stopConfirm)\"", Self.webTray)
    }
}
