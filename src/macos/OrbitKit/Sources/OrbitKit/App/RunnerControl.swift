import Foundation

// The "two-in-one" half: managing the local runner this Mac (optionally) hosts. The runner is
// already macOS-native (launchd `com.orbit.runner`, config at ~/.orbit/config.json, logs at
// $ORBIT_HOME/runner.log). Everything here is pure/IO-light and unit-tested; running launchctl
// via Process is the app's macOS glue.

/// Canonical on-disk locations for the local runner.
public struct RunnerPaths: Equatable, Sendable {
    /// $ORBIT_HOME, else ~/.orbit.
    public let home: URL
    /// ~/Library/LaunchAgents/com.orbit.runner.plist
    public let plistFile: URL

    public init(home: URL, plistFile: URL) {
        self.home = home
        self.plistFile = plistFile
    }

    public var configFile: URL { home.appendingPathComponent("config.json") }
    public var logFile: URL { home.appendingPathComponent("runner.log") }

    public static let launchdLabel = "com.orbit.runner"

    /// Resolve from `$ORBIT_HOME` (nil/empty → `<userHome>/.orbit`) and the user's home dir.
    public static func resolve(orbitHome: String?, userHome: String) -> RunnerPaths {
        let home: URL
        if let h = orbitHome, !h.isEmpty {
            home = URL(fileURLWithPath: h)
        } else {
            home = URL(fileURLWithPath: userHome).appendingPathComponent(".orbit")
        }
        let plist = URL(fileURLWithPath: userHome)
            .appendingPathComponent("Library/LaunchAgents/\(launchdLabel).plist")
        return RunnerPaths(home: home, plistFile: plist)
    }
}

/// The runner's `config.json` (written by `orbit register`).
public struct RunnerConfig: Codable, Equatable, Sendable {
    public let serverUrl: String
    public let runnerId: String
    public let runnerToken: String
    public let name: String
    public let labels: [String]?
    public let maxConcurrent: Int?
    public let workDir: String?
    public init(serverUrl: String, runnerId: String, runnerToken: String, name: String,
                labels: [String]? = nil, maxConcurrent: Int? = nil, workDir: String? = nil) {
        self.serverUrl = serverUrl
        self.runnerId = runnerId
        self.runnerToken = runnerToken
        self.name = name
        self.labels = labels
        self.maxConcurrent = maxConcurrent
        self.workDir = workDir
    }
}

/// Reads the local runner's config + logs. `Data(contentsOf:)` is cross-platform Foundation, so
/// this is testable off a temp file (the file just won't exist on a non-runner machine → nil).
public enum RunnerEnvironment {
    public static func paths(environment: [String: String], userHome: String) -> RunnerPaths {
        RunnerPaths.resolve(orbitHome: environment["ORBIT_HOME"], userHome: userHome)
    }

    public static func readConfig(at paths: RunnerPaths) -> RunnerConfig? {
        guard let data = try? Data(contentsOf: paths.configFile) else { return nil }
        return try? JSONDecoder().decode(RunnerConfig.self, from: data)
    }

    public static func readLogTail(at paths: RunnerPaths, lines: Int = 200) -> [String] {
        guard let data = try? Data(contentsOf: paths.logFile),
              let text = String(data: data, encoding: .utf8) else { return [] }
        return LogTail.lastLines(text, lines)
    }
}

public enum LogTail {
    public static func lastLines(_ text: String, _ n: Int) -> [String] {
        guard n > 0 else { return [] }
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        let trimmed = lines.last == "" ? Array(lines.dropLast()) : lines   // ignore trailing newline
        return Array(trimmed.suffix(n))
    }
}

/// Local launchd service state for the runner.
public struct ServiceStatus: Equatable, Sendable {
    public let loaded: Bool
    public let pid: Int?
    public let lastExitCode: Int?
    public init(loaded: Bool, pid: Int?, lastExitCode: Int?) {
        self.loaded = loaded
        self.pid = pid
        self.lastExitCode = lastExitCode
    }
    public var running: Bool { pid != nil }
    public static let notLoaded = ServiceStatus(loaded: false, pid: nil, lastExitCode: nil)
}

/// Compact, glanceable status text for the local runner. Shared by the menu-bar tray and the
/// runner manager so both phrase the same launchd states identically.
public enum LocalRunnerStatus {
    public static func line(hasConfig: Bool, status: ServiceStatus) -> String {
        guard hasConfig else { return "Not set up on this Mac" }
        if status.running { return "Running · pid \(status.pid ?? 0)" }
        if status.loaded { return "Loaded · stopped" }
        return "Service not installed"
    }
}

/// `launchctl` output parsing + argument-vector builders. The argv builders capture the exact
/// commands `orbit register`/the app run, so they're verified without a launchd to run them.
public enum Launchctl {
    public static let label = RunnerPaths.launchdLabel

    /// Parse `launchctl list` output. Data lines are `PID<TAB>Status<TAB>Label`; PID is `-`
    /// when the job is loaded but not currently running. A missing label line → not loaded.
    public static func parseList(_ output: String, label: String = label) -> ServiceStatus {
        for line in output.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline) {
            let cols = line.split(whereSeparator: { $0 == "\t" || $0 == " " })
                .map(String.init).filter { !$0.isEmpty }
            guard cols.count >= 3, cols.last == label else { continue }
            return ServiceStatus(loaded: true, pid: Int(cols[0]), lastExitCode: Int(cols[1]))
        }
        return .notLoaded
    }

    // Modern launchctl (macOS 11+). `uid` is the GUI domain (e.g. 501).
    public static func bootstrap(uid: Int, plistPath: String) -> [String] { ["bootstrap", "gui/\(uid)", plistPath] }
    public static func bootout(uid: Int, plistPath: String) -> [String] { ["bootout", "gui/\(uid)", plistPath] }
    public static func kickstartRestart(uid: Int) -> [String] { ["kickstart", "-k", "gui/\(uid)/\(label)"] }
    public static func list() -> [String] { ["list"] }
    public static func printService(uid: Int) -> [String] { ["print", "gui/\(uid)/\(label)"] }
}

// MARK: - device enrollment DTOs (one-app runner enroll: start → approve → poll → write config)

public struct DeviceStartRequest: Codable, Sendable {
    public let name: String
    public let hostname: String?
    public let labels: [String]?
    public let maxConcurrent: Int?
    public let version: String?
    public let workDir: String?
    public init(name: String, hostname: String? = nil, labels: [String]? = nil,
                maxConcurrent: Int? = nil, version: String? = nil, workDir: String? = nil) {
        self.name = name
        self.hostname = hostname
        self.labels = labels
        self.maxConcurrent = maxConcurrent
        self.version = version
        self.workDir = workDir
    }
}

public struct DeviceStartResponse: Codable, Sendable {
    public let deviceCode: String
    public let userCode: String
    public let interval: Int
    public let expiresIn: Int
}

public enum DeviceStatus: String, Sendable {
    case pending, expired, approved
}

public struct DevicePollResponse: Codable, Sendable {
    public let status: String
    public let runnerId: String?
    public let runnerToken: String?
    public let name: String?

    public var deviceStatus: DeviceStatus? { DeviceStatus(rawValue: status) }
}
