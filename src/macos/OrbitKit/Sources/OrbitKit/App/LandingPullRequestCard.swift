import Foundation

/// The landing's pull request states (docs/mocks/protected-branch-landing 02, owner 2026-11-23; design §11.2),
/// drawn from the `pullRequest` block the landing read models carry. A port of the web's `pullRequestCard`
/// (`src/web/src/components/LandingPullRequest.tsx`): one function reads the block into the card's words, so a
/// test can pin every state, and the apps only draw it. Its words are held to that file by
/// `LandingPullRequestCopyParityTests`.
public enum LandingPullRequestWords {
    public static let view = "View on GitHub ↗"
    public static let review = "Review on GitHub ↗"
    public static let log = "View log ↗"
    public static let settings = "Landing settings"
    public static let tip = "Faster next time: with Push as me, landings go straight to main when you may push there, without waiting for a pull request."
    public static let tipLink = "Landing settings ›"
    public static let dismiss = "Hide this tip"
    public static let openSession = "Open session"
}

public struct LandingPullRequestCard: Equatable, Sendable {
    public enum Stage: String, Sendable {
        case opened = "OPENED", waitingForReview = "WAITING_FOR_REVIEW", checkFailed = "CHECK_FAILED"
        case catchingUp = "CATCHING_UP", merged = "MERGED", closed = "CLOSED", fellBack = "FELL_BACK"
    }
    public enum Tone: String, Sendable { case blue, green, red, amber }
    public enum Segment: String, Sendable { case passed, failed, pending }
    public enum Destination: Equatable, Sendable {
        /// A page on GitHub.
        case web(String)
        /// The workspace's settings, at its Landing section.
        case workspaceLanding(String?)
    }
    public struct Action: Equatable, Sendable {
        public let label: String
        public let destination: Destination
    }

    public let stage: Stage
    public let head: String
    /// "2 of 6", "6 of 6 ✓", or nil when the card keeps nothing at the right.
    public let right: String?
    public let detail: String
    public let tone: Tone
    /// One segment per required check.
    public let segments: [Segment]
    public let actions: [Action]

    /// The card for one pull request block. `main` is the branch the landing targets.
    public static func make(_ pr: LandingPullRequestView, main: String, workspaceId: String? = nil) -> LandingPullRequestCard {
        let workspaceId = workspaceId ?? pr.workspaceId
        let number = pr.number.map { "#\($0)" } ?? ""
        let view: [Action] = (pr.url.flatMap { $0.isEmpty ? nil : $0 }).map {
            [Action(label: LandingPullRequestWords.view, destination: .web($0))]
        } ?? []
        let passed = pr.checks.passed, required = pr.checks.required, failed = pr.checks.failed
        let segments: [Segment] = (0..<max(required, 0)).map { i in
            i < passed ? .passed : i < passed + failed.count ? .failed : .pending
        }
        let count = "\(passed) of \(required)"
        let url = pr.url.flatMap { $0.isEmpty ? nil : $0 }

        if pr.state == "MERGED" {
            let sha = pr.mergedSha.map { " · \($0.prefix(7))" } ?? ""
            return LandingPullRequestCard(
                stage: .merged, head: "Landed by pull request \(number)".trimmingCharacters(in: .whitespaces),
                right: nil, detail: "Merged into \(main)\(sha)", tone: .green, segments: segments, actions: view)
        }
        if pr.state == "CLOSED" {
            return LandingPullRequestCard(
                stage: .closed, head: "Pull request closed", right: nil,
                detail: "Pull request \(number) was closed without merging it.".replacingOccurrences(of: "  ", with: " "),
                tone: .red, segments: segments, actions: view)
        }
        if pr.condition == "CHECK_FAILED", let first = failed.first {
            let log = (first.url.flatMap { $0.isEmpty ? nil : $0 }).map {
                [Action(label: LandingPullRequestWords.log, destination: .web($0))]
            } ?? []
            return LandingPullRequestCard(
                stage: .checkFailed, head: "Check failed: \(first.name)", right: nil,
                detail: "Sent back to the session with the log. Fixes update this pull request.",
                tone: .red, segments: segments, actions: log + view)
        }
        if let refusal = pr.refusal, refusal.via == "PUSH_AS_ME" {
            return LandingPullRequestCard(
                stage: .fellBack, head: "Opened a pull request instead", right: "Push refused",
                detail: "GitHub refused the push to \(main): “\(refusal.message)” Landing through pull request \(number).",
                tone: .amber, segments: segments,
                actions: view + [Action(label: LandingPullRequestWords.settings, destination: .workspaceLanding(workspaceId))])
        }
        if pr.condition == "BEHIND" {
            return LandingPullRequestCard(
                stage: .catchingUp, head: "Catching up with \(main)", right: count,
                detail: "\(main) moved since the pull request opened. Orbit is checking the branch again on the new \(main).",
                tone: .blue, segments: segments, actions: view)
        }
        if ["REVIEW_REQUIRED", "CHANGES_REQUESTED", "MERGEABLE"].contains(pr.condition ?? "") {
            return LandingPullRequestCard(
                stage: .waitingForReview, head: "Waiting for review", right: "\(count) ✓",
                detail: "Checks passed. \(main) requires an approving review.",
                tone: .blue, segments: segments,
                actions: url.map { [Action(label: LandingPullRequestWords.review, destination: .web($0))] } ?? [])
        }
        return LandingPullRequestCard(
            stage: .opened, head: "Pull request open", right: count,
            detail: "\(main) requires a pull request. Waiting for the required checks.",
            tone: .blue, segments: segments, actions: view)
    }

    /// The Faster tip belongs under a card that waits for review, while the workspace is not on Push as me.
    /// `workspaceMode` is the workspace's own `landingMode`, when the app has it; `pushAsMe` overrides it.
    public func showsTip(workspaceMode: String?, pushAsMe: Bool = false, hidden: Bool) -> Bool {
        stage == .waitingForReview && !pushAsMe && workspaceMode != "PUSH_AS_ME" && !hidden
    }
}

/// The workspace's landing setting (docs/mocks/protected-branch-landing, option A, owner 2026-11-23): a "Landing"
/// section with both choices visible, so "faster" and "needs the right to push" sit side by side. A port of the
/// web's `WorkspaceLandingSetting`.
public enum WorkspaceLandingCopy {
    public static let section = "Landing"
    public static let lead = "How finished work reaches main on GitHub."
    public static let pullRequest = "Pull request"
    public static let pullRequestBody = "Orbit pushes to main when GitHub allows it. When main requires a pull request, Orbit opens one and merges it once the branch's rules pass: required checks, and a review if one is required."
    public static let pushAsMe = "Push as me"
    public static let pushAsMeBody = "Orbit pushes to main with your GitHub account, so a landing doesn't wait for a pull request where you may push past main's rules. Needs the right to push to main. If GitHub refuses, Orbit opens a pull request instead."
    public static let defaultBadge = "Default"
    public static let fasterBadge = "Faster"
    public static let notConnected = "Connect GitHub to push as yourself."
    public static let connect = "Connect GitHub ›"
    public static let notGithub = "Landings push with this machine's Git credential."
    public static let refused = "Push refused."
    public static let connectAgain = "Connect GitHub again ›"
    public static let review = "Review on GitHub ↗"

    public static func permissionsText(account: String) -> String {
        "Landing through pull requests starts once \(account) accepts Orbit's updated GitHub permissions."
    }

    public static func refusalText(branch: String, repo: String?, message: String) -> String {
        "GitHub refused your last push to \(branch)\(repo.map { " on \($0)" } ?? ""): “\(message)” Landings here open a pull request until GitHub accepts your push. Connect GitHub again if your rights have changed."
    }

    /// `owner/repo` of a GitHub URL, for the refusal notice.
    public static func repoSlug(_ url: String?) -> String? {
        guard let url,
              let regex = try? NSRegularExpression(pattern: #"github\.com[/:]([^/]+/[^/.]+?)(?:\.git)?/?$"#),
              let match = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
              let range = Range(match.range(at: 1), in: url) else { return nil }
        return String(url[range])
    }

    /// Whether the Push as me row can be chosen: GitHub is connected and the workspace came from it.
    public static func pushAsMeEnabled(_ landing: WorkspaceLandingView) -> Bool { landing.pushAsMe.available }

    /// The refusal notice shows only while the workspace is on Push as me.
    public static func refusal(_ landing: WorkspaceLandingView) -> WorkspaceLandingView.Refusal? {
        landing.mode == "PUSH_AS_ME" ? landing.lastRefusal : nil
    }
}
