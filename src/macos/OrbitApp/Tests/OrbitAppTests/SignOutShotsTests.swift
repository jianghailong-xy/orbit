import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// ImageRenderer frames of Default's Sign out… flow, built from the page's own words and rules
/// (`RunnerPageFormat.offersSignOut` / `signOutQuestion` / `signOutAgainQuestion`, `RunnerAccountCopy`),
/// fed a fixture Runner. PNGs land in `src/macos/build/evidence/sign-out-macos/` (gitignored).
@MainActor
final class SignOutShotsTests: XCTestCase {

    private func runner(auth: String, declared: Bool = true, failedSessions: Int = 0) throws -> Runner {
        var object: [String: Any] = [
            "id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f", "name": "wikova", "status": "ONLINE",
            "online": true, "lastHeartbeatAt": "2026-09-29T00:14:52Z",
            "capabilities": declared ? ["claude-default-sign-out/v1"] : [],
            "engines": [["engine": "claude", "installed": true, "version": "2.1.284 (Claude Code)",
                         "auth": auth, "accounts": [["id": "default", "home": "/root/.claude", "auth": auth]]]],
        ]
        if failedSessions > 0 {
            object["accountRemove"] = [
                "engine": "claude", "account": "default", "status": "failed", "message": "in use",
                "sessions": (1...failedSessions).map { ["id": "s\($0)", "title": "Turn \($0)", "status": "RUNNING"] },
            ]
        }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func line(_ runner: Runner) throws -> RunnerPageFormat.AccountLine {
        let health = try XCTUnwrap(runner.engines?.first { $0.engine == "claude" })
        return try XCTUnwrap(RunnerPageFormat.accountLines(health).first { $0.isDefault })
    }

    private var evidenceDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                let out = dir.appendingPathComponent("src/macos/build/evidence/sign-out-macos")
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                return out
            }
            dir = dir.deletingLastPathComponent()
        }
        let out = URL(fileURLWithPath: "/tmp/sign-out-macos")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        return out
    }

    private func write<V: View>(_ name: String, _ view: V, size: CGSize) throws {
        let root = view.padding(24).frame(width: size.width, height: size.height, alignment: .top)
            .background(Color(nsColor: .windowBackgroundColor))
        let renderer = ImageRenderer(content: root)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage)
        let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: evidenceDir.appendingPathComponent("\(name).png"))
        XCTAssertGreaterThan(png.count, 1_000, "\(name) looks empty")
    }

    private func menu(offered: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(["Rename…", "Sign In Again", "Pause…"], id: \.self) { title in
                Text(title).padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if offered {
                Divider()
                Label(RunnerAccountCopy.RUNNER_DEFAULT_SIGN_OUT, systemImage: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(RunnerInk.red)
                    .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
        .frame(width: 280)
        .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
    }

    private func head(_ runner: Runner) throws -> some View {
        let l = try line(runner)
        return RunnerEngineSetDefaultViews.AccountHead(
            line: l, status: RunnerPageFormat.authStatus(l.auth)?.text,
            statusTone: RunnerPageFormat.authStatus(l.auth)?.tone ?? .muted)
    }

    func testSignOutFramesFromRealCopyAndRules() throws {
        let signedIn = try runner(auth: "yes")
        let l = try line(signedIn)
        XCTAssertTrue(RunnerPageFormat.offersSignOut(l, engine: "claude", runner: signedIn))

        try write("1-menu", VStack(alignment: .leading, spacing: 16) {
            Text("Claude Code · accounts").font(.orbitLabel).foregroundStyle(.secondary)
            try! head(signedIn)
            menu(offered: true)
        }, size: CGSize(width: 420, height: 360))

        let q = RunnerPageFormat.signOutQuestion(l, engine: "claude", runner: signedIn)
        try write("2-confirmation",
                  RunnerEngineSetDefaultViews.Confirm(question: q, confirm: RunnerAccountCopy.RUNNER_DEFAULT_SIGN_OUT_CONFIRM),
                  size: CGSize(width: 420, height: 300))

        let refused = try runner(auth: "yes", failedSessions: 2)
        let again = RunnerPageFormat.signOutAgainQuestion(try line(refused), count: 2)
        try write("3-sessions-ask-again",
                  RunnerEngineSetDefaultViews.Confirm(question: again, confirm: RunnerAccountCopy.RUNNER_DEFAULT_SIGN_OUT_CONFIRM),
                  size: CGSize(width: 420, height: 260))

        let out = try runner(auth: "no")
        XCTAssertFalse(RunnerPageFormat.offersSignOut(try line(out), engine: "claude", runner: out))
        try write("4-signed-out", VStack(alignment: .leading, spacing: 12) {
            Text("Claude Code · accounts").font(.orbitLabel).foregroundStyle(.secondary)
            try! head(out)
            Text("Sign In").font(.body).foregroundStyle(Color.accentColor)
        }, size: CGSize(width: 420, height: 160))

        let old = try runner(auth: "yes", declared: false)
        XCTAssertFalse(RunnerPageFormat.offersSignOut(try line(old), engine: "claude", runner: old))
    }
}
