import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import OrbitKit

final class LoginFailureTests: XCTestCase {

    func testServerRejectionsSayTheCredentialsAreWrong() {
        XCTAssertEqual(LoginFailure.message(for: APIError.unauthorized), LoginFailure.rejected)
        for status in [400, 401, 403, 422] {
            XCTAssertEqual(LoginFailure.message(for: APIError.http(status: status, body: "nope")),
                           LoginFailure.rejected, "HTTP \(status)")
        }
    }

    func testTransportFailuresSayTheServerIsUnreachable() {
        let codes: [URLError.Code] = [.notConnectedToInternet, .timedOut, .cannotFindHost,
                                      .cannotConnectToHost, .networkConnectionLost,
                                      .dnsLookupFailed, .secureConnectionFailed,
                                      .serverCertificateUntrusted]
        for code in codes {
            XCTAssertEqual(LoginFailure.message(for: URLError(code)), LoginFailure.unreachable, "\(code)")
        }
    }

    func testServerErrorsSayTheServerBroke() {
        for status in [500, 502, 503, 504] {
            XCTAssertEqual(LoginFailure.message(for: APIError.http(status: status, body: nil)),
                           LoginFailure.serverError, "HTTP \(status)")
        }
    }

    func testTheThreeCausesReadDifferently() {
        XCTAssertEqual(Set([LoginFailure.rejected, LoginFailure.unreachable, LoginFailure.serverError]).count, 3)
        XCTAssertFalse(LoginFailure.rejected.contains("URL"))
        XCTAssertFalse(LoginFailure.rejected.contains("network"))
    }

    func testOtherFailuresKeepTheirOwnWords() {
        XCTAssertEqual(LoginFailure.message(for: TokenNotStoredError()), LoginFailure.tokenNotStored)
        XCTAssertEqual(LoginFailure.message(for: APIError.http(status: 404, body: nil)), LoginFailure.unexpected)
        XCTAssertEqual(LoginFailure.message(for: APIError.invalidResponse), LoginFailure.unexpected)
    }

    func testSubmittedEmailDropsOnlySurroundingWhitespace() {
        XCTAssertEqual(LoginFailure.submittedEmail("  ada@example.com \n\t"), "ada@example.com")
        XCTAssertEqual(LoginFailure.submittedEmail("ada@example.com"), "ada@example.com")
        XCTAssertEqual(LoginFailure.submittedEmail(" ada lovelace@example.com "), "ada lovelace@example.com")
    }

    // MARK: refusals the server names by code (docs/google-sign-in-design.md §4, §5.2, §5.5)

    private func refusal(_ code: String, status: Int = 403) -> APIError {
        .http(status: status, body: #"{"code":"\#(code)","message":"The server's own sentence"}"#)
    }

    func testARefusalWithACodeIsSaidInItsOwnWordsOnEitherDoor() {
        for (code, sentence) in LoginFailure.refusals {
            XCTAssertEqual(LoginFailure.message(for: refusal(code)), sentence, code)
            XCTAssertEqual(LoginFailure.message(for: refusal(code, status: 400)), sentence, code)
            XCTAssertEqual(LoginFailure.googleMessage(for: refusal(code)), sentence, code)
            XCTAssertEqual(LoginFailure.googleMessage(for: GoogleSignInError.refused(code: code)), sentence, code)
            XCTAssertNotEqual(sentence, LoginFailure.rejected, code)
        }
        XCTAssertEqual(Set(LoginFailure.refusals.values).count, LoginFailure.refusals.count, "two codes share a sentence")
    }

    func testEachRefusalSaysWhatToDoNext() {
        let says = LoginFailure.refusals
        XCTAssertEqual(says["ACCOUNT_DISABLED"], "This Orbit account is disabled. Ask an administrator to enable it again.")
        XCTAssertEqual(says["GOOGLE_ACCOUNT_NOT_FOUND"],
                       "No Orbit account uses this Google account yet. Ask an administrator to create one for your email address, then continue with Google again.")
        XCTAssertEqual(says["GOOGLE_EMAIL_NOT_AUTHORITATIVE"],
                       "Google can't confirm that this email address is still yours. Sign in with your password, then connect Google on your profile page in Orbit on the web.")
        XCTAssertEqual(says["GOOGLE_NOT_CONFIGURED"],
                       "Google sign-in is turned off on this server. Sign in with your email and password, or ask an administrator to turn it on.")
        XCTAssertEqual(says["GOOGLE_FLOW_MISMATCH"], "This Google sign-in expired or was already used. Continue with Google to try again.")
        XCTAssertEqual(says["GOOGLE_CANCELLED"], LoginFailure.googleCancelled)
    }

    /// A password sign-in turned down without a code is still a wrong password; one turned down with
    /// a code the app doesn't know yet is, too — as before the codes.
    func testAPasswordRefusalWithoutAKnownCodeIsStillAWrongPassword() {
        XCTAssertEqual(LoginFailure.message(for: refusal("SOMETHING_NEW", status: 401)), LoginFailure.rejected)
        XCTAssertEqual(LoginFailure.message(for: APIError.http(status: 403, body: #"{"message":"Forbidden"}"#)),
                       LoginFailure.rejected)
    }

    /// Continue with Google asked for no password, so nothing it meets reads as a wrong one.
    func testAGoogleSignInNeverSaysThePasswordIsWrong() {
        for status in [400, 401, 403, 404, 422] {
            XCTAssertEqual(LoginFailure.googleMessage(for: APIError.http(status: status, body: "nope")),
                           LoginFailure.googleFailed, "HTTP \(status)")
        }
        XCTAssertEqual(LoginFailure.googleMessage(for: refusal("SOMETHING_NEW")), LoginFailure.googleFailed)
        XCTAssertEqual(LoginFailure.googleMessage(for: GoogleSignInError.refused(code: "SOMETHING_NEW")),
                       LoginFailure.googleFailed)
        XCTAssertEqual(LoginFailure.googleMessage(for: APIError.unauthorized), LoginFailure.googleFailed)
    }

    func testAGoogleSignInFailsForItsOwnReasons() {
        XCTAssertEqual(LoginFailure.googleMessage(for: APIError.http(status: 429, body: "too many")), LoginFailure.googleTooMany)
        XCTAssertEqual(LoginFailure.googleMessage(for: GoogleSignInError.stateMismatch), LoginFailure.googleStateMismatch)
        XCTAssertEqual(LoginFailure.googleMessage(for: GoogleSignInError.unavailable), LoginFailure.googleUnavailable)
        XCTAssertEqual(LoginFailure.googleMessage(for: GoogleSignInError.cancelled), LoginFailure.googleCancelled)
        XCTAssertEqual(LoginFailure.googleMessage(for: GoogleSignInError.malformedCallback), LoginFailure.unexpected)
        // …and for the password door's, where they are the same reasons.
        XCTAssertEqual(LoginFailure.googleMessage(for: URLError(.notConnectedToInternet)), LoginFailure.unreachable)
        XCTAssertEqual(LoginFailure.googleMessage(for: APIError.http(status: 502, body: nil)), LoginFailure.serverError)
        XCTAssertEqual(LoginFailure.googleMessage(for: TokenNotStoredError()), LoginFailure.tokenNotStored)
        XCTAssertEqual(LoginFailure.googleMessage(for: APIError.invalidResponse), LoginFailure.unexpected)
    }

    /// Every code the server's Google sign-in answers with — a callback's `error`, or a refusal of
    /// the exchange — has a sentence here, so a new one can't reach the page as a bare code or a
    /// catch-all. Read from the server's own source.
    func testEveryCodeTheServerSendsHasASentence() throws {
        let service = try source("src/apiserver/src/auth/google-login.service.ts")
        let controller = try source("src/apiserver/src/auth/google-auth.controller.ts")
        var codes = Set<String>()
        let literal = try NSRegularExpression(pattern: "'(GOOGLE_[A-Z_]+)'")
        for text in [service, controller] {
            for match in literal.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                codes.insert(String(text[Range(match.range(at: 1), in: text)!]))
            }
        }
        let refusals = try XCTUnwrap(service.range(of: "const RESOLUTION_REFUSALS = {"), "no RESOLUTION_REFUSALS")
        let end = try XCTUnwrap(service.range(of: "} as const;", range: refusals.upperBound..<service.endIndex))
        for line in service[refusals.upperBound..<end.lowerBound].split(separator: "\n") {
            let key = line.trimmingCharacters(in: .whitespaces).prefix { $0 != ":" }
            if !key.isEmpty, key.allSatisfy({ $0.isUppercase || $0 == "_" }) { codes.insert(String(key)) }
        }

        XCTAssertTrue(codes.isSuperset(of: ["GOOGLE_FLOW_MISMATCH", "GOOGLE_NOT_CONFIGURED", "SETUP_REQUIRED",
                                            "GOOGLE_ACCOUNT_NOT_FOUND"]), "\(codes.sorted())")
        for code in codes.sorted() {
            XCTAssertNotNil(LoginFailure.refusals[code], "\(code) has no sentence in LoginFailure.refusals")
        }
    }

    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String { "\(path) wasn't found above this test. If it moved, point this check at its new home." }
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
}
