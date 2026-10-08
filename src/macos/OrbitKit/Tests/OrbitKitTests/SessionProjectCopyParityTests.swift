import Foundation
import XCTest
@testable import OrbitKit

/// A missing web counterpart fails: the project words must be checked on both clients.
final class SessionProjectCopyParityTests: XCTestCase {
    private static let webSource = "src/web/src/lib/sessionProjects.ts"

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webSource).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "\(SessionProjectCopyParityTests.webSource) was not found above this test file. "
                + "OrbitKit's SessionProjectCopy is one half of a pair; if the web half moved, "
                + "move this check with it rather than deleting it."
        }
    }

    private func web() throws -> String {
        let source = try String(contentsOf: try repoRoot().appendingPathComponent(Self.webSource),
                                encoding: .utf8)
        return source
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "([=:])\\s*\\n\\s*(['`])", with: "$1 $2",
                                  options: .regularExpression)
    }

    func testRowAndPageConstantsAreTheWebsOwn() throws {
        let web = try web()
        let constants: [(String, String)] = [
            ("noCoordinator", SessionProjectCopy.noCoordinator),
            ("openSession", SessionProjectCopy.openSession),
            ("openCoordinator", SessionProjectCopy.openCoordinator),
            ("sessions", SessionProjectCopy.sessions),
            ("openProject", SessionProjectCopy.openProject),
            ("pin", SessionProjectCopy.pin),
            ("unpin", SessionProjectCopy.unpin),
            ("move", SessionProjectCopy.move),
            ("coordinatorSection", SessionProjectCopy.coordinatorSection),
            ("pageSubtitleLoading", SessionProjectCopy.pageSubtitleLoading),
            ("startReview", SessionProjectCopy.startReview),
            ("startNotAsked", SessionProjectCopy.startNotAsked),
            ("startHint", SessionProjectCopy.startHint),
        ]
        for (key, copy) in constants {
            XCTAssertTrue(web.contains("\(key): '\(copy)',"),
                          "\(key): the web's words drifted from \(copy.debugDescription)")
        }
    }

    func testRowAndPageTemplatesAreTheWebsOwn() throws {
        let web = try web()
        let templates: [(String, String)] = [
            ("progress: (done: number, total: number)",
             SessionProjectCopy.progress(done: 23, total: 47)
                .replacingOccurrences(of: "23", with: "${done}")
                .replacingOccurrences(of: "47", with: "${total}")),
            ("progressHint: (sessions: number, running: number)",
             SessionProjectCopy.progressHint(sessions: 23, running: 47)
                .replacingOccurrences(of: "23", with: "${sessions}")
                .replacingOccurrences(of: "47", with: "${running}")),
            ("waitingSession: (text: string, title: string)",
             SessionProjectCopy.waitingSession("WAIT_TEXT", title: "SESSION_TITLE")
                .replacingOccurrences(of: "WAIT_TEXT", with: "${text}")
                .replacingOccurrences(of: "SESSION_TITLE", with: "${title}")),
            ("pageSubtitle: (sessions: number)",
             SessionProjectCopy.pageSubtitle(sessions: 23)
                .replacingOccurrences(of: "23", with: "${sessions}")),
            ("pageProgress: (done: number, total: number, running: number)",
             SessionProjectCopy.pageProgress(done: 23, total: 47, running: 61)
                .replacingOccurrences(of: "23", with: "${done}")
                .replacingOccurrences(of: "47", with: "${total}")
                .replacingOccurrences(of: "61", with: "${running}")),
            ("startAsked: (ago: string)",
             SessionProjectCopy.startAsked("AGO").replacingOccurrences(of: "AGO", with: "${ago}")),
        ]
        for (signature, copy) in templates {
            XCTAssertTrue(web.contains("\(signature) => `\(copy)`,"),
                          "\(signature): the web's template drifted from \(copy.debugDescription)")
        }
    }

    /// The start row's two sentences that branch, held to the web's spelling of each branch.
    func testTheNotStartedLineAndTheSuggestionAreTheWebsOwn() throws {
        let web = try web()
        XCTAssertTrue(web.contains("pageNotStarted: (tasks: number) => `Not started · ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`,"))
        XCTAssertEqual(SessionProjectCopy.pageNotStarted(tasks: 1), "Not started · 1 task")
        XCTAssertEqual(SessionProjectCopy.pageNotStarted(tasks: 5), "Not started · 5 tasks")
        XCTAssertTrue(web.contains("`${settings.line === 'MAIN' ? 'Directly into main' : 'Project branch'} · Automatic ${settings.automatic ? 'on' : 'off'} · ${settings.maxConcurrentTasks} at a time`,"))
        XCTAssertEqual(SessionProjectCopy.startSuggestion(
            ProjectStartSettings(line: .projectBranch, automatic: true, maxConcurrentTasks: 2)),
            "Project branch · Automatic on · 2 at a time")
        XCTAssertEqual(SessionProjectCopy.startSuggestion(
            ProjectStartSettings(line: .main, automatic: false, maxConcurrentTasks: 1)),
            "Directly into main · Automatic off · 1 at a time")
    }

    func testAllFiveCoordinatorLeadPhrasesAreTheWebsOwn() throws {
        let web = try web()
        let kinds: [CoordinatorLeadKind] = [
            .integrationConflict, .integrationCheckFailed, .integrationError, .taskFailed, .deliveryReview,
        ]
        for kind in kinds {
            let copy = try XCTUnwrap(SessionProjectCopy.coordinatorLead(kind))
            XCTAssertTrue(web.contains("\(kind.rawValue): '\(copy)',"),
                          "the coordinator phrase for \(kind.rawValue) drifted from \(copy.debugDescription)")
        }
    }
}
