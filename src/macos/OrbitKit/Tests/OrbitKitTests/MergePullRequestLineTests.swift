import XCTest
@testable import OrbitKit

/// docs/design/protected-branch-landing.md §4.6, §11.2: GitHub refused the push to main, so the runner opened a
/// pull request and the merge waits on it. The merge slot and its notice name the pull request; neither reads as
/// a failure. Same words as web's `MergeButton` and merge-result notice.
final class MergePullRequestLineTests: XCTestCase {
    private let open = LandingPullRequestView(
        number: 214, url: "https://github.com/o/r/pull/214",
        checks: .init(passed: 2, required: 6),
        refusal: .init(via: "PULL_REQUEST", message: "Changes must be made through a pull request."))

    func testOpenPullRequestNamesItsStateAndLinks() {
        let line = WorktreeBarLogic.mergePullRequestLine(open, target: "main")
        XCTAssertEqual(line.label, "Pull request open #214 · 2 of 6")
        XCTAssertEqual(line.url, "https://github.com/o/r/pull/214")
        XCTAssertEqual(line.detail, "main requires a pull request. Waiting for the required checks.")
        XCTAssertEqual(line.tone, .blue)
    }

    func testBeforeTheServerReadThePullRequest() {
        let line = WorktreeBarLogic.mergePullRequestLine(nil, target: "main")
        XCTAssertEqual(line.label, "Pull request open")
        XCTAssertNil(line.url)
        XCTAssertEqual(line.detail, "main requires a pull request. Orbit merges it once the branch's rules pass.")
    }

    func testNoticeSaysThePullRequestWasOpened() {
        let notice = WorktreeBarLogic.mergePullRequestNotice(open, target: "main")
        XCTAssertEqual(notice.headline, "Opened pull request #214 into main")
        XCTAssertEqual(notice.detail, "main requires a pull request. Waiting for the required checks.")
        XCTAssertEqual(WorktreeBarLogic.mergePullRequestNotice(nil, target: "main").headline,
                       "Opened a pull request into main")
    }

    func testSessionDetailDecodesTheMergePullRequest() throws {
        let json = #"{"id":"s1","mergeStatus":"pull_request","mergePullRequest":{"number":214,"url":"https://github.com/o/r/pull/214","state":"OPEN","condition":null,"checks":{"passed":2,"required":6,"failed":[]},"mergeMethod":null,"mergedSha":null,"refusal":null}}"#
        let detail = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.mergePullRequest?.number, 214)
    }
}
