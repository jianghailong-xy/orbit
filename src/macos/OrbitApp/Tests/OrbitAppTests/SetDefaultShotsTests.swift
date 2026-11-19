import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// ImageRenderer frames of the real Set as default SwiftUI chrome (`RunnerEngineSetDefaultViews`,
/// the same views `RunnerEnginePage` draws), fed a fixture Runner — menu, confirmation, waiting line,
/// failed swap, and the done result with the DEFAULT chip. PNGs land in
/// `src/macos/build/evidence/set-default-macos/` for the evidence envelope.
@MainActor
final class SetDefaultShotsTests: XCTestCase {

    private static let work = "3fa91c2e"

    private func runner(accounts: [[String: Any]],
                        swap: [String: Any]? = nil) throws -> Runner {
        var object: [String: Any] = [
            "id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f", "name": "wikova", "status": "ONLINE",
            "online": true, "lastHeartbeatAt": "2026-09-29T00:14:52Z",
            "capabilities": ["claude-account-swap/v1", "claude-account-move/v1"],
            "engines": [["engine": "claude", "installed": true, "version": "2.1.284 (Claude Code)",
                         "auth": "yes", "accounts": accounts]],
        ]
        if let swap { object["claudeAccountSwap"] = swap }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func health(_ runner: Runner) throws -> RunnerEngineHealth {
        try XCTUnwrap(runner.engines?.first { $0.engine == "claude" })
    }

    private func line(_ runner: Runner, _ id: String) throws -> RunnerPageFormat.AccountLine {
        try XCTUnwrap(RunnerPageFormat.accountLines(try health(runner)).first { $0.id == id })
    }

    /// Repo-root `src/macos/build/evidence/set-default-macos` (gitignored build tree), found by walking
    /// up from this test file until `src/macos/OrbitApp/Package.swift` is visible.
    private var evidenceDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                let out = dir.appendingPathComponent("src/macos/build/evidence/set-default-macos")
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                return out
            }
            dir = dir.deletingLastPathComponent()
        }
        // Fallback: beside the OrbitApp package (src/macos/OrbitApp/build/…).
        let out = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("build/evidence/set-default-macos")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        return out
    }

    private func write<V: View>(_ name: String, _ view: V, size: CGSize) throws {
        let root = view
            .padding(24)
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(Color(nsColor: .windowBackgroundColor))
        let renderer = ImageRenderer(content: root)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage, "ImageRenderer produced no image for \(name)")
        let tiff = try XCTUnwrap(image.tiffRepresentation)
        let rep = try XCTUnwrap(NSBitmapImageRep(data: tiff))
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        let url = evidenceDir.appendingPathComponent("\(name).png")
        try png.write(to: url)
        XCTAssertGreaterThan(png.count, 1_000, "\(name) looks empty")
    }

    private let beforeAccounts: [[String: Any]] = [
        ["id": "default", "home": "/root/.claude", "auth": "yes"],
        ["id": work, "name": "Work", "home": "/root/.orbit/claude-accounts/3fa91c2e", "auth": "yes"],
    ]

    private let afterAccounts: [[String: Any]] = [
        ["id": "default", "name": "Work", "home": "/root/.claude", "auth": "yes"],
        ["id": work, "formerDefault": true, "email": "me@home.example",
         "home": "/root/.orbit/claude-accounts/3fa91c2e", "auth": "yes"],
    ]

    private func swap(status: String, waiting: Int = 0, message: String? = nil) -> [String: Any] {
        let waitingOn: [[String: Any]] = waiting < 1 ? [] : (1...waiting).map {
            ["id": "s-\($0)", "title": "Turn \($0)", "status": "RUNNING"]
        }
        return [
            "account": Self.work, "status": status,
            "message": message.map { $0 as Any } ?? NSNull(),
            "waitingOn": waitingOn, "foreignProcesses": [],
        ]
    }

    func testSetAsDefaultFramesFromRealViews() throws {
        let ready = try runner(accounts: beforeAccounts)
        let work = try line(ready, Self.work)
        let question = RunnerPageFormat.setDefaultQuestion(work, health: try health(ready), runner: ready)

        // 1 — menu open on the added account, Set as default + hint.
        try write("1-menu", VStack(alignment: .leading, spacing: 16) {
            Text("Claude Code · accounts").font(.orbitLabel).foregroundStyle(.secondary)
            RunnerEngineSetDefaultViews.AccountRow(runner: ready, line: work)
            RunnerEngineSetDefaultViews.MenuPanel(blocked: nil)
        }, size: CGSize(width: 420, height: 360))

        // 2 — confirmation.
        try write("2-confirmation", RunnerEngineSetDefaultViews.Confirm(question: question),
                  size: CGSize(width: 420, height: 280))

        // 3 — waiting line with a session count.
        let waiting = try runner(accounts: beforeAccounts, swap: swap(status: "pending", waiting: 2))
        let waitingLine = try line(waiting, Self.work)
        try write("3-waiting", VStack(alignment: .leading, spacing: 12) {
            Text("Claude Code · accounts").font(.orbitLabel).foregroundStyle(.secondary)
            RunnerEngineSetDefaultViews.AccountRow(runner: waiting, line: waitingLine)
        }, size: CGSize(width: 480, height: 180))

        // 4 — failed swap.
        let failed = try runner(accounts: beforeAccounts,
                                swap: swap(status: "failed", message: "the Keychain refused the write"))
        let failedLine = try line(failed, Self.work)
        try write("4-failed", VStack(alignment: .leading, spacing: 12) {
            Text("Claude Code · accounts").font(.orbitLabel).foregroundStyle(.secondary)
            RunnerEngineSetDefaultViews.AccountRow(runner: failed, line: failedLine)
        }, size: CGSize(width: 480, height: 200))

        // 5 — done: Work is Default with the DEFAULT chip; former Default named by email.
        let done = try runner(accounts: afterAccounts, swap: swap(status: "done"))
        let promoted = try line(done, "default")
        let former = try line(done, Self.work)
        XCTAssertEqual(promoted.name, "Work")
        XCTAssertTrue(promoted.isDefault)
        XCTAssertEqual(former.name, "me@home.example")
        try write("5-done", VStack(alignment: .leading, spacing: 16) {
            Text("Claude Code · accounts").font(.orbitLabel).foregroundStyle(.secondary)
            RunnerEngineSetDefaultViews.AccountRow(runner: done, line: promoted)
            Divider()
            RunnerEngineSetDefaultViews.AccountRow(runner: done, line: former)
        }, size: CGSize(width: 480, height: 220))

        for name in ["1-menu", "2-confirmation", "3-waiting", "4-failed", "5-done"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: evidenceDir.appendingPathComponent("\(name).png").path),
                          "missing \(name).png under \(evidenceDir.path)")
        }
    }
}
