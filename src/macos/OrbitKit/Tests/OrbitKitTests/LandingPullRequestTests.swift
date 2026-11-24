import Foundation
import XCTest
@testable import OrbitKit

/// The landing setting and the pull request landing states (docs/mocks/protected-branch-landing), decoded from the
/// web's `landingBoardServerViews.json`: read models captured from the real apiserver on a stack seeded by
/// `pull-request-landing.pg.spec`. Nothing here is a hand-written payload shape.
final class LandingPullRequestTests: XCTestCase {
    private static let fixture = "src/web/src/lib/landingBoardServerViews.json"
    private static let card = "src/web/src/components/LandingPullRequest.tsx"
    private static let setting = "src/web/src/components/settings/WorkspaceLandingSetting.tsx"

    private func repoFile(_ relative: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file")
        throw CocoaError(.fileNoSuchFile)
    }

    private func views() throws -> [String: [String: Any]] {
        let object = try JSONSerialization.jsonObject(with: try repoFile(Self.fixture))
        return try XCTUnwrap(object as? [String: [String: Any]])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: try JSONSerialization.data(withJSONObject: value))
    }

    private func landing(_ key: String) throws -> SessionLandingView {
        try decode(SessionLandingView.self, try XCTUnwrap(try views()["landing"]?[key]))
    }

    private func card(_ key: String) throws -> LandingPullRequestCard {
        let view = try landing(key)
        return LandingPullRequestCard.make(try XCTUnwrap(view.pullRequest), main: "main")
    }

    // MARK: pull request states

    func testOpenedWaitingForChecks() throws {
        let card = try card("a")
        XCTAssertEqual(card.stage, .opened)
        XCTAssertEqual(card.head, "Pull request open")
        XCTAssertEqual(card.right, "2 of 6")
        XCTAssertEqual(card.detail, "main requires a pull request. Waiting for the required checks.")
        XCTAssertEqual(card.segments, [.passed, .passed, .pending, .pending, .pending, .pending])
    }

    func testWaitingForReviewKeepsTheTipUntilPushAsMe() throws {
        let card = try card("b")
        XCTAssertEqual(card.stage, .waitingForReview)
        XCTAssertEqual(card.head, "Waiting for review")
        XCTAssertEqual(card.right, "6 of 6 ✓")
        XCTAssertEqual(card.detail, "Checks passed. main requires an approving review.")
        XCTAssertTrue(card.showsTip(workspaceMode: "PULL_REQUEST", hidden: false))
        XCTAssertFalse(card.showsTip(workspaceMode: "PUSH_AS_ME", hidden: false), "the tip hides on Push as me")
        XCTAssertFalse(card.showsTip(workspaceMode: nil, hidden: true), "a dismissed tip stays hidden")
        XCTAssertEqual(card.actions.map(\.label), [LandingPullRequestWords.review])
    }

    func testCheckFailedNamesTheCheckAndItsLog() throws {
        let card = try card("c")
        XCTAssertEqual(card.stage, .checkFailed)
        XCTAssertEqual(card.head, "Check failed: PostgreSQL specs")
        XCTAssertEqual(card.segments.filter { $0 == .failed }.count, 1)
        XCTAssertEqual(card.actions.map(\.label), [LandingPullRequestWords.log, LandingPullRequestWords.view])
        XCTAssertFalse(card.showsTip(workspaceMode: nil, hidden: false))
    }

    func testCatchingUpWhenMainMoved() throws {
        let card = try card("d")
        XCTAssertEqual(card.stage, .catchingUp)
        XCTAssertEqual(card.head, "Catching up with main")
        XCTAssertEqual(card.detail, "main moved since the pull request opened. Orbit is checking the branch again on the new main.")
    }

    func testMergedAndClosed() throws {
        let merged = try card("e")
        XCTAssertEqual(merged.stage, .merged)
        XCTAssertEqual(merged.head, "Landed by pull request #104")
        XCTAssertEqual(merged.detail, "Merged into main · 69601b4")
        let closed = try card("closed")
        XCTAssertEqual(closed.stage, .closed)
        XCTAssertEqual(closed.head, "Pull request closed")
        XCTAssertEqual(closed.detail, "Pull request #105 was closed without merging it.")
    }

    func testPushRefusedFallsBackToAPullRequestAndLinksTheWorkspace() throws {
        let view = try landing("f")
        let pr = try XCTUnwrap(view.pullRequest)
        let card = LandingPullRequestCard.make(pr, main: "main")
        XCTAssertEqual(card.stage, .fellBack)
        XCTAssertEqual(card.head, "Opened a pull request instead")
        XCTAssertEqual(card.right, "Push refused")
        XCTAssertEqual(card.actions.last?.destination, .workspaceLanding(pr.workspaceId))
        XCTAssertNotNil(pr.workspaceId)
    }

    func testAnAttemptHeldOnItsPullRequestWaitsForGitHubInsteadOfStopping() throws {
        let view = try landing("b")
        let attempt = try XCTUnwrap(view.currentAttempt)
        XCTAssertEqual(attempt.state, "PULL_REQUEST")
        let card = LandingPageCopy.terminalCard(view, attempt: attempt, word: "Landing", unavailable: false)
        XCTAssertEqual(card.right, "Waiting for GitHub")
        XCTAssertEqual(card.detail, "Waiting for GitHub")
        XCTAssertNil(card.failure)
        XCTAssertFalse(card.stoppedOnFailure)
    }

    func testTheProjectsInFlightJobAndTheTasksLandingCarryTheSameBlock() throws {
        let integration = try XCTUnwrap(try views()["integration"]?["a"] as? [String: Any])
        let view = try decode(ProjectIntegrationView.self, integration)
        XCTAssertNotNil(view.inFlight, "inFlight decoded")
        XCTAssertEqual(view.inFlight?.pullRequest?.number, 100)
        XCTAssertEqual(view.inFlight?.pullRequest?.checks.passed, 2)
        XCTAssertEqual(ProjectPage.landingCard(view)?.pullRequest, view.inFlight?.pullRequest)
        let land = try decode(LandTaskIntegrationView.self, [
            "jobId": "j", "state": "PULL_REQUEST", "targetRef": "refs/heads/main",
            "pullRequest": try XCTUnwrap((try views()["landing"]?["b"] as? [String: Any])?["pullRequest"]),
        ])
        XCTAssertEqual(land.pullRequest?.condition, "REVIEW_REQUIRED")
    }

    // MARK: workspace setting

    private func workspace(_ key: String) throws -> WorkspaceLandingView {
        try decode(WorkspaceLandingView.self, try XCTUnwrap(try views()["workspaceLanding"]?[key]))
    }

    func testTheSettingOffersPullRequestAsDefaultAndPushAsMe() throws {
        let landing = try workspace("pullRequest")
        XCTAssertEqual(landing.mode, "PULL_REQUEST")
        XCTAssertTrue(WorkspaceLandingCopy.pushAsMeEnabled(landing))
        XCTAssertEqual(WorkspaceLandingCopy.pullRequest, "Pull request")
        XCTAssertEqual(WorkspaceLandingCopy.defaultBadge, "Default")
        XCTAssertEqual(WorkspaceLandingCopy.pushAsMe, "Push as me")
        XCTAssertEqual(WorkspaceLandingCopy.fasterBadge, "Faster")
        XCTAssertTrue(WorkspaceLandingCopy.pushAsMeBody.contains("doesn't wait for a pull request"))
        XCTAssertTrue(WorkspaceLandingCopy.pushAsMeBody.contains("Needs the right to push to main."))
        XCTAssertNil(WorkspaceLandingCopy.refusal(landing))
    }

    func testRefusalShowsOnlyOnPushAsMe() throws {
        let refused = try workspace("refused")
        let refusal = try XCTUnwrap(WorkspaceLandingCopy.refusal(refused))
        XCTAssertEqual(refusal.branch, "main")
        XCTAssertEqual(
            WorkspaceLandingCopy.refusalText(branch: "main", repo: "owner/repo", message: "nope"),
            "GitHub refused your last push to main on owner/repo: “nope” Landings here open a pull request until GitHub accepts your push. Connect GitHub again if your rights have changed.")
        XCTAssertEqual(WorkspaceLandingCopy.repoSlug("https://github.com/owner/repo.git"), "owner/repo")
        XCTAssertNil(WorkspaceLandingCopy.repoSlug(nil))
    }

    func testNotFromGitHubHasNoChoiceAndNotConnectedDisablesPushAsMe() throws {
        let notGithub = try workspace("notFromGithub")
        XCTAssertNil(notGithub.mode)
        XCTAssertEqual(notGithub.pushAsMe.reason, "WORKSPACE_NOT_FROM_GITHUB")
        let notConnected = try workspace("notConnected")
        XCTAssertFalse(WorkspaceLandingCopy.pushAsMeEnabled(notConnected))
        XCTAssertEqual(notConnected.pushAsMe.reason, "GITHUB_NOT_CONNECTED")
    }

    func testPermissionsPending() throws {
        let pending = try XCTUnwrap(try workspace("permissionsPending").permissionsPending)
        XCTAssertEqual(WorkspaceLandingCopy.permissionsText(account: pending.account),
                       "Landing through pull requests starts once owner accepts Orbit's updated GitHub permissions.")
        XCTAssertTrue(pending.reviewUrl.hasPrefix("https://github.com/settings/installations/"))
    }

    func testTheWorkspaceReadCarriesTheSettingAndTheRequestWritesIt() throws {
        let landing = try XCTUnwrap(try views()["workspaceLanding"]?["pullRequest"])
        let agent = try decode(Agent.self, ["id": "w", "name": "n", "landingMode": "PUSH_AS_ME", "landing": landing])
        XCTAssertEqual(agent.landingMode, "PUSH_AS_ME")
        XCTAssertEqual(agent.landing?.mode, "PULL_REQUEST")
        let body = try JSONEncoder().encode(UpdateAgentRequest(landingMode: "PUSH_AS_ME"))
        XCTAssertEqual(String(data: body, encoding: .utf8), #"{"landingMode":"PUSH_AS_ME"}"#)
    }

    // MARK: held to the web's own words

    private func said(_ file: String) throws -> String {
        String(decoding: try repoFile(file), as: UTF8.self)
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    func testTheWordsAreTheWebs() throws {
        let card = try said(Self.card)
        for words in [LandingPullRequestWords.view, LandingPullRequestWords.review, LandingPullRequestWords.log,
                      LandingPullRequestWords.tip, LandingPullRequestWords.tipLink, LandingPullRequestWords.dismiss,
                      "Pull request open", "Waiting for review", "Pull request closed", "Opened a pull request instead",
                      "Push refused", "Sent back to the session with the log. Fixes update this pull request."] {
            XCTAssertTrue(card.contains(words), "LandingPullRequest.tsx no longer says \(words)")
        }
        let setting = try said(Self.setting)
        for words in [WorkspaceLandingCopy.lead, WorkspaceLandingCopy.pullRequestBody, WorkspaceLandingCopy.pushAsMeBody,
                      WorkspaceLandingCopy.notConnected, WorkspaceLandingCopy.connect, WorkspaceLandingCopy.notGithub,
                      WorkspaceLandingCopy.refused, WorkspaceLandingCopy.connectAgain, WorkspaceLandingCopy.review] {
            XCTAssertTrue(setting.contains(words), "WorkspaceLandingSetting.tsx no longer says \(words)")
        }
    }
}
