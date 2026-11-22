import Foundation

/// Orbit Cloud's Update card, confirmation and version line (docs/managed-runner-update-now-design.md,
/// board 5), driven by the managed status's `update` field instead of a self-managed runner's `selfUpdate`.
/// Its copy is kept here, not in `RunnerPageCopy`, which is held sentence by sentence to the web's runnerCopy.ts.
public enum ManagedRunnerUpdateCopy {
    public static let AVAILABLE_BODY =
        "It moves the next time this runner is idle. Update Now restarts it on the new build now."
    public static let RESTARTING_BODY = "Usually under a minute."
    public static let RESTARTING_BODY_WAITS_FOR_IDLE = "It restarts once the runner is idle."
    /// About's Updates row on Orbit Cloud.
    public static let ABOUT_UPDATES = "Updates"
    public static let ABOUT_UPDATES_VALUE = "Each new build"
    public static let CONFIRM_TITLE = "Update Orbit Cloud now?"
    public static let CONFIRM_IDLE = "Update Now"
    public static func availableTitle(build: String) -> String { "The \(build) is available" }
    public static func restartingTitle(build: String) -> String { "Restarting into the \(build)…" }
    public static func updatedTitle(build: String) -> String { "Updated to the \(build)" }
    public static func bodyNone(build: String) -> String {
        "No turn is running. It restarts on the \(build) — usually under a minute."
    }
    public static func bodyOne(build: String) -> String {
        "It stops 1 turn and restarts on the \(build). It continues where it stopped."
    }
    public static func bodyMany(turns: Int, build: String) -> String {
        "It stops \(turns) turns and restarts on the \(build). Each continues where it stopped."
    }
    public static func jobs(_ count: Int) -> String {
        count == 1 ? "1 background job stops too." : "\(count) background jobs stop too."
    }
    public static func confirm(turns: Int) -> String {
        turns == 0 ? CONFIRM_IDLE : turns == 1 ? "Interrupt 1 Turn and Update" : "Interrupt \(turns) Turns and Update"
    }
}

/// The build an Update Now finished on, kept while its card is shown (a day, as a self-managed runner's is).
public struct ManagedRunnerUpdated: Equatable, Sendable {
    public let build: ManagedRunnerBuild
    public let at: Date

    public init(build: ManagedRunnerBuild, at: Date) {
        self.build = build
        self.at = at
    }
}

public enum ManagedRunnerUpdateLogic {
    /// `95884b1`: a sha as every client names a build.
    public static func shortSha(_ sha: String) -> String { String(sha.prefix(7)) }

    private static func dayLabel(_ iso: String?, timeZone: TimeZone) -> String? {
        guard let iso, let date = RelativeTime.parse(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }

    /// The version line: `Build 95884b1 · Nov 16`, or `Build 95884b1` when no build date is known.
    public static func buildLine(_ build: ManagedRunnerBuild, timeZone: TimeZone = .current) -> String {
        let name = "Build " + shortSha(build.sha)
        guard let day = dayLabel(build.builtAt, timeZone: timeZone) else { return name }
        return name + RunnerPageCopy.RUNNER_LINE_SEPARATOR + day
    }

    /// How a card names a build: `Nov 18 build`, or `build 1a2b3c4` when it has no date.
    public static func buildName(_ build: ManagedRunnerBuild, timeZone: TimeZone = .current) -> String {
        dayLabel(build.builtAt, timeZone: timeZone).map { "\($0) build" } ?? "build " + shortSha(build.sha)
    }

    /// The build a runner's `managed-<sha>` version names, with the date the status knows for it.
    public static func runningBuild(version: String?, known: ManagedRunnerBuild?) -> ManagedRunnerBuild? {
        let trimmed = version?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard trimmed.hasPrefix("managed-") else { return nil }
        let sha = String(trimmed.dropFirst("managed-".count))
        guard !sha.isEmpty else { return nil }
        if let known, known.sha.hasPrefix(sha) || sha.hasPrefix(known.sha) { return known }
        return ManagedRunnerBuild(sha: sha)
    }

    /// Whether the machine row draws the update dot: an older build is running and nothing is moving it yet.
    public static func showsDot(_ status: ManagedRunnerStatus?) -> Bool {
        status?.update?.phase == "available"
    }

    /// The card's phases: `available`, `updating` (Restarting) and `updated`.
    public struct Card: Equatable, Sendable {
        public let phase: String
        public let warn: Bool
        public let title: String
        public let tag: String
        public let body: String
        /// Update Now… is drawn: an owner's `available` card only.
        public let canUpdateNow: Bool
        /// The build Update Now moves it to, for the confirmation's body.
        public let build: ManagedRunnerBuild
    }

    /// The card the status calls for; nil when the runner is current (no `update`) and no update finished in the
    /// last day. A reader who is not the runner's owner sees the card without Update Now….
    public static func card(status: ManagedRunnerStatus?, updated: ManagedRunnerUpdated? = nil, isOwner: Bool = true,
                            now: Date = Date(), timeZone: TimeZone = .current) -> Card? {
        if let update = status?.update {
            let build = buildName(update.current, timeZone: timeZone)
            switch update.phase {
            case "available":
                return Card(phase: "available", warn: false, title: ManagedRunnerUpdateCopy.availableTitle(build: build),
                            tag: RunnerPageCopy.RUNNER_UPDATE_TAG_AVAILABLE, body: ManagedRunnerUpdateCopy.AVAILABLE_BODY,
                            canUpdateNow: isOwner, build: update.current)
            case "updating":
                return Card(phase: "updating", warn: true, title: ManagedRunnerUpdateCopy.restartingTitle(build: build),
                            tag: RunnerPageCopy.RUNNER_UPDATE_TAG_RESTARTING,
                            body: update.waitsForIdle ? ManagedRunnerUpdateCopy.RESTARTING_BODY_WAITS_FOR_IDLE
                                : ManagedRunnerUpdateCopy.RESTARTING_BODY,
                            canUpdateNow: false, build: update.current)
            default:
                return nil
            }
        }
        guard let updated, now.timeIntervalSince(updated.at) <= Double(RunnerPageCopy.RUNNER_UPDATE_TAG_UPDATED_HOURS) * 3600,
              now >= updated.at.addingTimeInterval(-60) else { return nil }
        let clock = DateFormatter()
        clock.locale = Locale(identifier: "en_US_POSIX")
        clock.timeZone = timeZone
        clock.dateFormat = "HH:mm"
        return Card(phase: "updated", warn: false,
                    title: ManagedRunnerUpdateCopy.updatedTitle(build: buildName(updated.build, timeZone: timeZone)),
                    tag: clock.string(from: updated.at), body: "", canUpdateNow: false, build: updated.build)
    }

    /// What follows from one status read after another: an update that was on its way and is gone with the
    /// runner READY has finished, on the build it was moving to; a new `update` ends the mark.
    public static func observe(previous: ManagedRunnerStatus?, next: ManagedRunnerStatus?, updated: ManagedRunnerUpdated?,
                               now: Date) -> ManagedRunnerUpdated? {
        guard let next else { return updated }
        if next.update != nil { return nil }
        if let moved = previous?.update, moved.phase == "updating", next.managementState == "READY" {
            return ManagedRunnerUpdated(build: moved.current, at: now)
        }
        return updated
    }

    // MARK: the confirmation (board 5)

    public struct Confirmation: Equatable, Sendable {
        public let title: String
        public let body: String
        /// `Fix login redirect · 18 min`, longest running first as the server lists them.
        public let turns: [String]
        public let jobsNote: String?
        public let confirm: String
        /// The whole question as one text, for an alert's message.
        public var message: String {
            var paragraphs = [body]
            if !turns.isEmpty { paragraphs.append(turns.joined(separator: "\n")) }
            if let jobsNote { paragraphs.append(jobsNote) }
            return paragraphs.joined(separator: "\n\n")
        }
    }

    /// The confirmation for a busy runner: the turns and background jobs the 409 named, as of `now`.
    public static func confirmation(_ busy: ManagedRunnerBusy, build: ManagedRunnerBuild, now: Date,
                                    timeZone: TimeZone = .current) -> Confirmation {
        let name = buildName(build, timeZone: timeZone)
        let turns = busy.turns.map { turn -> String in
            let title = turn.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let shown = title.isEmpty ? RunnerPageCopy.RUNNER_UPDATE_UNTITLED_TURN : title
            guard let started = turn.startedAt.flatMap({ RelativeTime.parse($0) }) else { return shown }
            let minutes = max(0, Int(now.timeIntervalSince(started) / 60))
            return shown + RunnerPageCopy.RUNNER_LINE_SEPARATOR + RunnerPageFormat.updateWaited(minutes: minutes)
        }
        let count = busy.turns.count
        return Confirmation(
            title: ManagedRunnerUpdateCopy.CONFIRM_TITLE,
            body: count == 0 ? ManagedRunnerUpdateCopy.bodyNone(build: name)
                : count == 1 ? ManagedRunnerUpdateCopy.bodyOne(build: name)
                : ManagedRunnerUpdateCopy.bodyMany(turns: count, build: name),
            turns: turns,
            jobsNote: busy.backgroundJobs > 0 ? ManagedRunnerUpdateCopy.jobs(busy.backgroundJobs) : nil,
            confirm: ManagedRunnerUpdateCopy.confirm(turns: count))
    }

    /// The busy answer inside a refused Update Now, or nil for any other failure.
    public static func busy(from error: Error) -> ManagedRunnerBusy? {
        guard case APIError.http(409, let body?) = error,
              let data = body.data(using: .utf8),
              let busy = try? JSONDecoder().decode(ManagedRunnerBusy.self, from: data),
              busy.code == "MANAGED_RUNNER_BUSY" else { return nil }
        return busy
    }
}
