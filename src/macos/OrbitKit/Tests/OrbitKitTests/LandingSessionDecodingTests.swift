import Foundation
import XCTest
@testable import OrbitKit

/// The landing reads' decode (contract §2.9 LS1/LS2/LS6): `GET /sessions/:id`'s `sessionKind` and
/// landing view, the list row's summary under the same key, the landing log page, the task read
/// port's `integration`, and the open item's landing fields — every one tolerant of a server that
/// predates it.
final class LandingSessionDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// The full landing view, as `GET /sessions/:id` answers a LANDING session.
    func testTheLandingDetailViewDecodes() throws {
        let detail = try decode(SessionDetail.self, """
        {
          "id": "landing-1",
          "sessionKind": "LANDING",
          "projectId": "project-1",
          "landing": {
            "sessionId": "landing-1",
            "projectId": "project-1",
            "subject": "PROMOTION",
            "taskId": null,
            "promotionId": "promo-1",
            "episode": 2,
            "openedAt": "2026-09-25T06:50:00.000Z",
            "settledAt": null,
            "settledAs": null,
            "phase": "CHECK",
            "round": 1,
            "checks": [],
            "liveness": "LIVE",
            "blockingReason": null,
            "todos": [{"id":"item-1","kind":"INTEGRATION_CHECK_FAILED","state":"OPEN",
                       "title":"Checks failed","waitingSince":"2026-09-25T06:51:00.000Z"}],
            "generations": [{"sessionId":"landing-1","episode":2,
                             "openedAt":"2026-09-25T06:50:00.000Z",
                             "settledAt":null,"settledAs":null}],
            "currentAttempt": {
              "jobId":"job-1","kind":"CHECK_PROMOTION","state":"RUNNING","generation":3,
              "phase":"CHECK","round":1,"step":null,"claim":1,"runnerName":"wikova",
              "sourceSessionId":null,"targetRef":"refs/heads/main",
              "startedAt":"2026-09-25T06:56:40.000Z",
              "heartbeatAt":"2026-09-25T06:58:30.000Z",
              "outputMovedAt":"2026-09-25T06:58:24.000Z",
              "progressProtocol":"v2",
              "check":{"name":"MERGE_CHECK","index":1,"count":3,"budgetSeconds":3600,
                       "startedAt":"2026-09-25T06:56:40.000Z"},
              "liveness":"LIVE","blockingReason":null,"timedOut":false,"limitSeconds":600,
              "retryable":false,"pushBoundaryPassed":false
            },
            "timeline": {
              "sections": [{
                "title":"Merge check · 1","jobId":"job-1","kind":"CHECK_PROMOTION",
                "generation":1,"state":"RUNNING",
                "entries":[{"id":"e1","seq":1,"kind":"CLAIMED",
                            "at":"2026-09-25T06:56:40.000Z","claim":1,"round":null,
                            "check":null,"phase":null,"step":null,"actor":{"type":"RUNNER"},
                            "reason":null,"data":null,
                            "text":"Claimed by runner wikova · claim 1"}]
              }],
              "facts": [{"kind":"FIX_TASK","text":"Filed as T9","data":null}],
              "truncated": false
            }
          }
        }
        """)
        XCTAssertTrue(detail.isLanding)
        let landing = try XCTUnwrap(detail.landing)
        XCTAssertEqual(landing.sessionId, "landing-1")
        XCTAssertEqual(landing.subject, "PROMOTION")
        XCTAssertEqual(landing.promotionId, "promo-1")
        XCTAssertEqual(landing.episode, 2)
        XCTAssertNil(landing.state, "a detail view carries no list summary state")
        XCTAssertFalse(landing.isSummary)
        XCTAssertEqual(landing.todos.first?.kind, "INTEGRATION_CHECK_FAILED")
        let attempt = try XCTUnwrap(landing.currentAttempt)
        XCTAssertEqual(attempt.kind, "CHECK_PROMOTION")
        XCTAssertEqual(attempt.generation, 3)
        XCTAssertEqual(attempt.check?.budgetSeconds, 3_600)
        XCTAssertEqual(attempt.check?.asProjectCheck.name, "MERGE_CHECK")
        XCTAssertFalse(attempt.pushBoundaryPassed)
        let timeline = try XCTUnwrap(landing.timeline)
        XCTAssertEqual(timeline.sections.first?.title, "Merge check · 1")
        XCTAssertEqual(timeline.sections.first?.entries.first?.text,
                       "Claimed by runner wikova · claim 1")
        XCTAssertNil(timeline.sections.first?.entries.first?.data)
        XCTAssertEqual(timeline.facts.first?.kind, "FIX_TASK")
        XCTAssertFalse(timeline.truncated)
        // A landing detail carries no derived source label about itself.
        XCTAssertNil(detail.sourceLanding)
    }

    /// A timeline line's `data`: the fields its sentence was written from, which its mark reads. A
    /// value that is not an object is read past, the way a missing one is.
    func testATimelineLinesDataDecodesAndAnUnreadableOneIsIgnored() throws {
        let entries = try decode([IntegrationTimelineEntry].self, """
        [
          {"id":"e1","seq":1,"kind":"CHECK_FINISHED","at":"2026-09-25T06:58:00.000Z","claim":1,
           "round":1,"check":{"name":"MERGE_CHECK","index":1},"phase":"CHECK","step":null,
           "actor":{"type":"RUNNER"},"reason":null,
           "data":{"name":"MERGE_CHECK","index":1,"exitCode":0,"expectedExitCode":0,
                   "timedOut":false,"durationMs":1022000,
                   "finishedAt":"2026-09-25T06:58:00.000Z"},
           "text":"Merge check passed · 17m 02s"},
          {"id":"e2","seq":2,"kind":"RESULT","at":"2026-09-25T06:58:01.000Z","claim":1,
           "round":null,"check":null,"phase":"PUSH","step":null,"actor":{"type":"RUNNER"},
           "reason":null,"data":{"state":"LANDED","requestedState":"LANDED","errorCode":null},
           "text":"Landed on main · 8ed0ea7"},
          {"id":"e3","seq":3,"kind":"RESULT","at":"2026-09-25T06:58:02.000Z","claim":1,
           "data":"LANDED","text":"Landed on main · 8ed0ea7"}
        ]
        """)
        XCTAssertEqual(entries.count, 3)
        XCTAssertEqual(entries[0].data?["exitCode"]?.intValue, 0)
        XCTAssertEqual(entries[0].data?["expectedExitCode"]?.intValue, 0)
        XCTAssertEqual(entries[0].data?["timedOut"]?.boolValue, false)
        XCTAssertTrue(entries[0].checkPassed)
        XCTAssertTrue(entries[0].succeeded)
        XCTAssertEqual(entries[1].data?["state"]?.stringValue, "LANDED")
        XCTAssertEqual(entries[1].data?["errorCode"], .null)
        XCTAssertTrue(entries[1].succeeded)
        XCTAssertNil(entries[2].data)
        XCTAssertEqual(entries[2].text, "Landed on main · 8ed0ea7")
        XCTAssertFalse(entries[2].succeeded, "no readable state is not a landing")
    }

    /// An older server sends neither field: the session still reads, as the conversation it was.
    func testAnOlderServersSessionDetailStillDecodes() throws {
        let detail = try decode(SessionDetail.self, """
        {"id":"s-1","status":"RUNNING","title":"An old conversation",
         "projectIntegrationRef":"project/p1"}
        """)
        XCTAssertFalse(detail.isLanding)
        XCTAssertNil(detail.landing)
        XCTAssertNil(detail.sessionKind)
        XCTAssertNil(detail.sourceLanding)
    }

    /// The list row's summary arrives under the same `landing` key, with a different shape: subject,
    /// state, and how it settled.
    func testTheListRowsLandingSummaryDecodesUnderTheSameKey() throws {
        let sessions = try decode([Session].self, """
        [
          {"id":"landing-1","title":"Landing · Finish the ledger","status":"SUCCEEDED",
           "sessionKind":"LANDING",
           "landing":{"subject":"TASK","state":"AWAITING_DECISION",
                      "settledAs":null,"settledAt":null}},
          {"id":"chat-1","title":"A conversation","status":"RUNNING"}
        ]
        """)
        XCTAssertEqual(sessions.count, 2)
        let landing = try XCTUnwrap(sessions[0].landing)
        XCTAssertEqual(landing.subject, "TASK")
        XCTAssertEqual(landing.state, "AWAITING_DECISION")
        XCTAssertNil(landing.settledAs)
        XCTAssertTrue(landing.isSummary)
        XCTAssertTrue(sessions[0].isLanding)
        XCTAssertNil(sessions[1].landing)
        XCTAssertFalse(sessions[1].isLanding)
    }

    /// The check output's page: chunks in production order, and the cursor that continues it.
    func testTheLandingLogPageDecodes() throws {
        let page = try decode(LandingLogPage.self, """
        {"jobId":"job-1","entries":[
          {"jobId":"job-1","claim":1,"round":2,"check":{"name":"MERGE_CHECK","index":1},
           "seq":0,"text":"npm test\\n","truncatedBytes":0,"at":"2026-09-25T06:57:00.000Z"},
          {"jobId":"job-1","claim":1,"round":2,"check":{"name":"MERGE_CHECK","index":1},
           "seq":1,"text":"...","truncatedBytes":4096,"at":"2026-09-25T06:57:01.000Z"}
        ],"nextCursor":"c2"}
        """)
        XCTAssertEqual(page.jobId, "job-1")
        XCTAssertEqual(page.entries.count, 2)
        XCTAssertEqual(page.entries[1].truncatedBytes, 4_096)
        XCTAssertEqual(page.entries[1].check.index, 1)
        XCTAssertEqual(page.nextCursor, "c2")
        // A landing with no attempt yet answers a null job and no entries.
        let empty = try decode(LandingLogPage.self, #"{"jobId":null,"entries":[],"nextCursor":null}"#)
        XCTAssertNil(empty.jobId)
        XCTAssertTrue(empty.entries.isEmpty)
    }

    /// The task read port's integration, including the newest `LAND_TASK` a task page's Landing
    /// section prints — the generation crosses as a decimal string.
    func testTheTaskReadPortsIntegrationDecodes() throws {
        let task = try decode(TaskItem.self, """
        {
          "id":"t1","title":"Finish the ledger","status":"DONE",
          "integration": {
            "state":"RUNNING","since":"2026-09-25T06:50:00.000Z","handler":null,
            "openItemId":null,"jobId":"job-1","checksRunningForMs":120000,
            "mainBranch":"main",
            "landTask": {
              "jobId":"job-1","state":"RUNNING","phase":"CHECK",
              "landingSessionId":"landing-1","errorCode":null,"generation":"4",
              "queuedAt":"2026-09-25T06:49:00.000Z","startedAt":"2026-09-25T06:50:00.000Z",
              "heartbeatAt":"2026-09-25T06:58:30.000Z","finishedAt":null,
              "targetRef":"refs/heads/project/p1","waitMs":60000,
              "blockingReason":null,"liveness":"LIVE","runnerName":"wikova"
            }
          }
        }
        """)
        let integration = try XCTUnwrap(task.integration)
        XCTAssertEqual(integration.state, "RUNNING")
        XCTAssertEqual(integration.mainBranch, "main")
        XCTAssertEqual(integration.checksRunningForMs, 120_000)
        let landTask = try XCTUnwrap(integration.landTask)
        XCTAssertEqual(landTask.landingSessionId, "landing-1")
        XCTAssertEqual(landTask.generation, "4")
        XCTAssertEqual(landTask.waitMs, 60_000)
        XCTAssertEqual(landTask.liveness, "LIVE")
        XCTAssertEqual(landTask.runnerName, "wikova")
        XCTAssertEqual(landTask.targetRef, "refs/heads/project/p1")
    }

    /// A task read from an older server, with no integration and a landTask missing every field the
    /// newer reads added, still decodes.
    func testAnOlderServersTaskReadStillDecodes() throws {
        let task = try decode(TaskItem.self, """
        {"id":"t1","title":"An old task","status":"OPEN"}
        """)
        XCTAssertNil(task.integration)

        let older = try decode(TaskIntegrationView.self, """
        {"state":"ON_INTEGRATION_LINE",
         "landTask":{"jobId":"job-1","state":"LANDED","phase":null,
                     "targetRef":"refs/heads/project/p1"}}
        """)
        XCTAssertEqual(older.state, "ON_INTEGRATION_LINE")
        let landTask = try XCTUnwrap(older.landTask)
        XCTAssertNil(landTask.landingSessionId)
        XCTAssertNil(landTask.generation)
        XCTAssertNil(landTask.heartbeatAt)
        XCTAssertNil(landTask.liveness)
        XCTAssertEqual(landTask.state, "LANDED")
    }

    /// The promotion's own landing session, and the two facts a confirmed merge's card reads.
    func testThePromotionCarriesItsLandingSessionAndCancelFacts() throws {
        let promotion = try decode(ProjectPromotionView.self, """
        {"promotionId":"p1","state":"CONFIRMED","sourceRef":"refs/heads/project/p1",
         "sourceSha":"aaaa","upstreamRef":"refs/heads/main","taskIds":["t1"],"tasks":[],
         "checks":[],"conflicts":[],"landingSessionId":"landing-1",
         "cancelRequested":true,"pushBoundaryPassed":false,
         "landsTreeSha":"5e5bfca0000","upstreamShaChecked":"bbbb","onPass":"MERGE"}
        """)
        XCTAssertEqual(promotion.landingSessionId, "landing-1")
        XCTAssertTrue(promotion.cancelRequested)
        XCTAssertFalse(promotion.pushBoundaryPassed)
        XCTAssertEqual(promotion.landsTreeSha, "5e5bfca0000")
        XCTAssertEqual(promotion.upstreamShaChecked, "bbbb")
        XCTAssertEqual(promotion.onPass, "MERGE")

        // Absent fields read as their absence, never as a failed read.
        let older = try decode(ProjectPromotionView.self, """
        {"promotionId":"p2","state":"CHECKING","sourceRef":"r","sourceSha":"s","upstreamRef":"u"}
        """)
        XCTAssertNil(older.landingSessionId)
        XCTAssertFalse(older.cancelRequested)
        XCTAssertFalse(older.pushBoundaryPassed)
    }

    /// The open item's landing fields: the session an OPEN_LANDING opens, the job an ABANDON ends,
    /// and the claim the X-E5 card's heading and consequence read.
    func testTheOpenItemCarriesItsLandingJobAndLease() throws {
        let items = try decode(ProjectOpenItemsView.self, """
        {"needsYou":[{
           "itemId":"item-1","kind":"LANDING_LEASE_EXPIRED","title":"A landing stopped reporting",
           "detailLine":"","waitingSince":"2026-09-25T06:30:00.000Z","assignee":"OWNER",
           "assigneeReason":"ESCALATED","escalateAt":null,
           "escalatedAt":"2026-09-25T06:57:00.000Z","taskId":"t1","sessionId":null,
           "landingSessionId":"landing-1","integrationJobId":"job-1",
           "actions":["ABANDON","OPEN_LANDING"],"primaryAction":"ABANDON",
           "lease":{"lastReportAt":"2026-09-25T06:30:00.000Z",
                    "leaseExpiredAt":"2026-09-25T06:40:00.000Z",
                    "jobKind":"LAND_TASK","generation":1,"phase":"CHECK","step":null,
                    "claimGeneration":1,"round":1,"checkCount":3,"runner":"wikova",
                    "progressProtocol":"v2","pushReported":false}
         }],"withCoordinator":[]}
        """)
        let row = try XCTUnwrap(items.needsYou.first)
        XCTAssertEqual(row.kind, .landingLeaseExpired)
        XCTAssertEqual(row.landingSessionId, "landing-1")
        XCTAssertEqual(row.integrationJobId, "job-1")
        XCTAssertEqual(row.actions, [.abandon, .openLanding])
        XCTAssertEqual(row.primaryAction, .abandon)
        let lease = try XCTUnwrap(row.lease)
        XCTAssertEqual(lease.jobKind, "LAND_TASK")
        XCTAssertEqual(lease.progressProtocol, "v2")
        XCTAssertFalse(lease.pushReported)
        XCTAssertEqual(lease.lastReportAt, "2026-09-25T06:30:00.000Z")
    }

    /// A delivery's payload names the landing its failure came from, and a payload an older server
    /// recorded simply has none.
    func testTheDeliveryCardCarriesItsLandingSession() {
        let card = OpenItemDelivery.parse(.object([
            "openItemDelivery": .object([
                "itemId": .string("item-1"), "kind": .string("INTEGRATION_CHECK_FAILED"),
                "title": .string("Checks failed"), "actions": .array([.string("OPEN_LANDING")]),
                "landingSessionId": .string("landing-1"),
            ]),
        ]))
        XCTAssertEqual(card?.landingSessionId, "landing-1")
        XCTAssertEqual(OpenItemDeliveryCard.actionLabels(card?.actions ?? []), ["Open landing"])
        XCTAssertNotNil(card.flatMap(OpenItemDeliveryCard.landingLink))

        let older = OpenItemDelivery.parse(.object([
            "openItemDelivery": .object([
                "itemId": .string("item-2"), "kind": .string("TASK_FAILED"),
                "title": .string("Task failed"),
            ]),
        ]))
        XCTAssertNil(older?.landingSessionId)
        XCTAssertNil(older.flatMap(OpenItemDeliveryCard.landingLink))
    }

    /// The source work session's derived label arrives on the detail read, and drives the chip.
    func testTheSourceSessionsLandingLabelDecodes() throws {
        let detail = try decode(SessionDetail.self, """
        {"id":"source-1","status":"SUCCEEDED",
         "sourceLanding":{"landingSessionId":"landing-1","subject":"TASK","state":"RUNNING",
                          "phase":"CHECK","settledAs":null,
                          "targetRef":"refs/heads/project/p1"}}
        """)
        let source = try XCTUnwrap(detail.sourceLanding)
        XCTAssertEqual(source.landingSessionId, "landing-1")
        XCTAssertEqual(source.state, "RUNNING")
        XCTAssertEqual(source.phase, "CHECK")
        let label = try XCTUnwrap(SessionProjectLandings.sourceLabel(source))
        XCTAssertEqual(label.text, "Landing · checking")
        XCTAssertEqual(label.tone, "run")
    }
}
