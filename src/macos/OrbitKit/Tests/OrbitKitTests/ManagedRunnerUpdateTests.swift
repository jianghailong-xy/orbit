import Foundation
import XCTest
@testable import OrbitKit

/// Orbit Cloud's Update card, confirmation and version line (docs/managed-runner-update-now-design.md, board 5),
/// from the status's `update` field: available, busy confirmation, restarting, updated, current (no card) and
/// a reader who is not the owner (no button).
final class ManagedRunnerUpdateTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private let now = Date(timeIntervalSince1970: 1_794_997_600)   // 2026-11-18T10:26:40Z

    override func tearDown() {
        ManagedRunnerRunningBuild.build = nil
        super.tearDown()
    }

    private func status(update: String? = nil, state: String = "READY") throws -> ManagedRunnerStatus {
        let tail = update.map { ", \"update\": \($0)" } ?? ""
        let json = """
        {"contractVersion": 1, "enabled": true, "revision": 3, "managementState": "\(state)", "desiredState": "RUNNING",
         "runnerId": "runner-1", "workspaceId": null, "heartbeatStatus": "ONLINE", "lastHeartbeatAt": null, "usable": true,
         "reason": null, "retryAfter": null, "initialProvider": "claude",
         "actions": {"canEnsure": false, "canWake": false, "canSleep": true, "canRetry": false, "canDelete": false}\(tail)}
        """
        return try JSONDecoder().decode(ManagedRunnerStatus.self, from: Data(json.utf8))
    }

    private func update(_ phase: String, extra: String = "") -> String {
        """
        {"running": {"sha": "95884b154feb3d4e2a575fb012c4185b20c282ac", "builtAt": "2026-11-16T09:00:00Z"},
         "current": {"sha": "1a2b3c4d5e6f", "builtAt": "2026-11-18T08:00:00Z"}, "phase": "\(phase)"\(extra)}
        """
    }

    func testAvailableShowsTheCardAndUpdateNow() throws {
        let status = try status(update: update("available"))
        XCTAssertEqual(status.update?.running.sha.prefix(7), "95884b1")
        let card = try XCTUnwrap(ManagedRunnerUpdateLogic.card(status: status, now: now, timeZone: utc))
        XCTAssertEqual(card.phase, "available")
        XCTAssertEqual(card.title, "The Nov 18 build is available")
        XCTAssertEqual(card.body, "It moves the next time this runner is idle. Update Now restarts it on the new build now.")
        XCTAssertFalse(card.warn)
        XCTAssertTrue(card.canUpdateNow)
        XCTAssertTrue(ManagedRunnerUpdateLogic.showsDot(status), "the machine row's update dot")
    }

    func testBusyConfirmationNamesTurnsAndBackgroundJobs() throws {
        let body = """
        {"code": "MANAGED_RUNNER_BUSY", "message": "busy", "work": [],
         "turns": [{"sessionId": "s1", "title": "Fix login redirect", "startedAt": "2026-11-18T10:08:40Z"},
                   {"sessionId": "s2", "title": "Backfill shard rows", "startedAt": "2026-11-18T09:22:40Z"}],
         "backgroundJobs": 3}
        """
        let busy = try XCTUnwrap(ManagedRunnerUpdateLogic.busy(from: APIError.http(status: 409, body: body)))
        XCTAssertNil(ManagedRunnerUpdateLogic.busy(from: APIError.http(status: 409, body: "{\"code\":\"MANAGED_RUNNER_CURRENT\"}")))
        XCTAssertNil(ManagedRunnerUpdateLogic.busy(from: APIError.http(status: 500, body: body)))
        let confirmation = ManagedRunnerUpdateLogic.confirmation(
            busy, build: ManagedRunnerBuild(sha: "1a2b3c4d", builtAt: "2026-11-18T08:00:00Z"), now: now, timeZone: utc)
        XCTAssertEqual(confirmation.title, "Update Orbit Cloud now?")
        XCTAssertEqual(confirmation.body, "It stops 2 turns and restarts on the Nov 18 build. Each continues where it stopped.")
        XCTAssertEqual(confirmation.turns, ["Fix login redirect · 18 min", "Backfill shard rows · 1 h 4 min"])
        XCTAssertEqual(confirmation.jobsNote, "3 background jobs stop too.")
        XCTAssertEqual(confirmation.confirm, "Interrupt 2 Turns and Update")
        XCTAssertTrue(confirmation.message.contains("3 background jobs stop too."))
    }

    func testBusyConfirmationOfOneTurnAndOneJob() throws {
        let busy = try JSONDecoder().decode(ManagedRunnerBusy.self, from: Data(
            "{\"code\":\"MANAGED_RUNNER_BUSY\",\"turns\":[{\"sessionId\":\"s1\",\"title\":null,\"startedAt\":null}],\"backgroundJobs\":1}".utf8))
        let confirmation = ManagedRunnerUpdateLogic.confirmation(busy, build: ManagedRunnerBuild(sha: "1a2b3c4d"), now: now)
        XCTAssertEqual(confirmation.turns, ["Untitled session"])
        XCTAssertEqual(confirmation.body, "It stops 1 turn and restarts on the build 1a2b3c4. It continues where it stopped.")
        XCTAssertEqual(confirmation.jobsNote, "1 background job stops too.")
        XCTAssertEqual(confirmation.confirm, "Interrupt 1 Turn and Update")
    }

    func testRestartingHasNoButton() throws {
        let restarting = try status(update: update("updating"))
        let card = try XCTUnwrap(ManagedRunnerUpdateLogic.card(status: restarting, now: now, timeZone: utc))
        XCTAssertEqual(card.phase, "updating")
        XCTAssertEqual(card.title, "Restarting into the Nov 18 build…")
        XCTAssertEqual(card.tag, "Restarting")
        XCTAssertEqual(card.body, "Usually under a minute.")
        XCTAssertTrue(card.warn)
        XCTAssertFalse(card.canUpdateNow)
        XCTAssertFalse(ManagedRunnerUpdateLogic.showsDot(restarting), "nothing left to press")
        let waiting = try status(update: update("updating", extra: ", \"waitsForIdle\": true"))
        XCTAssertEqual(ManagedRunnerUpdateLogic.card(status: waiting, now: now, timeZone: utc)?.body,
                       "It restarts once the runner is idle.")
    }

    func testUpdatedFollowsARestartForADay() throws {
        let updating = try status(update: update("updating"))
        let current = try status()
        let mark = ManagedRunnerUpdateLogic.observe(previous: updating, next: current, updated: nil, now: now)
        XCTAssertEqual(mark?.build.sha, "1a2b3c4d5e6f")
        let card = try XCTUnwrap(ManagedRunnerUpdateLogic.card(status: current, updated: mark, now: now.addingTimeInterval(60), timeZone: utc))
        XCTAssertEqual(card.phase, "updated")
        XCTAssertEqual(card.title, "Updated to the Nov 18 build")
        XCTAssertEqual(card.tag, "10:26")
        XCTAssertFalse(card.canUpdateNow)
        XCTAssertNil(ManagedRunnerUpdateLogic.card(status: current, updated: mark, now: now.addingTimeInterval(25 * 3600), timeZone: utc))
        // A read that fails keeps the mark; a new update ends it.
        XCTAssertEqual(ManagedRunnerUpdateLogic.observe(previous: current, next: nil, updated: mark, now: now), mark)
        XCTAssertNil(ManagedRunnerUpdateLogic.observe(previous: current, next: updating, updated: mark, now: now))
        // Only a READY runner that was updating has finished.
        let asleep = try status(state: "SLEEPING")
        XCTAssertNil(ManagedRunnerUpdateLogic.observe(previous: updating, next: asleep, updated: nil, now: now))
    }

    func testCurrentHasNoCardAndNoDot() throws {
        let current = try status()
        XCTAssertNil(current.update)
        XCTAssertNil(ManagedRunnerUpdateLogic.card(status: current, now: now))
        XCTAssertFalse(ManagedRunnerUpdateLogic.showsDot(current))
        XCTAssertNil(ManagedRunnerUpdateLogic.card(status: nil, now: now))
    }

    func testANonOwnerSeesTheCardWithoutTheButton() throws {
        let card = try XCTUnwrap(ManagedRunnerUpdateLogic.card(status: try status(update: update("available")),
                                                               isOwner: false, now: now, timeZone: utc))
        XCTAssertEqual(card.phase, "available")
        XCTAssertFalse(card.canUpdateNow)
    }

    func testAnUnknownPhaseDrawsNoCard() throws {
        XCTAssertNil(ManagedRunnerUpdateLogic.card(status: try status(update: update("rolling")), now: now))
    }

    func testTheVersionLineNamesTheRunningBuild() throws {
        let running = ManagedRunnerBuild(sha: "95884b154feb3d4e2a575fb012c4185b20c282ac", builtAt: "2026-11-16T09:00:00Z")
        XCTAssertEqual(ManagedRunnerUpdateLogic.buildLine(running, timeZone: utc), "Build 95884b1 · Nov 16")
        // The date comes from the status's `update.running`, when its sha is the runner's.
        ManagedRunnerRunningBuild.build = running
        let line = RunnerAttention.runnerVersionLine("managed-95884b154feb3d4e2a575fb012c4185b20c282ac", managed: true)
        XCTAssertTrue(line?.hasPrefix("Build 95884b1 · ") == true, line ?? "nil")
        XCTAssertNotEqual(line, "Kept up to date by Orbit")
        XCTAssertEqual(RunnerAttention.runnerVersionLine("managed-95884b154feb3d4e2a575fb012c4185b20c282ac", managed: true, known: nil),
                       "Build 95884b1")
        XCTAssertEqual(RunnerAttention.runnerVersionLine("0.1.190", managed: true, known: nil), "v0.1.190")
    }

    func testTheBodyOfUpdateNowIsTheInterruptFlag() throws {
        let data = try JSONEncoder().encode(ManagedRunnerUpdateNowRequest(interruptTurns: true))
        XCTAssertEqual(String(data: data, encoding: .utf8), "{\"interruptTurns\":true}")
    }
}
