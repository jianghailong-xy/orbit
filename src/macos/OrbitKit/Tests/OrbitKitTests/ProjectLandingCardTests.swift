import Foundation
import XCTest
@testable import OrbitKit

/// The landing as a card of its own on the project's sessions page (owner decision 2026-10-11,
/// docs/mocks/project-landing-card): the row's words and clocks, plus the branch, the several jobs
/// and — for a job the server judged timed out — where its runner stopped and whether a Retry
/// takes it. Web: `landingCard` in `src/web/src/components/ProjectPanoramaHeader.tsx`.
final class ProjectLandingCardTests: XCTestCase {
    private let now = RelativeTime.parse("2026-10-11T09:07:00.000Z")!

    private func iso(_ secondsBeforeNow: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: now.addingTimeInterval(-secondsBeforeNow))
    }

    /// One `inFlightJobs` element, its instants counted in seconds before `now`.
    private func job(_ id: String, kind: String = "LAND_TASK", state: String = "RUNNING",
                     phase: String? = "CHECK", taskId: String? = "t-c5", title: String? = "C5 · 托管 runner",
                     started: TimeInterval = 66, heartbeat: TimeInterval? = 0, runner: String? = "workstation-gpu",
                     timedOut: Bool = false, limit: Int? = 600,
                     retryable: Bool = false, skippable: Bool = false,
                     skipCheck: String? = nil) -> ProjectIntegrationJob {
        ProjectIntegrationJob(jobId: id, kind: kind, state: state, phase: phase, taskId: taskId, taskTitle: title,
                              generation: 1, startedAt: iso(started), queuedAt: iso(started + 32),
                              heartbeatAt: heartbeat.map { iso($0) }, runnerName: runner, retriedBy: nil,
                              timedOut: timedOut, limitSeconds: limit, retryable: retryable,
                              skippable: skippable, skipCheck: skipCheck)
    }

    /// One of the project's landings, as `landTasks` serves it — the branch a job lands on.
    private func landing(_ jobId: String, taskId: String = "t-c5", title: String = "C5 · 托管 runner",
                         targetRef: String = "refs/heads/project/34bmzOkov3xN2yLPrnsCk",
                         state: String = "RUNNING") -> ProjectLandTask {
        ProjectLandTask(taskId: taskId, taskTitle: title,
                        landTask: LandTaskIntegrationView(jobId: jobId, state: state, phase: "CHECK",
                                                          targetRef: targetRef))
    }

    /// The 9:07 screen: one task landing on the project branch, its runner reporting as it works.
    /// `inFlight` is the lead of whatever jobs it is handed, as the server's read gives it.
    private func running(_ jobs: [ProjectIntegrationJob] = [],
                         landTasks: [ProjectLandTask]? = nil) -> ProjectIntegrationView {
        let lead = jobs.first
        let title: String? = lead?.taskTitle ?? "C5 · 托管 runner"
        let state: String = lead?.state ?? "RUNNING"
        let started: String = lead?.startedAt ?? iso(66)
        let kind: String? = lead?.kind ?? "LAND_TASK"
        let phase: String? = lead?.phase ?? "CHECK"
        let heartbeat: String? = lead?.heartbeatAt ?? iso(0)
        let running = jobs.filter { $0.state == "RUNNING" }.count
        let queued = jobs.filter { $0.state == "QUEUED" }.count
        let landings: [ProjectLandTask] = landTasks ?? jobs.map { landing($0.jobId) }
        return ProjectIntegrationView(
            integratingCount: running, queuedCount: queued,
            inFlight: ProjectIntegrationInFlight(taskTitle: title, state: state, startedAt: started,
                                                 kind: kind, phase: phase, heartbeatAt: heartbeat),
            landTasks: landings, inFlightJobs: jobs)
    }

    /// The card is the row plus what the row had no room for: the branch it lands on and the
    /// sentence that takes the reader off the hook. Its clock, wait and freshness are the row's own.
    func testTheCardIsTheRowPlusTheBranchItsJobsAndTheSentence() throws {
        let view = running([job("j-c5")])
        let card = try XCTUnwrap(ProjectPage.landingCard(view, now: now, updatedAt: now))
        XCTAssertEqual(card.title, "Landing")
        XCTAssertEqual(card.word, "Landing")
        XCTAssertEqual(card.state, "checking")
        XCTAssertTrue(card.running)
        XCTAssertFalse(card.timedOut)
        XCTAssertEqual(card.what, "C5 · 托管 runner")
        XCTAssertEqual(card.target, "project/34bmzOkov3xN2yLPrnsCk")
        XCTAssertEqual(card.clock, "1m 6s")
        XCTAssertEqual(card.clockLabel, "Elapsed")
        XCTAssertEqual(card.updated, "Updated just now")
        XCTAssertEqual(card.jobs.map(\.jobId), ["j-c5"])
        XCTAssertNil(card.detail)
        XCTAssertNil(card.retryJobId)
        // The line the row drew, unchanged: the card cannot say anything the row could not.
        XCTAssertEqual(ProjectPage.landingLine(view, now: now, updatedAt: now),
                       ProjectPage.LandingLine(what: "C5 · 托管 runner", running: true, state: "checking",
                                               clock: "1m 6s", word: "Landing", updated: "Updated just now"))
    }

    /// Several jobs: the head counts them the way the row's name slot does, and the body names each
    /// one with its own state — a queued job is not painted with the running one's colour or word.
    func testSeveralJobsAreACountInTheHeadAndARowEachInTheBody() throws {
        let view = running([
            job("j-1"),
            job("j-2", state: "QUEUED", phase: nil, taskId: "t-d", title: "维护：dossier 重复发出",
                started: 32, heartbeat: nil, runner: nil, limit: nil),
        ])
        let card = try XCTUnwrap(ProjectPage.landingCard(view, now: now, updatedAt: now))
        XCTAssertEqual(card.title, "Landing 2 jobs")
        XCTAssertNil(card.what, "the count is the head's; the bodies are the rows")
        XCTAssertEqual(card.jobs.count, 2)
        XCTAssertEqual(card.jobs[0].title, "C5 · 托管 runner")
        XCTAssertEqual(card.jobs[0].state, "checking")
        XCTAssertTrue(card.jobs[0].running)
        XCTAssertEqual(card.jobs[1].title, "维护：dossier 重复发出")
        XCTAssertEqual(card.jobs[1].state, "queued")
        XCTAssertFalse(card.jobs[1].running)
        // The head, the clock and the branch are the LEAD job's: the one that is running.
        XCTAssertEqual(card.state, "checking")
        XCTAssertTrue(card.running)
        XCTAssertEqual(card.target, "project/34bmzOkov3xN2yLPrnsCk")

        // All of them waiting their turn: nothing spins, and the head says so.
        let queued = running([
            job("j-1", state: "QUEUED", phase: nil, heartbeat: nil, runner: nil, limit: nil),
            job("j-2", state: "QUEUED", phase: nil, taskId: "t-d", title: "维护：dossier 重复发出",
                heartbeat: nil, runner: nil, limit: nil),
        ])
        let waiting = try XCTUnwrap(ProjectPage.landingCard(queued, now: now, updatedAt: now))
        XCTAssertEqual(waiting.title, "Landing 2 jobs")
        XCTAssertEqual(waiting.state, "queued")
        XCTAssertFalse(waiting.running)
        XCTAssertEqual(waiting.clockLabel, "Queued for")
    }

    /// A lead the server judged timed out: the card says so, says where the runner stopped and
    /// whether a push was recorded, and offers Retry — the job list's own sentence, under the card.
    func testATimedOutLeadSaysWhereItStoppedAndOffersRetry() throws {
        let stuck = job("j-c5", started: 6_630, heartbeat: 6_620, timedOut: true, retryable: true)
        let view = running([stuck])
        let card = try XCTUnwrap(ProjectPage.landingCard(view, now: now, updatedAt: now))
        XCTAssertTrue(card.timedOut)
        XCTAssertFalse(card.running)
        XCTAssertEqual(card.title, "Landing")
        XCTAssertEqual(card.state, "Timed out")
        XCTAssertEqual(card.clock, "110m")
        XCTAssertEqual(card.clockLabel, "No report for")
        XCTAssertEqual(card.updated, "limit 10m")
        // The clock is the reader's own (ProjectPageTests pins it per zone), so it is read the card's way here.
        let tookIt = ProjectPage.landingClockTime(now.addingTimeInterval(-6_630))
        XCTAssertEqual(card.detail, "Runner workstation-gpu took it at \(tookIt) · stopped at checking · no push recorded")
        XCTAssertEqual(card.retryJobId, "j-c5")
    }

    /// Retry is the server's answer, never the timeout's: a job the server will not take a retry
    /// for is drawn without the press, and only the LEAD job's flag can offer one.
    func testRetryIsTheServersAnswerAndTheLeadJobs() throws {
        let refused = running([job("j-c5", started: 6_630, heartbeat: 6_620, timedOut: true, retryable: false)])
        XCTAssertNil(try XCTUnwrap(ProjectPage.landingCard(refused, now: now, updatedAt: now)).retryJobId)
        // A retryable job with a running lead that timed out... no: the lead is what the card
        // describes, and a lead nobody is waiting to retry leaves the card without a press.
        let behind = running([
            job("j-1"),
            job("j-2", taskId: "t-d", title: "维护：dossier 重复发出",
                started: 6_630, heartbeat: 6_620, timedOut: true, retryable: true),
        ])
        let card = try XCTUnwrap(ProjectPage.landingCard(behind, now: now, updatedAt: now))
        XCTAssertEqual(card.state, "checking")
        XCTAssertNil(card.retryJobId)
    }

    /// Nothing in flight is no card at all — and a server that lists no jobs still gets the card,
    /// with what it can say: no rows, no branch to name, and no Retry to offer.
    func testNothingLandingDrawsNoCardAndAnOlderServerDrawsWhatItCan() throws {
        XCTAssertNil(ProjectPage.landingCard(ProjectIntegrationView(), now: now, updatedAt: now))
        let older = ProjectIntegrationView(
            integratingCount: 1,
            inFlight: .init(taskTitle: "C5 · 托管 runner", state: "RUNNING", startedAt: iso(66),
                            kind: "LAND_TASK", phase: "CHECK", heartbeatAt: iso(0)))
        let card = try XCTUnwrap(ProjectPage.landingCard(older, now: now, updatedAt: now))
        XCTAssertEqual(card.title, "Landing")
        XCTAssertEqual(card.what, "C5 · 托管 runner")
        XCTAssertEqual(card.jobs, [])
        XCTAssertNil(card.target)
        XCTAssertNil(card.retryJobId)
    }

    /// A card led by a merge into main — a merge check, or the merge itself — says so, read off
    /// the lead's own kind on `inFlight`, so a server that lists no jobs says it too. That job
    /// lands no task, and the card holding only it draws no "Nothing to do" (board v4 04).
    func testACardLedByAMergeIntoMainSaysSoFromTheLeadsOwnKind() throws {
        for kind in ["CHECK_PROMOTION", "LAND_PROMOTION"] {
            let lone = running([job("j-m", kind: kind, taskId: nil, title: nil)], landTasks: [])
            XCTAssertTrue(try XCTUnwrap(ProjectPage.landingCard(lone, now: now, updatedAt: now)).mergeJob, kind)
            let older = ProjectIntegrationView(
                integratingCount: 1,
                inFlight: .init(taskTitle: nil, state: "RUNNING", startedAt: iso(66),
                                kind: kind, phase: "CHECK", heartbeatAt: iso(0)))
            XCTAssertTrue(try XCTUnwrap(ProjectPage.landingCard(older, now: now, updatedAt: now)).mergeJob, kind)
            // The same server counting two jobs: the card holds more than the merge job, so its
            // head names two jobs and it keeps the sentence it says about them.
            let olderTwo = ProjectIntegrationView(
                integratingCount: 1, queuedCount: 1,
                inFlight: .init(taskTitle: nil, state: "RUNNING", startedAt: iso(66),
                                kind: kind, phase: "CHECK", heartbeatAt: iso(0)))
            XCTAssertFalse(try XCTUnwrap(ProjectPage.landingCard(olderTwo, now: now, updatedAt: now)).mergeJob, kind)
        }
        // A task landing is none, even with a merge queued behind it, and nor is a job of no kind.
        XCTAssertFalse(try XCTUnwrap(ProjectPage.landingCard(running([job("j-c5")]), now: now, updatedAt: now)).mergeJob)
        let behind = running([job("j-c5"), job("j-m", kind: "LAND_PROMOTION", state: "QUEUED", phase: nil,
                                                taskId: nil, title: nil, heartbeat: nil, runner: nil, limit: nil)])
        XCTAssertFalse(try XCTUnwrap(ProjectPage.landingCard(behind, now: now, updatedAt: now)).mergeJob)
        let unnamed = ProjectIntegrationView(
            integratingCount: 1,
            inFlight: .init(taskTitle: nil, state: "RUNNING", startedAt: iso(66), heartbeatAt: iso(0)))
        XCTAssertFalse(try XCTUnwrap(ProjectPage.landingCard(unnamed, now: now, updatedAt: now)).mergeJob)
    }

    /// The branch is the job's own landing, short — and absent when the job is not one of the
    /// project's landings at all: a merge check lands no task and names no branch here.
    func testTheBranchIsTheJobsOwnLandingAndAbsentWhenNothingNamesIt() throws {
        let mergeCheck = running([job("j-check", kind: "CHECK_PROMOTION", taskId: nil, title: nil)],
                                 landTasks: [])
        XCTAssertNil(try XCTUnwrap(ProjectPage.landingCard(mergeCheck, now: now, updatedAt: now)).target)
        // `refs/heads/` is not what a person reads: the card shows the branch the way every other
        // page does.
        let plain = running([job("j-c5")], landTasks: [landing("j-c5", targetRef: "main")])
        XCTAssertEqual(try XCTUnwrap(ProjectPage.landingCard(plain, now: now, updatedAt: now)).target, "main")
        // And a landing that names no ref leaves the line off rather than drawing an empty one.
        let empty = running([job("j-c5")], landTasks: [landing("j-c5", targetRef: "")])
        XCTAssertNil(try XCTUnwrap(ProjectPage.landingCard(empty, now: now, updatedAt: now)).target)
    }

    /// "Land without the check" (§2.4 J-S5): offered for the card's one landing only where the
    /// server says the skip takes it. Web: `skipTaskId` in `landingCard`.
    func testTheSkipIsTheServersAnswerForTheCardsOneLanding() throws {
        let offered = try XCTUnwrap(ProjectPage.landingCard(running([job("j-c5", skippable: true)]),
                                                            now: now, updatedAt: now))
        XCTAssertEqual(offered.skipTaskId, "t-c5")
        XCTAssertNil(offered.skipNote)
        // An older server says nothing, and nothing is offered.
        XCTAssertNil(ProjectPage.landingCard(running([job("j-c5")]), now: now, updatedAt: now)?.skipTaskId)
        // Several jobs: which landing a single press would skip is not the card's to guess.
        let several = running([job("j-c5", skippable: true),
                               job("j-t2", state: "QUEUED", taskId: "t-t2", skippable: true)])
        XCTAssertNil(ProjectPage.landingCard(several, now: now, updatedAt: now)?.skipTaskId)
    }

    /// Where a skip stands, said in the place of "Nothing to do".
    func testWhereASkipStandsIsSaidInTheNotesPlace() throws {
        func note(_ skipCheck: String?) -> String? {
            ProjectPage.landingCard(running([job("j-c5", skipCheck: skipCheck)]), now: now, updatedAt: now)?.skipNote
        }
        XCTAssertEqual(note("STOPPING"), "Stopping — it lands again without the landing check.")
        XCTAssertEqual(note("SKIPPED"), "Landing without the landing check — you skipped it.")
        XCTAssertNil(note(nil))
    }

    /// The two fields decode from the server's job, and an older server's job reads as no skip.
    func testTheSkipFieldsDecodeAndDefaultToNone() throws {
        let sent = #"{"jobId":"j","kind":"LAND_TASK","state":"RUNNING","skippable":true,"skipCheck":"STOPPING"}"#
        let job = try JSONDecoder().decode(ProjectIntegrationJob.self, from: Data(sent.utf8))
        XCTAssertTrue(job.skippable)
        XCTAssertEqual(job.skipCheck, "STOPPING")
        let older = try JSONDecoder().decode(ProjectIntegrationJob.self,
                                             from: Data(#"{"jobId":"j","kind":"LAND_TASK","state":"RUNNING"}"#.utf8))
        XCTAssertFalse(older.skippable)
        XCTAssertNil(older.skipCheck)
    }
}
