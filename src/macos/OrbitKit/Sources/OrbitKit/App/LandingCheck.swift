import Foundation

/// Approved web copy, mirrored by the native clients.
public enum LandingCheckCopy {
    public static let label = "Landing check"
    public static let confirmTitle = "Change project integration settings?"
    public static let confirmAction = "Confirm"
    public static let command = "Command"
    public static let timeout = "Timeout (seconds)"
    public static let hint = "Runs when a task lands on the project branch."
    public static let inherits = "Uses merge check"
    public static let commandPlaceholder = "Leave blank to use merge check"
    public static let inheritsTimeout = "Uses merge check timeout"
    public static let timeoutPlaceholder = "Leave blank to use merge check timeout"
    public static let timeoutHint = "Leave blank to use the merge check timeout."
    public static let main = "Not used when tasks land directly on main."
    public static let applies = "Applies to the next claimed landing job."
    public static let waiting = "Waiting for baseline fix"
    public static let resumes = "Landings resume automatically when this open item is resolved."
    public static let baselineBody = "The project branch with the latest main fails its checks without this task."
    public static let held = "Landings on hold"
    public static let upstream = "Upstream"
    public static let tip = "Project tip"
    public static let baseline = "Combined baseline"
    public static let viewHeld = "View held tasks"
    public static func attribution(_ passed: Bool) -> String {
        "Checked the project branch with main, without this task · " + (passed ? "passes" : "also fails")
    }
    public static func timelineText(_ entry: IntegrationTimelineEntry) -> String {
        entry.kind == "CHECK_FINISHED" && entry.data?["scope"]?.stringValue == "BASELINE"
            ? attribution(entry.checkPassed) : entry.text
    }
    /// Older result events omit scope; only the newest claim/round has matching recorded results.
    public static func scopedEntries(_ entries: [IntegrationTimelineEntry], landing: SessionLandingView,
                                     jobID: String) -> [IntegrationTimelineEntry] {
        guard let attempt = landing.currentAttempt, attempt.jobId == jobID else { return entries }
        return entries.map { entry in
            guard entry.claim == attempt.claim, entry.round == attempt.round,
                  let check = entry.check, check.name == "LANDING_CHECK", check.index > 0,
                  landing.checks.indices.contains(check.index - 1),
                  landing.checks[check.index - 1].scope == "BASELINE" else { return entry }
            var data = entry.data ?? [:]
            data["scope"] = .string("BASELINE")
            return IntegrationTimelineEntry(id: entry.id, seq: entry.seq, kind: entry.kind, at: entry.at,
                claim: entry.claim, round: entry.round, check: entry.check, phase: entry.phase,
                step: entry.step, reason: entry.reason, data: data, text: entry.text, derived: entry.derived)
        }
    }

    public static func title(_ branch: String) -> String { "Baseline checks failing on \(branch)" }
    public static func inheritedCommand(_ command: String?) -> String {
        command.map { "\(inherits): \($0)" } ?? inherits
    }
    public static func inheritedTimeout(_ seconds: Int?) -> String {
        seconds.map { "\(inheritsTimeout): \($0) seconds" } ?? inheritsTimeout
    }
}
