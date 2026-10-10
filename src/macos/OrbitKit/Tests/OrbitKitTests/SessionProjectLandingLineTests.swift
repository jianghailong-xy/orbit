import Foundation
import XCTest
@testable import OrbitKit

/// The project row's second line while the platform lands work
/// (docs/mocks/project-sessions-landing/02). Web: `sessionProjectLanding.test.ts`.
final class SessionProjectLandingLineTests: XCTestCase {
    private let now = RelativeTime.parse("2026-10-05T11:24:00Z")!

    private func ago(_ minutes: Double) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutes * 60))
    }

    private func session(_ id: String, role: SessionProjectMembership.Role, state: SessionRunState = .awaitingInput,
                         approvals: Int = 0, tool: String? = nil) -> Session {
        Session(id: id, title: id, status: .awaitingInput, runState: state,
                agentId: "w1", assignedRunnerId: nil, pendingApprovals: approvals,
                branch: nil, updatedAt: nil,
                projectId: role == .coordinator ? "p1" : nil,
                projectTitle: role == .coordinator ? "Project one" : nil,
                lastAssistantText: "Last reply", lastToolUse: tool,
                createdAt: ago(600), lastTurnAt: ago(1),
                projectMembership: SessionProjectMembership(projectId: "p1", projectTitle: "Project one",
                                                            projectStatus: .open, role: role))
    }

    private func queued(_ count: Int = 1) -> ProjectListIntegration {
        ProjectListIntegration(line: .main, ref: "main", activeJobCount: count,
                               inFlight: ProjectIntegrationInFlight(state: "QUEUED", startedAt: ago(13),
                                                                    kind: "LAND_PROMOTION"))
    }

    private func project(_ integration: ProjectListIntegration?, held: ProjectListCoordinatorItems? = nil) -> ProjectSummary {
        ProjectSummary(id: "p1", title: "Project one", lastActivityAt: ago(1),
                       attention: ProjectListAttention(coordinatorItems: held), integration: integration,
                       taskCounts: ProjectSidebarTaskCounts(done: 12, failed: 0, total: 15))
    }

    private func row(_ sessions: [Session], _ summary: ProjectSummary) -> SessionProjectRow? {
        SessionProjectGrouping.listing(sessions, folders: [], projects: [summary], view: .open, byTag: false,
                                       now: now).projects.first
    }

    func testTheLineSaysTheJobItsStateAndItsWaitInMinutes() {
        XCTAssertEqual(SessionProjectCopy.landingLine(queued(), now: now),
                       SessionLine(text: "Merge to main · queued · 13m", tone: .queued))
        let landing = ProjectListIntegration(line: .main, ref: "main", activeJobCount: 1, inFlight:
            ProjectIntegrationInFlight(taskTitle: "P5：接通 Web、macOS 和 iOS", state: "RUNNING", startedAt: ago(4),
                                       kind: "LAND_TASK", phase: "CHECK", heartbeatAt: ago(0)))
        XCTAssertEqual(SessionProjectCopy.landingLine(landing, now: now),
                       SessionLine(text: "Landing · checking · 4m · P5：接通 Web、macOS 和 iOS", tone: .running))
    }

    func testSeveralJobsAreCountedInsteadOfNamingOneTask() {
        let two = ProjectListIntegration(line: .main, ref: "main", activeJobCount: 2, inFlight:
            ProjectIntegrationInFlight(taskTitle: "P5", state: "RUNNING", startedAt: ago(4),
                                       kind: "LAND_TASK", phase: "REBASE", heartbeatAt: ago(1)))
        XCTAssertEqual(SessionProjectCopy.landingLine(two, now: now),
                       SessionLine(text: "Landing 2 jobs · rebasing · 4m", tone: .running))
    }

    /// A runner that has stopped reporting says exactly that, in the state slot — and never reads
    /// as a timeout, which is the job's own verdict and lives in the server's `blockingReason`.
    func testAStalledRunnerGoesQuietAndOlderServersFallBackToTheCount() {
        let stalled = ProjectListIntegration(line: .main, ref: "main", activeJobCount: 1, inFlight:
            ProjectIntegrationInFlight(state: "RUNNING", startedAt: ago(30), kind: "CHECK_PROMOTION",
                                       phase: "CHECK", heartbeatAt: ago(11)))
        XCTAssertEqual(SessionProjectCopy.landingLine(stalled, now: now),
                       SessionLine(text: "Merge check · no report for 11m · 30m", tone: .queued))
        XCTAssertFalse(SessionProjectCopy.landingLine(stalled, now: now)!.text.lowercased().contains("timed out"))
        // A claim whose runner has not reported once says that; one that is reporting keeps its phase.
        let never = ProjectListIntegration(line: .main, ref: "main", activeJobCount: 1, inFlight:
            ProjectIntegrationInFlight(taskTitle: "P5", state: "RUNNING", startedAt: ago(4),
                                       kind: "LAND_TASK", phase: "FETCH"))
        XCTAssertEqual(SessionProjectCopy.landingLine(never, now: now),
                       SessionLine(text: "Landing · no report yet · 4m · P5", tone: .queued))
        XCTAssertEqual(SessionProjectCopy.landingLine(ProjectListIntegration(line: .main, ref: "main", activeJobCount: 1), now: now),
                       SessionLine(text: "Landing · 1 job", tone: .queued))
        XCTAssertNil(SessionProjectCopy.landingLine(ProjectListIntegration(line: .main, ref: "main", activeJobCount: 0), now: now))
        XCTAssertNil(SessionProjectCopy.landingLine(nil, now: now))
    }

    func testALandingReplacesAnIdleCoordinatorsLineAndKeepsItsTarget() {
        let out = row([session("coordinator", role: .coordinator)], project(queued()))
        XCTAssertEqual(out?.line, SessionLine(text: "Merge to main · queued · 13m", tone: .queued))
        XCTAssertEqual(out?.target, .session("coordinator"))
    }

    func testALandingYieldsToACoordinatorMidTurnAHeldExceptionAndAnApproval() {
        let working = session("coordinator", role: .coordinator, state: .running, tool: "Edit")
        XCTAssertEqual(row([working], project(queued()))?.line.text, "Running Edit…")
        let held = ProjectListCoordinatorItems(count: 1, leadKind: .integrationCheckFailed,
                                               oldestWaitingSince: ago(12), nextEscalationAt: nil)
        XCTAssertEqual(row([session("coordinator", role: .coordinator)], project(queued(), held: held))?.line.text,
                       "Checks failed · 12m")
        let asking = session("coordinator", role: .coordinator, approvals: 1)
        XCTAssertEqual(row([asking], project(queued()))?.line.tone, .approval)
    }

    func testWithoutACoordinatorTheLandingIsSaidAndTheRowOpensTheProject() {
        let out = row([session("worker", role: .task)], project(queued()))
        XCTAssertEqual(out?.line.text, "Merge to main · queued · 13m")
        XCTAssertEqual(out?.target, .project("p1"))
    }

    /// A merge and a sync name the project's main branch: the one the sidebar row carries
    /// (`GET /projects/sidebar`'s `mainBranch`), main for a row that names none. Web:
    /// `sessionProjectLanding.test.ts` › "the landing line, by the project's main branch".
    func testTheLineNamesTheProjectsMainBranch() {
        XCTAssertEqual(SessionProjectCopy.landingLine(queued(), now: now, main: "master"),
                       SessionLine(text: "Merge to master · queued · 13m", tone: .queued))
        let syncing = ProjectListIntegration(line: .projectBranch, ref: "project/p1", activeJobCount: 1, inFlight:
            ProjectIntegrationInFlight(taskTitle: "P5", state: "RUNNING", startedAt: ago(4),
                                       kind: "LAND_TASK", phase: "MAIN_SYNC", heartbeatAt: ago(0)))
        XCTAssertEqual(SessionProjectCopy.landingLine(syncing, now: now, main: "master"),
                       SessionLine(text: "Landing · syncing master · 4m · P5", tone: .running))
        XCTAssertEqual(SessionProjectCopy.landingLine(syncing, now: now)?.text, "Landing · syncing main · 4m · P5")

        // Through the project row, off the sidebar row's own read.
        let summary = ProjectSummary(id: "p1", title: "Project one", lastActivityAt: ago(1),
                                     attention: ProjectListAttention(), integration: queued(),
                                     taskCounts: ProjectSidebarTaskCounts(done: 12, failed: 0, total: 15),
                                     mainBranch: "master")
        XCTAssertEqual(row([session("coordinator", role: .coordinator)], summary)?.line.text,
                       "Merge to master · queued · 13m")
    }

    func testNothingLandingLeavesTheCoordinatorsLineAlone() {
        XCTAssertEqual(row([session("coordinator", role: .coordinator)],
                           project(ProjectListIntegration(line: .main, ref: "main", activeJobCount: 0)))?.line.text,
                       "Last reply")
    }
}
