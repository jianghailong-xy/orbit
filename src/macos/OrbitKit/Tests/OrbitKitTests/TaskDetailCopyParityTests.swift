import Foundation
import XCTest
@testable import OrbitKit

/// The task detail page says the browser's words. Every constant in `TaskDetailCopy` is looked up in
/// the web source it was ported from — anchored on the markup or the declaration around it, so a
/// comment that happens to contain the sentence cannot satisfy the check — with string
/// concatenations joined and runs of whitespace read as one space (JSX wraps its text).
///
/// A sentence with values in it is rendered with sentinel numbers and the sentinels are replaced by
/// the web's own interpolations, so the whole sentence has to match, not the words around a number.
///
/// Deliberately not compared: the section counts (the web writes `Runs (1)`, the phone draws the
/// count beside the heading), and the comment box's placeholder (the web's names a desktop
/// shortcut, which a phone does not have).
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`.
final class TaskDetailCopyParityTests: XCTestCase {

    private static let panel = "src/web/src/components/TaskDetailPanel.tsx"
    private static let schedule = "src/web/src/components/TaskScheduleEditor.tsx"
    private static let acceptance = "src/web/src/pages/TaskDetailPage.tsx"
    private static let inputs = "src/web/src/components/TaskInputs.tsx"
    private static let attributionCard = "src/web/src/components/TaskAttributionCard.tsx"
    private static let attribution = "src/web/src/lib/attribution.ts"
    private static let followedBy = "src/web/src/components/WatchRelations.tsx"
    private static let watchEditor = "src/web/src/components/WatchEditor.tsx"
    private static let dependencyList = "src/web/src/components/TaskDependencyList.tsx"
    private static let sharedTask = "src/web/src/pages/SharedTaskPage.tsx"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native task page is one half of a pair; if the web "
                + "half moved, move this check with it rather than deleting it."
        }
    }

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

    private func assertSays(_ web: String, _ anchored: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(web.contains(anchored), "\(file) no longer says: \(anchored)", line: line)
    }

    // MARK: the panel

    func testTheSectionHeadingsAndTheDetailsLabels() throws {
        let web = try source(Self.panel)
        for heading in [TaskDetailCopy.detailsHeading, TaskDetailCopy.dependenciesHeading,
                        TaskDetailCopy.descriptionHeading, TaskDetailCopy.acceptanceHeading] {
            assertSays(web, "<div className=\"tdp-section-title\">\(heading)</div>", in: Self.panel)
        }
        assertSays(web, "<div className=\"tdp-section-title\">\(TaskDetailCopy.runsHeading) ({sessions.length})</div>",
                   in: Self.panel)
        assertSays(web, "<div className=\"tdp-section-title\">\(TaskDetailCopy.commentsHeading) ({comments.length})</div>",
                   in: Self.panel)
        for label in [TaskDetailCopy.assigneeLabel, TaskDetailCopy.providerLabel, TaskDetailCopy.modelLabel,
                      TaskDetailCopy.listLabel, TaskDetailCopy.createdByLabel, TaskDetailCopy.createdFromLabel,
                      TaskDetailCopy.createdLabel] {
            assertSays(web, "<span className=\"tdp-field-label\">\(label)</span>", in: Self.panel)
        }
        assertSays(web, ": '\(TaskDetailCopy.runNow)'", in: Self.panel)
        assertSays(web, "<div className=\"tdp-muted\">\(TaskDetailCopy.noRuns)</div>", in: Self.panel)
        assertSays(web, "<div className=\"tdp-muted\">\(TaskDetailCopy.noComments)</div>", in: Self.panel)
    }

    func testTheDependenciesWords() throws {
        let web = try source(Self.panel)
        assertSays(web, "<div className=\"tdp-muted\">\(TaskDetailCopy.noDependencies)</div>", in: Self.panel)
        assertSays(web, "<span>\(TaskDetailCopy.autoRunWhenReady)</span>", in: Self.panel)
        assertSays(web, "{ label: '\(TaskDetailCopy.graphView)', value: 'graph' }", in: Self.panel)
        assertSays(web, "{ label: '\(TaskDetailCopy.listView)', value: 'list' }", in: Self.panel)
        assertSays(web, "'\(TaskDetailCopy.failedPrerequisites(1))'", in: Self.panel)
        assertSays(web, "`" + TaskDetailCopy.failedPrerequisites(23)
                    .replacingOccurrences(of: "23", with: "${failedDirectPrerequisites}") + "`", in: Self.panel)
        assertSays(web, "`" + TaskDetailCopy.completedPrerequisites(23, of: 29)
                    .replacingOccurrences(of: "23", with: "${completedDirectPrerequisites}")
                    .replacingOccurrences(of: "29", with: "${dependsOn.length}") + "`", in: Self.panel)
        // The count line is JSX: the same sentence with the web's expressions where the numbers go.
        let summary = TaskDetailCopy.dependencySummary(connected: 23, loaded: true, upstream: 29, downstream: 31)
        XCTAssertEqual(summary, "23 connected loaded · 29 upstream · 31 downstream")
        assertSays(web, "{connectedCount} connected{dependencyGraph.truncated ? ' loaded' : ''} · {upstreamCount} upstream ·{' '} {downstreamCount} downstream",
                   in: Self.panel)
        let snapshot = TaskDetailCopy.graphSnapshotLimit(maxDepth: 23, maxNodes: 29, maxEdges: 31)
            .replacingOccurrences(of: "23", with: "${dependencyGraph.limits?.maxDepth ?? 8}")
            .replacingOccurrences(of: "29", with: "${dependencyGraph.limits?.maxNodes ?? 100}")
            .replacingOccurrences(of: " or 31 relationships",
                                  with: "${dependencyGraph.limits?.maxEdges ? ` or ${dependencyGraph.limits.maxEdges} relationships` : ''}")
        assertSays(web, "`" + snapshot, in: Self.panel)
        assertSays(web, "'\(TaskDetailCopy.graphLimitReached)'", in: Self.panel)

        let list = try source(Self.dependencyList)
        assertSays(list, "<span className=\"tdg-current-tag\">\(TaskDetailCopy.currentTask)</span>", in: Self.dependencyList)
        assertSays(list, "'\(TaskDetailCopy.noAdjacentRelationships)'", in: Self.dependencyList)
        assertSays(list, "title=\"\(TaskDetailCopy.removePrerequisiteTitle)\"", in: Self.dependencyList)
        assertSays(list, "description=\"\(TaskDetailCopy.removePrerequisiteDetail)\"", in: Self.dependencyList)
        assertSays(list, "okText=\"\(TaskDetailCopy.remove)\"", in: Self.dependencyList)
        // The relationship line (`TaskDetailLogic.dependencyRows`).
        assertSays(list, "prerequisites ? `Depends on ${prerequisites}` : ''", in: Self.dependencyList)
        assertSays(list, "targets ? `Required by ${targets}` : ''", in: Self.dependencyList)
        assertSays(list, ".join(' · ')", in: Self.dependencyList)
    }

    func testLongTextFoldsWithTheSharedPagesWords() throws {
        let web = try source(Self.sharedTask)
        assertSays(web, "{open ? '\(TaskDetailCopy.showLess)' : '\(TaskDetailCopy.showMore)'}", in: Self.sharedTask)
    }

    // MARK: start at

    func testTheStartAtWords() throws {
        let web = try source(Self.schedule)
        assertSays(web, "\(TaskDetailCopy.startAtLabel) </label>", in: Self.schedule)
        assertSays(web, "> \(TaskDetailCopy.saveSchedule) </Button>", in: Self.schedule)
        assertSays(web, "> \(TaskDetailCopy.cancelSchedule) </Button>", in: Self.schedule)
        assertSays(web, "message.success('\(TaskDetailCopy.scheduleSaved)')", in: Self.schedule)
        assertSays(web, "message.success('\(TaskDetailCopy.scheduleCancelled)')", in: Self.schedule)
        assertSays(web, "'\(TaskDetailCopy.scheduleHintUnscheduled)'", in: Self.schedule)
        assertSays(web, "'\(TaskDetailCopy.scheduleHintUnreadable)'", in: Self.schedule)
        assertSays(web, "`" + TaskDetailCopy.scheduleHint(startingOn: "SENTINEL")
                    .replacingOccurrences(of: "SENTINEL", with: "${scheduledLocal}") + "`", in: Self.schedule)
    }

    // MARK: the project line

    func testTheCancelledProjectNote() throws {
        let web = try source(Self.panel)
        assertSays(web, "PROJECT_CANCELLED_NOTE = '\(TaskDetailCopy.projectCancelledNote)'", in: Self.panel)
    }

    // MARK: acceptance

    func testTheAcceptanceWords() throws {
        let web = try source(Self.acceptance)
        let declared: [(String, String)] = [
            ("ACCEPTANCE_EMPTY", TaskDetailCopy.acceptanceEmpty),
            ("ACCEPTANCE_PAIR_EMPTY", TaskDetailCopy.acceptancePairEmpty),
            ("ACCEPTANCE_AUTOMATIC_HINT", TaskDetailCopy.acceptanceAutomaticHint),
            ("ACCEPTANCE_PAIR_INCOMPLETE", TaskDetailCopy.acceptancePairIncomplete),
            ("ACCEPTANCE_EXIT_CODE_NOT_AN_INTEGER", TaskDetailCopy.acceptanceExitCodeNotAnInteger),
        ]
        for (name, value) in declared {
            assertSays(web, "export const \(name) = '\(value)';", in: Self.acceptance)
        }
        assertSays(web, "<span className=\"tdp-acceptance-label\">\(TaskDetailCopy.acceptanceCriteriaLabel)</span>",
                   in: Self.acceptance)
        assertSays(web, "<span className=\"tdp-acceptance-label\">\(TaskDetailCopy.automaticJudgementLabel)</span>",
                   in: Self.acceptance)
        assertSays(web, "placeholder=\"\(TaskDetailCopy.acceptanceCriteriaPlaceholder)\"", in: Self.acceptance)
        assertSays(web, "placeholder=\"\(TaskDetailCopy.acceptanceCommandPlaceholder)\"", in: Self.acceptance)
        assertSays(web, "> \(TaskDetailCopy.acceptanceCommandLabel) </label>", in: Self.acceptance)
        assertSays(web, "> \(TaskDetailCopy.doneWhenItExits) </label>", in: Self.acceptance)
        assertSays(web, "> \(TaskDetailCopy.edit) </Button>", in: Self.acceptance)
        assertSays(web, "> \(TaskDetailCopy.saveAcceptance) </Button>", in: Self.acceptance)
        assertSays(web, "> \(TaskDetailCopy.cancel) </Button>", in: Self.acceptance)
        assertSays(web, "message.success('\(TaskDetailCopy.acceptanceSaved)')", in: Self.acceptance)
    }

    // MARK: inputs

    func testTheInputsWords() throws {
        let web = try source(Self.inputs)
        assertSays(web, "<div className=\"tdp-section-title\">\(TaskDetailCopy.inputsHeading) ({inputs.length})</div>",
                   in: Self.inputs)
        assertSays(web, "> \(TaskDetailCopy.inputsHint) </div>", in: Self.inputs)
        assertSays(web, "> \(TaskDetailCopy.addFile) </Button>", in: Self.inputs)
        assertSays(web, "title=\"\(TaskDetailCopy.removeInputTitle)\"", in: Self.inputs)
        assertSays(web, "description=\"\(TaskDetailCopy.removeInputDetail)\"", in: Self.inputs)
        assertSays(web, "okText=\"\(TaskDetailCopy.remove)\"", in: Self.inputs)
    }

    // MARK: attribution

    func testTheAttributionWords() throws {
        let card = try source(Self.attributionCard)
        for label in [TaskDetailCopy.countsTowardsLabel, TaskDetailCopy.noticedInLabel, TaskDetailCopy.crossingLabel,
                      TaskDetailCopy.blockedByLabel] {
            assertSays(card, "<Row label=\"\(label)\">", in: Self.attributionCard)
        }
        assertSays(card, "<Card title=\"\(TaskDetailCopy.attributionHeading)\"", in: Self.attributionCard)
        assertSays(card, "'\(TaskDetailCopy.notReported)'", in: Self.attributionCard)
        assertSays(card, "'\(TaskDetailCopy.evidenceOnly)'", in: Self.attributionCard)
        assertSays(card, "\(TaskDetailCopy.trigger) </Typography.Text>", in: Self.attributionCard)
        assertSays(card, "message=\"\(TaskDetailCopy.attributionUnavailable)\"", in: Self.attributionCard)
        // The lines `TaskDetailLogic.noticedIn` and `blockedBy` build.
        assertSays(card, "<div>Task: {view.discovery.task.title}</div>", in: Self.attributionCard)
        assertSays(card, "<div>Session: {view.discovery.session.title ?? 'untitled'}</div>", in: Self.attributionCard)
        assertSays(card, "owner {view.blocker.owner}", in: Self.attributionCard)
        assertSays(card, "Next checked {new Date(view.blocker.nextCheckAt).toLocaleString()}", in: Self.attributionCard)

        let lib = try source(Self.attribution)
        for (code, text) in TaskDetailCopy.absentReason {
            assertSays(lib, "\(code): '\(text)',", in: Self.attribution)
        }
        for (state, text) in TaskDetailCopy.crossingStateLabel {
            assertSays(lib, "\(state): '\(text)',", in: Self.attribution)
        }
        for (state, text) in TaskDetailCopy.crossingStateMeaning {
            assertSays(lib, "\(state): '\(text)',", in: Self.attribution)
        }
        XCTAssertEqual(TaskDetailCopy.absentReason.count, 4)
        XCTAssertEqual(Set(TaskDetailCopy.crossingStateLabel.keys), ["PENDING", "APPROVED", "DENIED", "APPLIED"])
    }

    // MARK: followed by

    func testTheFollowedByWords() throws {
        let web = try source(Self.followedBy)
        assertSays(web, "<span>\(TaskDetailCopy.followedByHeading) ({live.length})</span>", in: Self.followedBy)
        assertSays(web, "> \(TaskDetailCopy.followTask) </Button>", in: Self.followedBy)
        assertSays(web, "<div className=\"tdp-muted\">\(TaskDetailCopy.loadingWatches)</div>", in: Self.followedBy)
        assertSays(web, "<div className=\"tdp-muted\">\(TaskDetailCopy.watchesUnavailable)</div>", in: Self.followedBy)
        assertSays(web, "<div className=\"tdp-muted\">\(TaskDetailCopy.nothingWatching)</div>", in: Self.followedBy)
        XCTAssertEqual(TaskDetailCopy.endedWatches(1), "1 ended watch")
        assertSays(web, "{ended.length} ended {ended.length === 1 ? 'watch' : 'watches'}", in: Self.followedBy)

        let editor = try source(Self.watchEditor)
        assertSays(editor, "okText={editing ? 'Save' : '\(TaskDetailCopy.follow)'}", in: Self.watchEditor)
        XCTAssertEqual(TaskDetailCopy.followTask, "\(TaskDetailCopy.follow) task", "the sheet's title for one task")
        assertSays(editor, "`Follow ${several ? `${targets.length} ${noun}s` : noun}`", in: Self.watchEditor)
        assertSays(editor, "<div className=\"watch-editor-label\">\(TaskDetailCopy.watchingLabel)</div>", in: Self.watchEditor)
        assertSays(editor, "`" + TaskDetailCopy.waitUntilTheTask.replacingOccurrences(of: "task", with: "${noun}") + "`",
                   in: Self.watchEditor)
        assertSays(editor, "<div className=\"watch-editor-label\">\(TaskDetailCopy.thenLabel)</div>", in: Self.watchEditor)
        assertSays(editor, "<span className=\"watch-editor-option\">\(TaskDetailCopy.notifyMe)</span>", in: Self.watchEditor)
        assertSays(editor, "{editing ? 'Deadline' : '\(TaskDetailCopy.stopWatchingAfter)'}", in: Self.watchEditor)
        // The hint, with the web's resume-only clause where the phone (Notify me only) has nothing.
        let hint = TaskDetailCopy.followDeadlineHint.replacingOccurrences(
            of: "expires.", with: "expires {!editing && action === 'RESUME_SESSION' ? ' and tells the session so' : ''}.")
        assertSays(editor, hint, in: Self.watchEditor)
        assertSays(editor, "'\(TaskDetailCopy.followMatchedAtOnce)'", in: Self.watchEditor)
        assertSays(editor, ": '\(TaskDetailCopy.following)',", in: Self.watchEditor)
    }
}
