import Foundation

/// One reading of a machine (shared `RunnerResources`). A figure the platform has no answer for is
/// absent — the page shows a dash, never a zero.
public struct RunnerResources: Codable, Equatable, Sendable {
    /// The whole machine's CPU in use since the runner's previous reading, 0–100.
    public var cpuPercent: Double?
    public var cpuCores: Int?
    /// The one-minute load average.
    public var load1: Double?
    public var memTotalBytes: Int64?
    /// What the system can hand out without swapping.
    public var memAvailableBytes: Int64?
    public var diskTotalBytes: Int64?
    public var diskFreeBytes: Int64?

    public init(cpuPercent: Double? = nil, cpuCores: Int? = nil, load1: Double? = nil,
                memTotalBytes: Int64? = nil, memAvailableBytes: Int64? = nil,
                diskTotalBytes: Int64? = nil, diskFreeBytes: Int64? = nil) {
        self.cpuPercent = cpuPercent
        self.cpuCores = cpuCores
        self.load1 = load1
        self.memTotalBytes = memTotalBytes
        self.memAvailableBytes = memAvailableBytes
        self.diskTotalBytes = diskTotalBytes
        self.diskFreeBytes = diskFreeBytes
    }
}

/// One heartbeat's figures in percent (shared `RunnerResourceSample`).
public struct RunnerResourceSample: Codable, Equatable, Sendable {
    public let at: String
    public let cpu: Double?
    public let mem: Double?
    public let disk: Double?

    public init(at: String, cpu: Double?, mem: Double?, disk: Double?) {
        self.at = at
        self.cpu = cpu
        self.mem = mem
        self.disk = disk
    }
}

/// GET /api/runners/:id/resources (shared `RunnerResourcesAnswer`): the latest reading and its last
/// hour. `at` and `latest` are nil when nothing is kept.
public struct RunnerResourcesAnswer: Codable, Equatable, Sendable {
    public let at: String?
    public let latest: RunnerResources?
    /// Oldest first, one per heartbeat.
    public let samples: [RunnerResourceSample]

    public init(at: String?, latest: RunnerResources?, samples: [RunnerResourceSample]) {
        self.at = at
        self.latest = latest
        self.samples = samples
    }
}
