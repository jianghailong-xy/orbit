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
}
