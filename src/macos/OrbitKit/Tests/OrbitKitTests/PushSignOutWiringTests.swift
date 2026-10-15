import Foundation
import XCTest

/// UIKit doesn't exist on Linux, so nothing here compiles the iOS app. These hold sign-out to taking
/// the device off the account's pushes: iOS draws an alert push itself, so a signed-out app can't hold
/// one back, and only the server dropping the registration stops them. The unregister needs the
/// session's access token, which `logout` clears. Each check reads the slice of the file it is about,
/// so a match elsewhere can't pass it.
final class PushSignOutWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testSignOutDropsThePushRegistrationBeforeTheTokensGo() throws {
        let logout = code(try slice(try source("src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift"),
                                    from: "func logout() {", to: "signedIn = false"))
        let disable = try XCTUnwrap(logout.range(of: "disablePush()"), "sign-out leaves the device registered")
        let clear = try XCTUnwrap(logout.range(of: "tokenStore.setToken(nil, for: baseURL)"))
        XCTAssertLessThan(disable.lowerBound, clear.lowerBound, "the access token is gone by then")
    }

    func testTheUnregisterCarriesTheTokenReadAtSignOut() throws {
        let disable = code(try slice(try source("src/ios/Sources/Push.swift"),
                                     from: "func disablePush() {", to: "\n    }"))
        let read = try XCTUnwrap(disable.range(of: "let accessToken = tokenStore.token(for: baseURL)"))
        let task = try XCTUnwrap(disable.range(of: "Task {"))
        XCTAssertLessThan(read.lowerBound, task.lowerBound, "read inside the task, the store is already empty")
        XCTAssertTrue(disable.contains("api.unregisterDeviceToken(token: token, accessToken: accessToken)"))
    }
}
