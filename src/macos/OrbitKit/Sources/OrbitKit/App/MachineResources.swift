import Foundation

/// A runner page's Resources section (docs/mocks/runner-resource-monitor): the machine's CPU, memory
/// and disk, each the latest reading large with its last hour as a line. The web's
/// `MachineResources.tsx` rule, kept here so it is tested where the SwiftUI views cannot be compiled.
/// A runner that does not declare `machine-resources/v1` has only the disk its workspaces' probes
/// measured.
public enum MachineResources {

    /// The capability a runner declares once it reports its machine (shared `MACHINE_RESOURCES_CAPABILITY`).
    public static let capability = "machine-resources/v1"
    /// How often the section asks again while the machine is online: its heartbeat's own period.
    public static let pollSeconds: TimeInterval = 30

    private static let hourMs: Int64 = 60 * 60_000
    /// Samples further apart than this are drawn as a break: the machine was not heard in between.
    private static let gapMs: Int64 = 90_000
    /// Memory from here on is drawn amber, as disk is (`RunnerPageFormat.diskIsTight`). CPU is not: an
    /// agent at work fills it.
    private static let fullPercent = 90

    public static func reports(_ runner: Runner) -> Bool {
        runner.capabilities?.contains(capability) == true
    }

    // MARK: the section

    public enum Kind: String, Equatable, Sendable, CaseIterable {
        case cpu, mem, disk
    }

    /// How a tile is drawn: the accent, amber once nearly full, grey while the machine is offline.
    public enum Tone: Equatable, Sendable {
        case normal, warn, off
    }

    /// The header note's dot: green while live, grey offline, none for a runner that reads no resources.
    public enum Dot: Equatable, Sendable {
        case live, off
    }

    public struct Tile: Equatable, Sendable, Identifiable {
        public let kind: Kind
        public let label: String
        /// Whole percent; nil reads as a dash.
        public let percent: Int?
        public let detail: String
        public let tone: Tone
        /// `Nearly full — …`, only while online.
        public let note: String?
        /// The runner is too old to report this figure: the tile says so in place of a reading.
        public let update: String?

        public var id: Kind { kind }
        /// `38`, or `—` without a reading.
        public var value: String { percent.map(String.init) ?? "—" }
    }

    public struct Section: Equatable, Sendable {
        public let note: String
        public let dot: Dot?
        public let tiles: [Tile]
        /// Each tile draws its last hour: only for a runner that reports.
        public let showsLines: Bool
        /// The hour the lines cover ends here: now while online, at the last reading offline.
        public let endMs: Int64
    }

    /// The section for `runner`, from its answer (nil while unread) and its workspaces' disk.
    public static func section(runner: Runner, answer: RunnerResourcesAnswer?, workspaceDisk: RunnerDisk?,
                               now: Date) -> Section {
        let nowMs = RunnerPageFormat.nowMs(now)
        let online = !RunnerPageFormat.isOffline(runner, now: now)
        let declared = reports(runner)
        let latest = declared ? answer?.latest : nil
        let at = declared ? answer?.at : nil
        let endMs = online ? nowMs : (at.flatMap(epochMs) ?? nowMs)

        let cpu = latest?.cpuPercent.map { Int($0.rounded()) }
        let memTotal = latest?.memTotalBytes.flatMap { $0 != 0 ? $0 : nil }
        let memAvail = latest?.memAvailableBytes
        var mem: Int?
        if let memTotal, let memAvail { mem = pct(memTotal - memAvail, memTotal) }

        // The machine's own reading of the disk when it gives one; the workspaces' probes otherwise.
        let disk: RunnerDisk?
        if let total = latest?.diskTotalBytes, total != 0, let free = latest?.diskFreeBytes {
            disk = RunnerDisk(freeBytes: free, totalBytes: total, usedPercent: pct(total - free, total))
        } else {
            disk = workspaceDisk
        }
        let diskWarn = disk.map { RunnerPageFormat.diskIsTight($0, minFreeDiskMb: runner.minFreeDiskMb) } ?? false
        let memWarn = mem.map { $0 >= fullPercent } ?? false

        let noReading = declared ? RunnerPageCopy.RUNNER_RESOURCES_NO_READING : ""
        func tone(_ warn: Bool) -> Tone { !online ? .off : warn ? .warn : .normal }

        var cpuText = noReading
        if let latest {
            let line = cpuDetail(cores: latest.cpuCores, load1: latest.load1)
            cpuText = line.isEmpty ? noReading : line
        }
        var memText = noReading
        if let memTotal, let memAvail {
            memText = RunnerPageCopy.runnerDiskUsed(used: RunnerAttention.formatDiskGb(memTotal - memAvail),
                                                    total: RunnerAttention.formatDiskGb(memTotal))
        }
        let diskText = disk.map {
            RunnerPageFormat.diskUsedLine($0) + RunnerPageCopy.RUNNER_LINE_SEPARATOR
                + RunnerPageCopy.runnerDiskFree(free: RunnerAttention.formatDiskGb($0.freeBytes))
        } ?? noReading

        let tiles = [
            Tile(kind: .cpu, label: RunnerPageCopy.RUNNER_RESOURCES_CPU, percent: cpu, detail: cpuText,
                 tone: tone(false), note: nil,
                 update: declared ? nil : RunnerPageCopy.runnerResourcesPredates(what: "CPU")),
            Tile(kind: .mem, label: RunnerPageCopy.RUNNER_RESOURCES_MEMORY, percent: mem, detail: memText,
                 tone: tone(memWarn), note: memWarn && online ? RunnerPageCopy.RUNNER_RESOURCES_MEMORY_FULL : nil,
                 update: declared ? nil : RunnerPageCopy.runnerResourcesPredates(what: "memory")),
            Tile(kind: .disk, label: RunnerPageCopy.RUNNER_DISK, percent: disk?.usedPercent, detail: diskText,
                 tone: tone(diskWarn), note: nil, update: nil),
        ]

        let note: String
        if !online {
            note = at.map { RunnerPageCopy.runnerResourcesLastReading(ago: RunnerAttention.ago($0, nowMs: nowMs)) }
                ?? RunnerPageCopy.RUNNER_RESOURCES_OFFLINE
        } else {
            note = declared ? RunnerPageCopy.RUNNER_RESOURCES_LIVE : RunnerPageCopy.RUNNER_RESOURCES_DISK_ONLY
        }
        let dot: Dot? = online ? (declared ? .live : nil) : .off
        return Section(note: note, dot: dot, tiles: tiles, showsLines: declared, endMs: endMs)
    }

    /// `8 cores · load 3.0`, either part left out when the machine gave none.
    static func cpuDetail(cores: Int?, load1: Double?) -> String {
        var parts: [String] = []
        if let cores, cores != 0 {
            parts.append(cores == 1 ? RunnerPageCopy.RUNNER_CPU_ONE_CORE
                                    : RunnerPageCopy.runnerCpuCores(count: String(cores)))
        }
        // Rounded half up first, as the web's `toFixed(1)` does (`%.1f` alone makes 0.25 `0.2`).
        if let load1 {
            parts.append(RunnerPageCopy.runnerCpuLoad(load: String(format: "%.1f", (load1 * 10).rounded() / 10)))
        }
        return parts.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
    }

    private static func pct(_ used: Int64, _ total: Int64) -> Int {
        min(100, max(0, Int((Double(used) / Double(total) * 100).rounded())))
    }

    private static func epochMs(_ iso: String) -> Int64? {
        RelativeTime.parse(iso).map { Int64(($0.timeIntervalSince1970 * 1_000).rounded()) }
    }

    // MARK: the line

    /// A point of a tile's line: `x` across the hour (0 its start, 1 its end), `y` the figure (0 empty, 1 full).
    public struct Point: Equatable, Sendable {
        public let x: Double
        public let y: Double
    }

    /// The last hour of one figure ending at `endMs`, as runs of points: a new run starts wherever the
    /// machine went unheard for more than 90 s, or a sample had no reading. A run of one is drawn as a dot.
    public static func line(_ samples: [RunnerResourceSample], kind: Kind, endMs: Int64) -> [[Point]] {
        let startMs = endMs - hourMs
        var runs: [[Point]] = []
        var prevAt: Int64?
        for sample in samples {
            let value: Double? = switch kind {
            case .cpu: sample.cpu
            case .mem: sample.mem
            case .disk: sample.disk
            }
            guard let at = epochMs(sample.at), at >= startMs, let value else {
                prevAt = nil
                continue
            }
            let point = Point(x: Double(at - startMs) / Double(hourMs), y: min(100, max(0, value)) / 100)
            if let prevAt, at - prevAt <= gapMs, !runs.isEmpty {
                runs[runs.count - 1].append(point)
            } else {
                runs.append([point])
            }
            prevAt = at
        }
        return runs
    }
}
