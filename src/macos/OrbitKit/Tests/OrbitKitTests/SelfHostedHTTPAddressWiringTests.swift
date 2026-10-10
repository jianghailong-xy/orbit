import Foundation
import XCTest

/// The iPhone app has to sign in to a self-hosted server at an address the operator types in, and
/// since iOS 17 the OS applies ATS to IP literals again: the exceptions in
/// `src/ios/Support/Info.plist` are the whole reason `http://192.168.1.5:2086` can be reached at
/// all — without them URLSession refuses the request with `NSURLErrorDomain -1022` and the login
/// page can only say it couldn't reach the server. Two properties of that block are not free:
///
///   * a `/0` key is treated as a flag rather than an address and matches nothing, so each address
///     family is listed as its two `/1` halves (Apple's workaround for r.114040682);
///   * `NSAllowsLocalNetworking` beside `NSAllowsArbitraryLoads` is a trap rather than belt and
///     braces — on iOS 10+ its presence makes the OS ignore the arbitrary-loads value outright.
///
/// This reads the file the iPhone build ships rather than a restatement of it (XcodeGen copies it
/// straight in, and release.yml builds TestFlight from the same project.yml). What the exceptions
/// do at runtime is measured, not asserted, in docs/evidence/ios-http-ip/.
final class SelfHostedHTTPAddressWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If the iPhone app's Info.plist moved, point this "
                + "check at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet if a file moves.
    private func shippedPlist() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/ios/Support/Info.plist")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try XCTUnwrap(
                    PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                    "src/ios/Support/Info.plist did not parse as a dictionary plist")
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: "src/ios/Support/Info.plist")
    }

    /// Every address a self-hosted instance can be typed in as, in the plist's own terms: a named
    /// host over http, and both families of IP literals.
    func testTheShippedPlistLetsTheAppReachAddressesPeopleTypeIn() throws {
        let plist = try shippedPlist()
        let ats = try XCTUnwrap(plist["NSAppTransportSecurity"] as? [String: Any],
                                "the iPhone app ships no ATS dictionary, so http:// addresses are refused")

        XCTAssertEqual(ats["NSAllowsArbitraryLoads"] as? Bool, true,
                       "an operator's http:// host name is refused without this")
        for neutralizing in ["NSAllowsLocalNetworking", "NSAllowsArbitraryLoadsInWebContent",
                             "NSAllowsArbitraryLoadsForMedia"] {
            XCTAssertNil(ats[neutralizing],
                         "\(neutralizing) makes iOS 10+ ignore NSAllowsArbitraryLoads outright, "
                         + "so it cannot sit beside it")
        }

        let domains = try XCTUnwrap(ats["NSExceptionDomains"] as? [String: Any],
                                    "iOS 17 applies ATS to IP literals; without entries here "
                                    + "http://192.168.1.5:2086 and the like are refused")
        for halves in ["0.0.0.0/1", "128.0.0.0/1", "::/1", "8000::/1"] {
            let entry = try XCTUnwrap(domains[halves] as? [String: Any],
                                      "\(halves) is half of one address family's range")
            XCTAssertEqual(entry["NSExceptionAllowsInsecureHTTPLoads"] as? Bool, true,
                           "\(halves) without this still refuses a plain http:// address")
        }
        for flag in ["0.0.0.0/0", "::/0"] {
            XCTAssertNil(domains[flag],
                         "\(flag) is treated as a flag rather than an address and matches nothing "
                         + "(r.114040682) — list the two /1 halves instead")
        }
    }

    /// iOS 14 asks for a sentence of its own before an app may reach a local-network address, and
    /// a self-hosted server on the same Wi-Fi is the ordinary case for this app.
    func testTheShippedPlistExplainsTheLocalNetworkConnection() throws {
        let plist = try shippedPlist()
        let sentence = try XCTUnwrap(plist["NSLocalNetworkUsageDescription"] as? String,
                                     "the local-network prompt has nothing to explain the connection with")
        XCTAssertFalse(sentence.isEmpty)
    }
}
