import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words on a project's crossings, and this is the tripwire that keeps
/// them saying them.
///
/// The browser declares the card's sentences in `ProjectCrossingsCard.tsx` — a move's in exported
/// constants, so a client that shows the same request can hold its words to them — and the state
/// words in `lib/attribution.ts`; this client holds the same sentences by hand (`ProjectCrossings`).
/// They share no compiler, so this reads the other end's source — string concatenations joined and
/// runs of whitespace read as one space (JSX wraps its text), every sentence compared whole, with
/// sentinels put back as the web template's own interpolations — and anchors each on the markup or
/// declaration around it, so a comment that happens to contain the words cannot satisfy it. A
/// counterpart it cannot find is a FAILURE, never an `XCTSkip`.
final class ProjectCrossingsCardCopyParityTests: XCTestCase {

    private static let card = "src/web/src/components/ProjectCrossingsCard.tsx"
    private static let attribution = "src/web/src/lib/attribution.ts"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native crossings card is one half of a pair; "
                + "if the web half moved, move this check with it rather than deleting it."
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertSays(_ web: String, _ anchored: String, in file: String,
                            line: UInt = #line) {
        XCTAssertTrue(web.contains(anchored), "\(file) no longer says: \(anchored)", line: line)
    }

    private func assertDeclares(_ web: String, _ name: String, _ value: String, line: UInt = #line) {
        assertSays(web, "export const \(name) = '\(value)';", in: Self.card, line: line)
    }

    /// A rendered sentence with its sentinels put back as the web template's interpolations: the
    /// whole sentence has to match, not the words around a value.
    private func assertTemplate(_ web: String, _ rendered: String, _ values: [(String, String)],
                                in file: String, line: UInt = #line) {
        let template = values.reduce(rendered) { $0.replacingOccurrences(of: $1.0, with: $1.1) }
        assertSays(web, "`\(template)`", in: file, line: line)
    }

    /// One `Record<CrossingState, string>` declaration, from its name to its closing brace.
    private func record(_ web: String, _ name: String, in file: String) throws -> String {
        let start = try XCTUnwrap(web.range(of: "export const \(name): Readonly<Record<CrossingState, string>> = {"),
                                  "\(file) no longer declares \(name)")
        let end = try XCTUnwrap(web.range(of: "};", range: start.upperBound..<web.endIndex))
        return String(web[start.lowerBound..<end.upperBound])
    }

    private func assertRecord(_ web: String, _ name: String, _ native: [String: String], in file: String,
                              line: UInt = #line) throws {
        let declared = try record(web, name, in: file)
        XCTAssertEqual(Set(native.keys), ["PENDING", "APPROVED", "DENIED", "APPLIED"], line: line)
        for (state, text) in native {
            XCTAssertTrue(declared.contains("\(state): '\(text)',"), "\(name).\(state) drifted from \(text.debugDescription)",
                          line: line)
        }
        XCTAssertEqual(declared.components(separatedBy: ": '").count - 1, native.count,
                       "\(name) says something this client does not", line: line)
    }

    // MARK: a move

    func testAMovesWordsAreTheWebsDeclaredConstants() throws {
        let web = try source(Self.card)
        assertDeclares(web, "MOVE_TASK_SUBJECT_LABEL", ProjectCrossings.moveSubjectLabel)
        assertDeclares(web, "MOVE_TASK_REQUESTED_CRITERION_LABEL", ProjectCrossings.moveRequestedCriterionLabel)
        assertDeclares(web, "MOVE_TASK_WITHDRAWN_CRITERION_LABEL", ProjectCrossings.moveWithdrawnCriterionLabel)
        assertDeclares(web, "MOVE_TASK_WITHDRAWN_CRITERION_NOTE", ProjectCrossings.moveWithdrawnCriterionNote)
        assertDeclares(web, "MOVE_TASK_CRITERION_GONE", ProjectCrossings.moveCriterionGone)
        assertDeclares(web, "MOVE_TASK_APPROVE_CONSEQUENCE", ProjectCrossings.moveApproveConsequence)
        assertDeclares(web, "MOVE_TASK_DENY_CONSEQUENCE", ProjectCrossings.moveDenyConsequence)
        try assertRecord(web, "MOVE_TASK_STATE_MEANING", ProjectCrossings.moveStateMeaning, in: Self.card)
    }

    /// Each label is followed by ": " on both clients, and a deleted criterion reads as gone.
    func testAMovesRowDrawsItsLabelsTheWayTheWebDoes() throws {
        let web = try source(Self.card)
        assertSays(web, "const move = row.kind === '\(ProjectCrossings.moveKind)';", in: Self.card)
        for name in ["MOVE_TASK_SUBJECT_LABEL", "MOVE_TASK_REQUESTED_CRITERION_LABEL",
                     "MOVE_TASK_WITHDRAWN_CRITERION_LABEL"] {
            assertSays(web, "<Text muted>{\(name)}: </Text>", in: Self.card)
        }
        assertSays(web, "<Text strong>{row.subjectTask?.title ?? row.title}</Text>", in: Self.card)
        assertSays(web, "const id = row.subjectTaskPublicId ?? row.subjectTaskId;", in: Self.card)
        assertSays(web, "<Text>{requested.text ?? MOVE_TASK_CRITERION_GONE}</Text>", in: Self.card)
        assertSays(web, "<Text muted>{MOVE_TASK_WITHDRAWN_CRITERION_NOTE}</Text>", in: Self.card)
    }

    // MARK: the state

    func testTheStateWordsAreAttributionsAndAMoveSaysItsOwn() throws {
        let lib = try source(Self.attribution)
        let labels = Dictionary(uniqueKeysWithValues: ["PENDING", "APPROVED", "DENIED", "APPLIED"].map {
            ($0, ProjectCrossings.label($0))
        })
        try assertRecord(lib, "CROSSING_STATE_LABEL", labels, in: Self.attribution)
        let filing = ProjectCrossing(id: "r", fromProjectId: "a", toProjectId: "b", kind: "FILE_TASK",
                                     crossingKey: "k", state: "PENDING", title: "t", requestedAt: "")
        let meanings = Dictionary(uniqueKeysWithValues: ["PENDING", "APPROVED", "DENIED", "APPLIED"].map {
            ($0, ProjectCrossings.meaning(ProjectCrossing(id: "r", fromProjectId: "a", toProjectId: "b",
                                                          kind: filing.kind, crossingKey: "k", state: $0,
                                                          title: "t", requestedAt: "")))
        })
        try assertRecord(lib, "CROSSING_STATE_MEANING", meanings, in: Self.attribution)
        // A state nobody wrote words for reads as its own code at both ends.
        assertSays(lib, "return map[code] ?? code;", in: Self.attribution)
        XCTAssertEqual(ProjectCrossings.label("NEW_STATE"), "NEW_STATE")

        let web = try source(Self.card)
        assertSays(web, "{labelFor(CROSSING_STATE_LABEL, row.state)}", in: Self.card)
        assertSays(web, "{labelFor(move ? MOVE_TASK_STATE_MEANING : CROSSING_STATE_MEANING, row.state)}",
                   in: Self.card)
    }

    /// Only a question can be answered, and the questions lead, oldest first; history follows,
    /// newest first.
    func testTheAnswerableStateAndTheOrderAreTheWebs() throws {
        let web = try source(Self.card)
        assertSays(web, "export function isAnswerable(state: CrossingState): boolean { return state === 'PENDING'; }",
                   in: Self.card)
        XCTAssertTrue(ProjectCrossings.isAnswerable("PENDING"))
        XCTAssertFalse(ProjectCrossings.isAnswerable("APPROVED"))

        let lib = try source(Self.attribution)
        assertSays(lib, "const pending = rows.filter((row) => row.state === 'PENDING');", in: Self.attribution)
        assertSays(lib, "pending.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));", in: Self.attribution)
        assertSays(lib, "answered.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));", in: Self.attribution)
        assertSays(lib, "return [...pending, ...answered];", in: Self.attribution)
    }

    // MARK: the card

    func testTheCardsOwnWords() throws {
        let web = try source(Self.card)
        assertSays(web, "title=\"\(ProjectCrossings.title)\"", in: Self.card)
        assertSays(web, "title=\"\(ProjectCrossings.unreadable)\"", in: Self.card)
        assertSays(web, "{pending} waiting </span>", in: Self.card)
        XCTAssertEqual(ProjectCrossings.waiting(23), "23 waiting")
        assertSays(web, "<Text strong>{title ?? '\(ProjectCrossings.unnamedProject)'}</Text>", in: Self.card)
        assertSays(web, "<Text muted>\(ProjectCrossings.arrow)</Text>", in: Self.card)
        assertSays(web, "<Text muted>Reason given: {row.reason}</Text>", in: Self.card)
        XCTAssertEqual(ProjectCrossings.reasonGiven("REASON"), "Reason given: REASON")
        assertSays(web, "title=\"\(ProjectCrossings.notRecorded)\"", in: Self.card)
    }

    // MARK: the two presses

    func testTheFirstPressOnlyAsks() throws {
        let web = try source(Self.card)
        assertSays(web, "onClick={() => onAsk('APPROVE')}> \(ProjectCrossings.approveAsk) </Button>", in: Self.card)
        assertSays(web, "onClick={() => onAsk('DENY')}> \(ProjectCrossings.refuseAsk) </Button>", in: Self.card)
    }

    /// The second press names the subject and both ends, says what follows, shows the crossing key
    /// it sends back, and answers — or is cancelled.
    func testTheSecondPressSaysWhatTheWebsSays() throws {
        let web = try source(Self.card)
        assertSays(web, "const verb = decision === 'APPROVE' ? 'Approve' : 'Refuse';", in: Self.card)
        XCTAssertEqual(ProjectCrossings.prompt(sample(kind: "FILE_TASK"), .approve).verb, "Approve")
        XCTAssertEqual(ProjectCrossings.prompt(sample(kind: "FILE_TASK"), .deny).verb, "Refuse")

        let prompt = ProjectCrossings.Prompt(verb: "Verb1", from: "From2", to: "To3", subject: "Subject4",
                                             consequence: "")
        assertTemplate(web, ProjectCrossings.question(prompt),
                       [("Verb1", "${prompt.verb}"), ("Subject4", "${prompt.subject}"),
                        ("From2", "${prompt.from}"), ("To3", "${prompt.to}")], in: Self.card)
        assertTemplate(web, ProjectCrossings.confirmLabel(prompt), [("verb1", "${prompt.verb.toLowerCase()}")],
                       in: Self.card)
        assertSays(web, "onClick={onCancel}> \(ProjectCrossings.cancel) </Button>", in: Self.card)
        assertSays(web, "<Text muted>\(ProjectCrossings.crossingKeyLabel) </Text>", in: Self.card)
        assertSays(web, "<Code>{row.crossingKey.slice(0, 12)}</Code>", in: Self.card)
        XCTAssertEqual(ProjectCrossings.shortKey(String(repeating: "c", count: 64)).count, 12)
    }

    /// Where each end's name comes from, and what a move is about: the task as it reads now.
    func testTheSecondPressNamesItsEndsAndSubjectTheWayTheWebDoes() throws {
        let web = try source(Self.card)
        assertSays(web, "const from = row.fromProject?.title ?? (row.fromProjectPublicId ?? row.fromProjectId);",
                   in: Self.card)
        assertSays(web, "const to = row.toProject?.title ?? (row.toProjectPublicId ?? row.toProjectId);",
                   in: Self.card)
        assertSays(web, "subject: row.subjectTask?.title ?? row.title, consequence: decision === 'APPROVE' "
                   + "? MOVE_TASK_APPROVE_CONSEQUENCE : MOVE_TASK_DENY_CONSEQUENCE,", in: Self.card)
        let bare = ProjectCrossings.prompt(sample(kind: "MOVE_TASK"), .approve)
        XCTAssertEqual(bare.from, "FromPublic")
        XCTAssertEqual(bare.to, "ToPublic")
        XCTAssertEqual(bare.subject, "Asked title")
    }

    /// A filing and a dependency answer in the filing's words.
    func testAFilingsConsequencesAreTheWebs() throws {
        let web = try source(Self.card)
        assertSays(web, "subject: row.title, consequence: decision === 'APPROVE' ? '\(ProjectCrossings.fileApproveConsequence)' "
                   + ": '\(ProjectCrossings.fileDenyConsequence)',", in: Self.card)
        XCTAssertEqual(ProjectCrossings.prompt(sample(kind: "DEPEND_ON_TASK"), .approve).consequence,
                       ProjectCrossings.fileApproveConsequence)
        XCTAssertEqual(ProjectCrossings.prompt(sample(kind: "DEPEND_ON_TASK"), .deny).consequence,
                       ProjectCrossings.fileDenyConsequence)
    }

    /// The press reaches the web's own door with the web's own body: the decision, and the key of
    /// the crossing it was given on — the door where confirming a move moves the task.
    func testThePressReachesTheWebsDoorWithTheWebsBody() throws {
        let web = try source(Self.card)
        assertSays(web, "`/projects/${encodeURIComponent(projectId)}/handoffs/${encodeURIComponent(row.publicId ?? row.id)}/decision`",
                   in: Self.card)
        assertSays(web, "{ method: 'POST', body: { decision, acknowledgedCrossingKey: row.crossingKey } }", in: Self.card)
        let body = try JSONEncoder().encode(ProjectCrossings.request(sample(kind: "MOVE_TASK"), .approve))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(Set(json.keys), ["decision", "acknowledgedCrossingKey"])
        XCTAssertEqual(ProjectCrossingDecision.approve.rawValue, "APPROVE")
        XCTAssertEqual(ProjectCrossingDecision.deny.rawValue, "DENY")
    }

    private func sample(kind: String) -> ProjectCrossing {
        ProjectCrossing(id: "r", fromProjectId: "FromRaw", fromProjectPublicId: "FromPublic", toProjectId: "ToRaw",
                        toProjectPublicId: "ToPublic", kind: kind, crossingKey: String(repeating: "c", count: 64),
                        state: "PENDING", title: "Asked title", requestedAt: "")
    }
}
