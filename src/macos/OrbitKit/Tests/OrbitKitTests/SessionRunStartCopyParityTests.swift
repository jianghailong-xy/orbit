import Foundation
import XCTest
@testable import OrbitKit

/// The "this run never started" card says the same words as the surfaces that already say them.
///
/// Two of its three vocabularies live outside Swift and cannot be imported from here, so this test
/// reads the files themselves:
///
/// - the next step for a refused run is `dispatchRefusalNextStep`
///   (`src/shared/src/source-refusal.ts`), the sentence the task's comment and the
///   coordinator's message give — `SessionRunStart.nextStep` is a port of it and every ported
///   sentence is looked up here;
/// - the claim sentences a machine-side card quotes are `src/apiserver/src/runner-api/runner-provider-support.ts`,
///   and they are fed to the card AS THEY ARE WRITTEN THERE, so the recognition is asserted against
///   the server's own spelling rather than a paraphrase of it;
/// - the runner-offline label is web's `WorkspaceView.tsx`, which `SessionStatusGlyph` holds too.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`.
final class SessionRunStartCopyParityTests: XCTestCase {

    private static let refusal = "src/shared/src/source-refusal.ts"
    private static let providerSupport = "src/apiserver/src/runner-api/runner-provider-support.ts"
    private static let workspace = "src/web/src/components/WorkspaceView.tsx"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native card is one half of a pair; if the "
                + "other half moved, move this check with it rather than deleting it."
        }
    }

    /// The source with string concatenations joined, JSX's escaped apostrophe read as one, and every
    /// run of whitespace as a single space — the same reading the other parity tests do.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "&apos;", with: "'")
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertSays(_ said: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(said.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// Every sentence `nextStep` prints, in the server's file. The four sentences are asserted
    /// whole; the pieces either side of an interpolation are asserted as the runs they are, since
    /// `${…}` is a hole this port fills at run time.
    func testTheNextStepIsTheServersOwnSentence() throws {
        let server = try source(Self.refusal)

        // The line every branch ends on, declared once by the server (`const again`).
        assertSays(server, "Until then, a new start meets the same refusal.", in: Self.refusal)

        // SYNC_INTEGRATION_LINE — everything but `${line}`.
        let sync = SessionRunStart.nextStep(fixAction: "SYNC_INTEGRATION_LINE", ref: nil)
        for run in ["The dependency has landed — what is missing is its landed commit on ",
                    ": the dependency's work reached upstream, and this line has not taken in upstream yet. Bring this line up to date with upstream first (the main sync at the next task landing does that; if it cannot wait, merge upstream into this line from its tip and push it back, with no rebase and no force push), then start it. Until then, a new start meets the same refusal: it begins from the same tip and asks for the same commits."] {
            assertSays(server, run, in: Self.refusal)
            XCTAssertTrue(sync.contains(run), "the port dropped \(run)")
        }
        assertSays(server, "the integration line ", in: Self.refusal)

        // FIX_REF — the server's own fallback wording is in the file as well as this port's.
        let fixRef = SessionRunStart.nextStep(fixAction: "FIX_REF", ref: nil)
        for run in ["The repository had no ",
                    " when it was resolved: it does not exist yet, it was deleted, or it does not match the name in the project's binding. Create it first (this project's first landing on this line creates it), or change the binding's integrationRef to the one that exists, then start it.",
                    "ref for this run to start from"] {
            assertSays(server, run, in: Self.refusal)
            XCTAssertTrue(fixRef.contains(run), "the port dropped \(run)")
        }

        // The other two named actions, whole.
        for (action, run) in [
            ("RESTORE_COMMIT", "The repository of the runner that runs it does not have the pinned commit: fetch or restore it into that repository, then start it."),
            ("ENABLE_ISOLATION", "The runner could not create a separate worktree at the pinned commit: check that this workspace's workDir is a git repository and that worktree isolation is not turned off, and work through the `git worktree add` error in the runner's own words above, then start it."),
        ] {
            assertSays(server, run, in: Self.refusal)
            XCTAssertTrue(SessionRunStart.nextStep(fixAction: action, ref: nil).contains(run),
                          "the port dropped \(action)'s sentence")
        }

        // Anything else: the server's generic line, with the action's own name in it.
        assertSays(server, "Fix it as ", in: Self.refusal)
        assertSays(server, " says, then start it.", in: Self.refusal)
    }

    /// The machine-side sentences the card recognizes, taken from the server's file and handed to
    /// the card as they are written. A server that rewords one of these breaks this test rather
    /// than silently leaving a stalled run with no card.
    func testTheClaimSentencesTheCardReadsAreTheServersOwn() throws {
        let server = try source(Self.providerSupport)
        for sentence in ["OpenCode requires Orbit runner 0.1.82 or newer; update this runner first",
                         "Antigravity requires a newer Orbit runner; update this runner first",
                         "DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first"] {
            assertSays(server, sentence, in: Self.providerSupport)
            // Antigravity's and Harness's have a card of their own; OpenCode's does not, and is the
            // one this card draws. Whichever it is, the sentence is recognized rather than ignored.
            let card = SessionRunStart.card(for: session(error: sentence), runnerName: "machine",
                                            runnerVersion: "0.1.120")
            if sentence.hasPrefix("OpenCode") {
                let drawn = try XCTUnwrap(card, "the server's own OpenCode sentence drew no card")
                XCTAssertEqual(drawn.why, "Waiting for a newer runner")
                XCTAssertTrue(drawn.body.contains("OpenCode needs 0.1.82 or newer."))
            } else {
                XCTAssertNil(card, "an engine with its own card was claimed by this one too")
            }
        }
    }

    /// The runner's not-installed sentence, as the runner writes it (`src/runner-go/engineinstall.go`).
    func testTheRunnersInstallSentenceIsRecognized() throws {
        let runner = "OpenCode isn't installed on this runner and installing it failed (exit status 1) "
            + "— run `orbit doctor` on that machine. Tried:  npm install -g opencode-ai"
        let card = try XCTUnwrap(SessionRunStart.card(for: session(error: runner), runnerName: "machine"))
        XCTAssertEqual(card.why, "OpenCode isn't installed on machine")
    }

    /// The word for a run the machine stopped reporting under, in the web file it comes from.
    func testTheOfflineLabelIsWebs() throws {
        let web = try source(Self.workspace)
        assertSays(web, "Disconnected — runner went offline", in: Self.workspace)
        assertSays(web, "'offline'", in: Self.workspace)
        XCTAssertEqual(SessionStatusGlyph.offlineLabel, "Disconnected — runner went offline")
        let card = try XCTUnwrap(SessionRunStart.card(for: session(error: "runner offline")))
        XCTAssertEqual(card.lines, [SessionStatusGlyph.offlineLabel])
    }

    /// The install advice is the app's existing sentence for this failure, character for character,
    /// so an engine that is missing gives one answer wherever it is drawn.
    func testTheInstallAdviceIsTheAppsOwn() {
        let existing = DshRuntime.Repair.notInstalled.detail
        XCTAssertEqual(SessionRunStart.installAdvice, existing)
        XCTAssertEqual(EngineAuth.antigravityBody(.notInstalled, runnerName: nil, runnerVersion: nil), existing)
        XCTAssertEqual(EngineAuth.antigravityTitle(.updateRunner, runnerName: nil),
                       "Waiting for a newer runner")
    }

    private func session(error: String?) -> Session {
        Session(id: "s", title: "t", status: .failed, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil, error: error)
    }
}
