import Foundation
import XCTest
@testable import OrbitKit

/// What a press that didn't go through says — and the one thing it may never say, which is the
/// error itself.
///
/// Interpolated, a `URLError` prints its whole Objective-C description: `Error
/// Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."
/// UserInfo={_kCFStreamErrorCodeKey=53, NSUnderlyingError=0x164023000 {…}}`. That is what the
/// decision and confirmation cards put on screen on iOS — a crash log where a sentence belongs —
/// until every one of those lines was built from `APIClient.failureReason` instead.
final class FailureReasonTests: XCTestCase {

    /// Every file whose banner reports a failed press. The property the sentence is held in is
    /// matched in the same pass: `statusMessage` in the console, `message` in the runner control.
    private static let bannerFiles = [
        "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift",
        "src/macos/OrbitApp/Sources/OrbitApp/RunnerControl.swift",
        "src/macos/OrbitApp/Sources/OrbitApp/ProjectsModel.swift",
        "src/macos/OrbitApp/Sources/OrbitApp/SharedLinksModel.swift",
    ]

    func testARefusalIsSaidInTheServersOwnWords() {
        XCTAssertEqual(
            APIClient.failureReason(
                APIError.http(status: 409, body: #"{"message":"this card is out of date"}"#)),
            "this card is out of date")
        XCTAssertEqual(APIClient.failureReason(APIError.http(status: 503, body: "")),
                       "the server returned 503")
        XCTAssertEqual(APIClient.failureReason(APIError.unauthorized), "you're signed out")
        XCTAssertEqual(APIClient.failureReason(APIError.invalidResponse),
                       "the server's reply couldn't be read")
        XCTAssertEqual(APIClient.failureReason(APIError.notConfigured), "no server is configured")
    }

    /// The case this was written for: the connection the phone lost between the press and the door.
    func testADroppedConnectionIsOneSentenceAndNotAnNSErrorDump() {
        let reason = APIClient.failureReason(URLError(.networkConnectionLost))
        XCTAssertEqual(reason, "the connection dropped")
        XCTAssertFalse(reason.contains("NSURLErrorDomain"),
                       "a dropped connection is reporting itself as an NSError dump again")
    }

    /// The fence. Nothing in a build catches a banner that went back to printing its error, because
    /// `\(error)` compiles anywhere — so the check is that no banner holds one.
    ///
    /// `\(error.localizedDescription)` is NOT caught, deliberately: that is a sentence, and the one
    /// place it is still used wraps local `FileManager` calls, where the system's own words are the
    /// best available and `failureReason` would return the very same string.
    func testNoBannerInterpolatesTheRawError() throws {
        var offenders: [String] = []
        for file in Self.bannerFiles {
            let source = try String(contentsOf: repoRoot().appendingPathComponent(file),
                                    encoding: .utf8)
            for (index, line) in source
                .split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let isBanner = line.contains("statusMessage = ") || line.contains("message = ")
                guard isBanner, line.contains("\\(error)") else { continue }
                offenders.append("  \(file):\(index + 1):\(line.trimmingCharacters(in: .whitespaces))")
            }
        }

        XCTAssertTrue(offenders.isEmpty,
                      "a banner is interpolating the raw error again — say it with "
                      + "APIClient.failureReason(error) instead:\n" + offenders.joined(separator: "\n"))
    }

    /// The repo root, found by walking up from this file until the first banner file is under foot —
    /// not a fixed number of `..` hops, the way the copy-parity tests find the other end's source.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(
                atPath: dir.appendingPathComponent(Self.bannerFiles[0]).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and never an `XCTSkip`: a check that quietly opts out reports
        // green on exactly the day the thing it watches goes missing.
        throw CocoaError(.fileNoSuchFile)
    }
}
