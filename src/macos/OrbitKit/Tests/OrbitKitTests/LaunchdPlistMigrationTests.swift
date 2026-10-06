import Foundation
import XCTest
@testable import OrbitKit

/// The launch-time rewrite of a LaunchAgent an older app installed (OrbitApp
/// RunnerControl.migrateLaunchAgent): which plists are rewritten, and what the rewrite keeps.
final class LaunchdPlistMigrationTests: XCTestCase {
    // What the older app baked in. The log isn't under ORBIT_HOME, so a rewrite that derived it
    // instead of keeping it would show.
    private static let program = "/Users/ana/orbit-home/bin/orbit"
    private static let orbitHome = "/Users/ana/orbit-home"
    private static let home = "/Users/ana"
    private static let path = "/Users/ana/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/ana/go/bin:/usr/bin:/bin"
    private static let log = "/Users/ana/Library/Logs/orbit-runner.log"

    /// What an app that bundled the runner wrote: `LaunchdPlist.make` from 71ad88b7b until the
    /// runner came from /dl, today's template plus the ORBIT_NO_SELFUPDATE line.
    private static let frozen = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>com.orbit.runner</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(program)</string>
            <string>run</string>
          </array>
          <key>EnvironmentVariables</key>
          <dict>
            <key>ORBIT_HOME</key><string>\(orbitHome)</string>
            <key>HOME</key><string>\(home)</string>
            <key>PATH</key><string>\(path)</string>
            <key>ORBIT_NO_SELFUPDATE</key><string>1</string>
          </dict>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><true/>
          <key>StandardOutPath</key><string>\(log)</string>
          <key>StandardErrorPath</key><string>\(log)</string>
        </dict>
        </plist>
        """

    func testAFrozenPlistIsRewrittenWithItsOwnValues() throws {
        let rewritten = try XCTUnwrap(LaunchdPlist.migrated(from: Self.frozen))
        XCTAssertFalse(rewritten.contains("ORBIT_NO_SELFUPDATE"))
        XCTAssertEqual(rewritten, LaunchdPlist.make(label: "com.orbit.runner", programPath: Self.program,
                                                     orbitHome: Self.orbitHome, home: Self.home,
                                                     path: Self.path, logPath: Self.log))

        // Read back as launchd will: the same service, without the variable.
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(rewritten.utf8), format: nil)
                                    as? [String: Any])
        XCTAssertEqual(plist["EnvironmentVariables"] as? [String: String],
                       ["ORBIT_HOME": Self.orbitHome, "HOME": Self.home, "PATH": Self.path])
        XCTAssertEqual(plist["StandardOutPath"] as? String, Self.log)
        XCTAssertEqual(plist["StandardErrorPath"] as? String, Self.log)
        XCTAssertEqual(plist["ProgramArguments"] as? [String], [Self.program, "run"])
        XCTAssertEqual(plist["Label"] as? String, "com.orbit.runner")
        XCTAssertEqual(plist["RunAtLoad"] as? Bool, true)
        XCTAssertEqual(plist["KeepAlive"] as? Bool, true)
    }

    func testARewrittenPlistIsLeftAlone() throws {
        let rewritten = try XCTUnwrap(LaunchdPlist.migrated(from: Self.frozen))
        XCTAssertNil(LaunchdPlist.migrated(from: rewritten))
        // …as is the plist this app writes when it installs the service.
        XCTAssertNil(LaunchdPlist.migrated(from: LaunchdPlist.make(
            label: "com.orbit.runner", programPath: "/Users/ana/.orbit/bin/orbit", orbitHome: "/Users/ana/.orbit",
            home: "/Users/ana", path: "/usr/local/bin:/usr/bin:/bin", logPath: "/Users/ana/.orbit/runner.log")))
    }

    /// No service installed: there's no plist, and the app reads that as nil.
    func testNoServiceInstalledDoesNothing() {
        let plistFile = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("orbit-\(UUID().uuidString)/Library/LaunchAgents/com.orbit.runner.plist")
        XCTAssertNil(LaunchdPlist.migrated(from: try? String(contentsOf: plistFile, encoding: .utf8)))
        XCTAssertNil(LaunchdPlist.migrated(from: nil))
    }

    /// `orbit register` installs the same label at the same path (runner-go renderLaunchdPlist) and
    /// never sets ORBIT_NO_SELFUPDATE. Its plist carries what this app's doesn't (ExitTimeOut, a
    /// proxy), and the app mustn't replace it.
    func testTheCLIsPlistIsLeftAlone() {
        let cli = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>com.orbit.runner</string>
              <key>ProgramArguments</key>
              <array>
                <string>/Users/ana/.orbit/bin/orbit</string>
                <string>run</string>
              </array>
              <key>EnvironmentVariables</key>
              <dict>
                <key>ORBIT_HOME</key><string>/Users/ana/.orbit</string>
                <key>HOME</key><string>/Users/ana</string>
                <key>PATH</key><string>/Users/ana/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
                <key>HTTPS_PROXY</key><string>http://proxy.example:3128</string>
              </dict>
              <key>RunAtLoad</key><true/>
              <key>KeepAlive</key><true/>
              <!-- Keep launchd's SIGTERM-to-SIGKILL window above the runner's complete
                   provider-drain, lease-release, event-flush, and finalization envelope. -->
              <key>ExitTimeOut</key><integer>180</integer>
              <key>StandardOutPath</key><string>/Users/ana/.orbit/runner.log</string>
              <key>StandardErrorPath</key><string>/Users/ana/.orbit/runner.log</string>
            </dict>
            </plist>

            """
        XCTAssertNil(LaunchdPlist.migrated(from: cli))
    }

    /// A frozen plist that doesn't parse would have to be rewritten from guesses, so it isn't.
    func testAFrozenPlistThatDoesntParseIsLeftAlone() throws {
        let cut = try XCTUnwrap(Self.frozen.range(of: "<key>RunAtLoad</key>"))
        let truncated = String(Self.frozen[..<cut.lowerBound])
        XCTAssertTrue(truncated.contains("<key>ORBIT_NO_SELFUPDATE</key><string>1</string>"))
        XCTAssertNil(LaunchdPlist.migrated(from: truncated))
    }
}
