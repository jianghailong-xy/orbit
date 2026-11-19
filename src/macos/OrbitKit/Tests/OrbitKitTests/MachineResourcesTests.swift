import Foundation
import XCTest
@testable import OrbitKit

/// A runner page's Resources section, held to the web's `MachineResources.tsx` and its layout tests
/// (MachineSettingsPage.layout.test.tsx): the three tiles, the header note, amber, the old runner's
/// Update runner, the offline page, and the last hour's line with its breaks.
final class MachineResourcesTests: XCTestCase {

    /// 2026-11-14 06:00:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_794_636_000)
    private let nowISO = "2026-11-14T06:00:00Z"
    private let gib: Int64 = 1_024 * 1_024 * 1_024

    private func runner(online: Bool = true, declares: Bool = true, minFreeDiskMb: Int? = nil,
                        heartbeat: String = "2026-11-14T05:59:50Z") throws -> Runner {
        let capabilities = declares ? #"["machine-resources/v1"]"# : "[]"
        let floor = minFreeDiskMb.map(String.init) ?? "null"
        let json = """
        {"id":"r1","name":"studio","status":"\(online ? "ONLINE" : "OFFLINE")","online":\(online),
         "lastHeartbeatAt":"\(heartbeat)","maxConcurrent":4,"activeSessions":2,"minFreeDiskMb":\(floor),
         "capabilities":\(capabilities)}
        """
        return try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    private var studio: RunnerResources {
        RunnerResources(cpuPercent: 37.6, cpuCores: 8, load1: 3.04, memTotalBytes: 32 * gib,
                        memAvailableBytes: 10 * gib, diskTotalBytes: 926 * gib, diskFreeBytes: 198 * gib)
    }

    private func tile(_ section: MachineResources.Section, _ kind: MachineResources.Kind) -> MachineResources.Tile {
        section.tiles.first { $0.kind == kind }!
    }

    // MARK: the section

    func testALiveMachineShowsItsThreeFiguresAndTheirHour() throws {
        let answer = RunnerResourcesAnswer(at: nowISO, latest: studio, samples: [])
        let section = MachineResources.section(runner: try runner(), answer: answer, workspaceDisk: nil, now: now)
        XCTAssertEqual(section.note, "Live · every 30 s · last hour")
        XCTAssertEqual(section.dot, .live)
        XCTAssertTrue(section.showsLines)
        XCTAssertEqual(section.tiles.map(\.kind), [.cpu, .mem, .disk])
        XCTAssertEqual(section.tiles.map(\.label), ["CPU", "Memory", "Disk"])
        XCTAssertEqual(section.tiles.map(\.value), ["38", "69", "79"])
        XCTAssertEqual(tile(section, .cpu).detail, "8 cores · load 3.0")
        XCTAssertEqual(tile(section, .mem).detail, "22 of 32 GB used")
        XCTAssertEqual(tile(section, .disk).detail, "728 of 926 GB used · 198 GB free")
        XCTAssertEqual(section.tiles.map(\.tone), [.normal, .normal, .normal])
        XCTAssertTrue(section.tiles.allSatisfy { $0.note == nil && $0.update == nil })
    }

    func testMemoryAndDiskTurnAmberNearlyFullAndCPUNever() throws {
        var full = studio
        full.cpuPercent = 100
        full.memAvailableBytes = 2 * gib       // 94%
        full.diskFreeBytes = 50 * gib          // 95%
        let section = MachineResources.section(runner: try runner(),
                                               answer: RunnerResourcesAnswer(at: nowISO, latest: full, samples: []),
                                               workspaceDisk: nil, now: now)
        XCTAssertEqual(tile(section, .cpu).tone, .normal)
        XCTAssertEqual(tile(section, .mem).tone, .warn)
        XCTAssertEqual(tile(section, .mem).note, "Nearly full — new sessions may be slow to start.")
        XCTAssertEqual(tile(section, .disk).tone, .warn)

        // Disk below Keep Free is amber too, though far from 90%.
        let reserved = MachineResources.section(runner: try runner(minFreeDiskMb: 204_800),
                                                answer: RunnerResourcesAnswer(at: nowISO, latest: studio, samples: []),
                                                workspaceDisk: nil, now: now)
        XCTAssertEqual(tile(reserved, .disk).tone, .warn)
        XCTAssertEqual(tile(reserved, .mem).tone, .normal)
    }

    func testAnOfflineMachineIsGreyAndSaysWhenItLastRead() throws {
        var full = studio
        full.memAvailableBytes = 1 * gib
        let answer = RunnerResourcesAnswer(at: "2026-11-14T05:46:00Z", latest: full, samples: [])
        let off = try runner(online: false, heartbeat: "2026-11-14T05:46:00Z")
        let section = MachineResources.section(runner: off, answer: answer, workspaceDisk: nil, now: now)
        XCTAssertEqual(section.note, "Offline · last reading 14m ago")
        XCTAssertEqual(section.dot, .off)
        XCTAssertEqual(section.tiles.map(\.tone), [.off, .off, .off])
        XCTAssertNil(tile(section, .mem).note, "the nearly-full note is only said while online")
        XCTAssertEqual(section.endMs, RunnerPageFormat.nowMs(now) - 14 * 60_000, "its hour ends at its last reading")

        let never = MachineResources.section(runner: off, answer: nil, workspaceDisk: nil, now: now)
        XCTAssertEqual(never.note, "Offline")
        XCTAssertEqual(never.dot, .off)
    }

    func testARunnerThatReadsNoResourcesShowsUpdateRunnerAndItsWorkspacesDisk() throws {
        let disk = RunnerDisk(freeBytes: 10 * gib, totalBytes: 197 * gib, usedPercent: 95)
        // An answer that came anyway is not shown: the runner did not declare it reads its machine.
        let answer = RunnerResourcesAnswer(at: nowISO, latest: studio, samples: [])
        let section = MachineResources.section(runner: try runner(declares: false), answer: answer,
                                               workspaceDisk: disk, now: now)
        XCTAssertEqual(section.note, "Disk is read from your workspaces")
        XCTAssertNil(section.dot)
        XCTAssertFalse(section.showsLines)
        XCTAssertEqual(tile(section, .cpu).update, "This runner predates CPU readings.")
        XCTAssertEqual(tile(section, .mem).update, "This runner predates memory readings.")
        XCTAssertNil(tile(section, .disk).update)
        XCTAssertEqual(tile(section, .disk).value, "95")
        XCTAssertEqual(tile(section, .disk).detail, "187 of 197 GB used · 10 GB free")
        XCTAssertEqual(tile(section, .disk).tone, .warn)

        let none = MachineResources.section(runner: try runner(declares: false), answer: nil, workspaceDisk: nil, now: now)
        XCTAssertEqual(tile(none, .disk).value, "—")
        XCTAssertEqual(tile(none, .disk).detail, "")
    }

    func testAFigureNotReadYetIsADash() throws {
        let section = MachineResources.section(runner: try runner(), answer: nil, workspaceDisk: nil, now: now)
        XCTAssertEqual(section.tiles.map(\.value), ["—", "—", "—"])
        XCTAssertEqual(section.tiles.map(\.detail), ["No reading yet", "No reading yet", "No reading yet"])

        // A reading without the disk falls back to the workspaces' disk; one core is `1 core`.
        let partial = RunnerResourcesAnswer(at: nowISO, latest: RunnerResources(cpuCores: 1), samples: [])
        let disk = RunnerDisk(freeBytes: 100 * gib, totalBytes: 200 * gib, usedPercent: 50)
        let fallback = MachineResources.section(runner: try runner(), answer: partial, workspaceDisk: disk, now: now)
        XCTAssertEqual(tile(fallback, .cpu).detail, "1 core")
        XCTAssertEqual(tile(fallback, .cpu).value, "—")
        XCTAssertEqual(tile(fallback, .disk).value, "50")
        XCTAssertEqual(tile(fallback, .mem).detail, "No reading yet")
    }

    func testTheCPULineLeavesOutWhatTheMachineDidNotGive() {
        XCTAssertEqual(MachineResources.cpuDetail(cores: nil, load1: 0.25), "load 0.3")
        XCTAssertEqual(MachineResources.cpuDetail(cores: 0, load1: nil), "")
        XCTAssertEqual(MachineResources.cpuDetail(cores: 16, load1: nil), "16 cores")
    }

    // MARK: the line

    func testTheLineCoversTheHourAndBreaksWhereTheMachineWentUnheard() {
        let endMs = RunnerPageFormat.nowMs(now)
        let samples = [
            RunnerResourceSample(at: "2026-11-14T04:30:00Z", cpu: 99, mem: 99, disk: 99),  // older than the hour
            RunnerResourceSample(at: "2026-11-14T05:00:00Z", cpu: 10, mem: 50, disk: 80),
            RunnerResourceSample(at: "2026-11-14T05:00:30Z", cpu: 20, mem: nil, disk: 80),
            RunnerResourceSample(at: "2026-11-14T05:01:00Z", cpu: 130, mem: 52, disk: 80),
            RunnerResourceSample(at: "2026-11-14T05:30:00Z", cpu: 40, mem: 60, disk: 80),  // after a gap
            RunnerResourceSample(at: "2026-11-14T05:31:30Z", cpu: -5, mem: 61, disk: 80),  // 90 s: unbroken
        ]
        let cpu = MachineResources.line(samples, kind: .cpu, endMs: endMs)
        XCTAssertEqual(cpu.map(\.count), [3, 2])
        XCTAssertEqual(cpu[0][0], MachineResources.Point(x: 0, y: 0.1))
        XCTAssertEqual(cpu[0][2].y, 1, "a figure is held to 0–100")
        XCTAssertEqual(cpu[1][0].x, 0.5, accuracy: 1e-9)
        XCTAssertEqual(cpu[1][1].y, 0)

        // A sample with no reading of the figure breaks its line.
        XCTAssertEqual(MachineResources.line(samples, kind: .mem, endMs: endMs).map(\.count), [1, 1, 2])
        XCTAssertEqual(MachineResources.line([], kind: .disk, endMs: endMs), [])
    }
}
