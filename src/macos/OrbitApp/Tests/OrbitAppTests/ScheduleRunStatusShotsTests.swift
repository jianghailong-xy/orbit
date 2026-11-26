import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// Frames of the real run status card and the strip above it (board docs/mocks/scheduled-run-not-started ②③④), in
/// light and dark, at a Mac window's width and a phone's. PNGs land in `src/macos/build/evidence/scheduled-run-not-started/`.
/// Times are fixed in UTC against a fixed clock so the frames read as the board does.
@MainActor
final class ScheduleRunStatusShotsTests: XCTestCase {
    private var dir: URL {
        var d = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: d.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                let out = d.appendingPathComponent("src/macos/build/evidence/scheduled-run-not-started")
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                return out
            }
            d = d.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: NSTemporaryDirectory())
    }

    /// Day 14 is the run's day (yesterday); 15 is tomorrow, so "tomorrow 06:00" reads as the board's does against the real clock.
    private func iso(_ day: Int, _ time: String) -> String {
        let offset = day == 14 ? -1 : 1
        let at = Calendar(identifier: .gregorian).date(byAdding: .day, value: offset, to: Date())!
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
        let p = utc.dateComponents([.year, .month, .day], from: at)
        return String(format: "%04d-%02d-%02dT%@:00Z", p.year!, p.month!, p.day!, time)
    }
    private let times = ["03:32", "03:43", "03:58", "04:23", "05:34"]

    private func tries(reached: Int? = nil, count: Int = 5) -> [ScheduleRunTry] {
        (0..<count).map {
            ScheduleRunTry(sessionId: "s\($0 + 1)", startedAt: iso(14, times[$0]), claimed: true, reachedEngine: reached == $0 + 1)
        }
    }

    private func frame(_ name: String, width: CGFloat, run: ScheduleRunView, status: ScheduleRunSessionStatus) throws {
        let kind = try XCTUnwrap(ScheduleRunStatus.kind(run: run, status: status), name)
        let schedule = ScheduleView(id: "sch", title: "Engine version bump", rule: .daily(time: "06:00"), timezone: "UTC",
                                    workspaceId: "w", accessLevel: "LAND")
        for scheme in [ColorScheme.light, .dark] {
            let content = VStack(alignment: .leading, spacing: 8) {
                ScheduleRunStripView(schedule: schedule, run: run, notStarted: true)
                ScheduleRunStatusCardView(run: run, status: status, kind: kind, runner: "HPC", engine: "Claude Code",
                                          perform: { _ in nil })
            }
            .environment(AppModel())
            .environment(\.controlActiveState, .key)
            .padding(16)
            .frame(width: width, alignment: .topLeading)
            .background(Color(nsColor: .windowBackgroundColor))
            let host = NSHostingView(rootView: content)
            host.frame = NSRect(x: 0, y: 0, width: width, height: 420)
            let size = host.fittingSize
            host.frame = NSRect(x: 0, y: 0, width: width, height: size.height)
            let window = KeyWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            window.contentView = host
            window.makeKeyAndOrderFront(nil)
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            let device = width < 500 ? "phone" : "mac"
            try png.write(to: dir.appendingPathComponent("\(device)-\(scheme == .dark ? "dark" : "light")-\(name).png"))
        }
    }

    func testFrames() throws {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let planned = iso(14, "03:32")
        let didnt = ScheduleRunView(id: "r", scheduleId: "sch", plannedAt: planned, trigger: "MANUAL", state: "MISSED", attempt: 5,
                                    sessionId: "s5", failureReason: "RUNNER_UNAVAILABLE")
        let didntStatus = ScheduleRunSessionStatus(tries: tries(), thisTry: 5, gaveUpAt: iso(14, "05:44"), nextDueAt: iso(15, "06:00"))
        let queued = ScheduleRunView(id: "r", scheduleId: "sch", plannedAt: planned, trigger: "MANUAL", state: "RUNNING", sessionId: "s1")
        let gate = ScheduleRunQueueGate(queuedReason: "runner_at_capacity", queuedActive: 20, queuedLimit: 20, queuedHeldByJobs: 0,
                                        since: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-72 * 60)),
                                        deadline: iso(15, "03:32"))
        let queuedStatus = ScheduleRunSessionStatus(tries: tries(count: 1), thisTry: 1, nextDueAt: iso(15, "06:00"), queue: gate)
        let started = ScheduleRunView(id: "r", scheduleId: "sch", plannedAt: planned, trigger: "MANUAL", state: "RUNNING", attempt: 3,
                                      sessionId: "s3")
        let startedStatus = ScheduleRunSessionStatus(tries: tries(reached: 3, count: 3), thisTry: 2, nextDueAt: iso(15, "06:00"))
        for width in [CGFloat(900), 390] {
            try frame("2-didnt-run", width: width, run: didnt, status: didntStatus)
            try frame("3-queued-runner-full", width: width, run: queued, status: queuedStatus)
            try frame("4-started-on-try-3", width: width, run: started, status: startedStatus)
        }
    }
}

/// A borderless window that can be key, so the accent draws as it does in the app (an inactive window greys it).
private final class KeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}
