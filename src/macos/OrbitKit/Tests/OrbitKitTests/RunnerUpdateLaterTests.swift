import Foundation
import XCTest
@testable import OrbitKit

/// Later (docs/runner-update-drain-design.md §2, D1): the three times in the reader's zone, the Mac's
/// menu rows (the web's words, board 3 ⑦), iOS's action sheet (board 5) and the request body.
final class RunnerUpdateLaterTests: XCTestCase {
    private var shanghai: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return calendar
    }
    private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    func testAnHourFromNowTheNextTwoAMAndNineTomorrowInTheReadersZone() {
        let now = at("2026-11-12T03:57:30Z") // 11:57:30 in Shanghai
        XCTAssertEqual(RunnerUpdateLater.until(.hour, now: now, calendar: shanghai), at("2026-11-12T04:57:30Z"))
        XCTAssertEqual(RunnerUpdateLater.until(.tonight, now: now, calendar: shanghai), at("2026-11-12T18:00:00Z"))
        XCTAssertEqual(RunnerUpdateLater.until(.tomorrow, now: now, calendar: shanghai), at("2026-11-13T01:00:00Z"))
    }

    func testAfterMidnightTonightIsStillTodaysTwoAMUntilItPasses() {
        let halfPastMidnight = at("2026-11-12T16:30:00Z") // 00:30 on 11-13 in Shanghai
        XCTAssertEqual(RunnerUpdateLater.until(.tonight, now: halfPastMidnight, calendar: shanghai), at("2026-11-12T18:00:00Z"))
        XCTAssertEqual(RunnerUpdateLater.until(.tomorrow, now: halfPastMidnight, calendar: shanghai), at("2026-11-14T01:00:00Z"))
        let twoAM = at("2026-11-12T18:00:00Z")
        XCTAssertEqual(RunnerUpdateLater.until(.tonight, now: twoAM, calendar: shanghai), at("2026-11-13T18:00:00Z"))
    }

    func testTheMacMenuReadsAsTheWebs() {
        let rows = RunnerUpdateLater.menuRows(now: at("2026-11-12T03:57:00Z"), calendar: shanghai)
        XCTAssertEqual(rows.map(\.label), ["Postpone 1 hour", "Postpone until tonight", "Postpone until tomorrow"])
        XCTAssertEqual(rows.map(\.detail), ["until 12:57", "02:00", "09:00"])
    }

    func testTheIOSActionSheetReadsAsBoardFive() {
        let rows = RunnerUpdateLater.sheetRows(now: at("2026-11-12T03:57:00Z"), calendar: shanghai)
        XCTAssertEqual(rows.map(\.label), ["In 1 Hour", "Tonight at 02:00", "Tomorrow at 09:00"])
        XCTAssertEqual(rows.map(\.until), [at("2026-11-12T04:57:00Z"), at("2026-11-12T18:00:00Z"), at("2026-11-13T01:00:00Z")])
        XCTAssertEqual(RunnerUpdateLater.sheetMessage(version: "0.1.254", machine: "studio-mac"),
                       "Postpone the 0.1.254 update on studio-mac. It takes work again right away.")
        XCTAssertEqual(RunnerUpdateLater.sheetMessage(version: nil, machine: nil),
                       "Postpone the update. It takes work again right away.")
    }

    func testTheRequestCarriesTheTimeAndTheReadersZone() throws {
        let body = RunnerUpdateLater.request(until: at("2026-11-12T18:00:00Z"), timeZone: TimeZone(identifier: "Asia/Shanghai")!)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: String]
        XCTAssertEqual(json, ["until": "2026-11-12T18:00:00.000Z", "timeZone": "Asia/Shanghai"])
    }

    /// The path and body the web posts (`runnerUpdateLater.ts`), and the shared request's field names.
    func testTheRequestIsTheWebsAndTheServers() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/shared/src/dto.ts").path) {
            dir = dir.deletingLastPathComponent()
            XCTAssertNotEqual(dir.path, "/", "repo root not found")
            if dir.path == "/" { return }
        }
        let api = try String(contentsOf: dir.appendingPathComponent("src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift"), encoding: .utf8)
        let web = try String(contentsOf: dir.appendingPathComponent("src/web/src/lib/runnerUpdateLater.ts"), encoding: .utf8)
        let shared = try String(contentsOf: dir.appendingPathComponent("src/shared/src/dto.ts"), encoding: .utf8)
        XCTAssertTrue(api.contains(#"try await post("runners/\(id)/self-update/postpone""#))
        XCTAssertTrue(web.contains("`/runners/${runnerId}/self-update/postpone`"))
        XCTAssertTrue(shared.contains("export interface RunnerSelfUpdatePostponeRequest {\n  until: string;\n  timeZone?: string;\n}"))
    }

    /// The three surfaces draw the one control: the queued page, the queued message's popover and the
    /// runner page's Update card (Change ▾ and Update Now… once postponed). iOS uses the action sheet.
    func testTheThreeSurfacesDrawLater() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp").path) {
            dir = dir.deletingLastPathComponent()
            if dir.path == "/" { return XCTFail("repo root not found") }
        }
        let app = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp/Views")
        let read = { (name: String) in try String(contentsOf: app.appendingPathComponent(name), encoding: .utf8) }
        let control = try read("RunnerUpdateLaterControl.swift")
        XCTAssertTrue(control.contains("#if os(iOS)"))
        XCTAssertTrue(control.contains(".confirmationDialog(RunnerUpdateLater.sheetMessage(version: version, machine: machine)"))
        XCTAssertTrue(control.contains("RunnerUpdateLater.sheetRows(now: Date())"))
        XCTAssertTrue(control.contains("RunnerUpdateLater.menuRows(now: Date())"))
        XCTAssertTrue(control.contains("app.runners?.postponeUpdate(runnerID, until: until)"))

        let updating = try read("Console/RunnerUpdatingViews.swift")
        XCTAssertEqual(updating.components(separatedBy: "RunnerUpdateLaterControl(runnerID:").count - 1, 2,
                       "the queued page and the popover each draw Later")
        let console = try read("Console/ConsoleView.swift")
        XCTAssertTrue(console.contains("runnerID: console.runnerID)"))
        XCTAssertTrue(console.contains("RunnerUpdatingQueuedView(session: session, machine: console.runnerName, runnerID: console.runnerID,"))

        let page = try read("SkillsRunnersView.swift")
        XCTAssertTrue(page.contains(#"if card.phase == "draining" || card.phase == "postponed" {"#))
        XCTAssertTrue(page.contains(#"change: card.phase == "postponed")"#))
        XCTAssertTrue(page.contains("Button(RunnerPageCopy.RUNNER_UPDATE_NOW) { confirmingUpdateNow = true }"))
        XCTAssertTrue(page.contains("Button(RunnerPageCopy.RUNNER_UPDATE_NOW_CONFIRM) { updateRunner() }"))
    }
}
