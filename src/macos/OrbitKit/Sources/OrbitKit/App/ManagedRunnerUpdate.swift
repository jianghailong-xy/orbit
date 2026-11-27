import Foundation

/// Orbit Cloud's Update card, confirmation and version line (docs/managed-runner-update-now-design.md, board 5),
/// driven by the managed status's `update` field instead of a self-managed runner's `selfUpdate`. Its words are
/// `RunnerPageCopy`'s managed* sentences, held to the web's by `RunnerPageCopyParityTests`.
/// An Update Now pressed and not yet seen through: when, how many turns it interrupted, and the build it goes to.
public struct ManagedRunnerPendingUpdate: Equatable, Sendable {
    public let at: Date
    public let interruptedTurns: Int
    public let to: ManagedRunnerBuild

    public init(at: Date, interruptedTurns: Int, to: ManagedRunnerBuild) {
        self.at = at
        self.interruptedTurns = interruptedTurns
        self.to = to
    }
}

/// The build an Update Now finished on, kept while its card is shown (a day, as a self-managed runner's is).
public struct ManagedRunnerUpdated: Equatable, Sendable {
    public let build: ManagedRunnerBuild
    public let at: Date
    /// How long the restart took (from the press), and how many turns it interrupted.
    public let tookSeconds: Int?
    public let interruptedTurns: Int

    public init(build: ManagedRunnerBuild, at: Date, tookSeconds: Int? = nil, interruptedTurns: Int = 0) {
        self.build = build
        self.at = at
        self.tookSeconds = tookSeconds
        self.interruptedTurns = interruptedTurns
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
        guard let day = dayLabel(build.builtAt, timeZone: timeZone) else {
            return RunnerPageCopy.managedBuildLine(sha: shortSha(build.sha))
        }
        return RunnerPageCopy.managedBuildLineBuilt(sha: shortSha(build.sha), built: day)
    }

    /// How a card names a build: its release version (`0.1.261-beta.83`) as a self-managed runner's reads, else
    /// `the Nov 18 build`, or `the 1a2b3c4 build` when it has no date.
    public static func buildName(_ build: ManagedRunnerBuild, timeZone: TimeZone = .current) -> String {
        if let version = build.version, !version.isEmpty { return version }
        return RunnerPageCopy.managedBuildNamed(name: dayLabel(build.builtAt, timeZone: timeZone) ?? shortSha(build.sha))
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
    public static func card(status: ManagedRunnerStatus?, updated: ManagedRunnerUpdated? = nil, isOwner: Bool = true, pendingTurns: Int? = nil,
                            now: Date = Date(), timeZone: TimeZone = .current) -> Card? {
        if let update = status?.update {
            let build = buildName(update.current, timeZone: timeZone)
            switch update.phase {
            case "available":
                return Card(phase: "available", warn: false,
                            title: RunnerPageCopy.managedUpdateAvailableTitle(build: capitalized(build)),
                            tag: RunnerPageCopy.RUNNER_UPDATE_TAG_AVAILABLE, body: RunnerPageCopy.MANAGED_UPDATE_AVAILABLE_BODY,
                            canUpdateNow: isOwner, build: update.current)
            case "updating":
                let interrupted = pendingTurns ?? 0
                return Card(phase: "updating", warn: true, title: RunnerPageCopy.managedUpdateRestartingTitle(build: build),
                            tag: RunnerPageCopy.RUNNER_UPDATE_TAG_RESTARTING,
                            body: interrupted > 0 ? RunnerPageCopy.runnerUpdateRestartingBodyInterrupted(turns: interrupted)
                                : RunnerPageCopy.RUNNER_UPDATE_RESTARTING_BODY,
                            canUpdateNow: false, build: update.current)
            default:
                return nil
            }
        }
        guard let updated, now.timeIntervalSince(updated.at) <= Double(RunnerPageCopy.RUNNER_UPDATE_TAG_UPDATED_HOURS) * 3600,
              now >= updated.at.addingTimeInterval(-60) else { return nil }
        return Card(phase: "updated", warn: false,
                    title: RunnerPageCopy.managedUpdateUpdatedTitle(build: buildName(updated.build, timeZone: timeZone)),
                    tag: RunnerPageCopy.MANAGED_UPDATE_TAG_UPDATED,
                    body: RunnerPageCopy.runnerUpdateUpdatedBody(
                        took: updated.tookSeconds.map { RunnerPageCopy.runnerUpdateTook(seconds: $0) },
                        interruptedTurns: updated.interruptedTurns),
                    canUpdateNow: false, build: updated.build)
    }

    private static func capitalized(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    /// What follows from one status read after another: an update that was on its way and is gone with the
    /// runner READY has finished, on the build it was moving to; a new `update` ends the mark.
    public static func observe(previous: ManagedRunnerStatus?, next: ManagedRunnerStatus?, updated: ManagedRunnerUpdated?,
                               pending: ManagedRunnerPendingUpdate? = nil, now: Date) -> ManagedRunnerUpdated? {
        guard let next else { return updated }
        if next.update != nil { return nil }
        if let moved = previous?.update, moved.phase == "updating", next.managementState == "READY" {
            return ManagedRunnerUpdated(
                build: pending?.to ?? moved.current, at: now,
                tookSeconds: pending.map { max(1, Int(now.timeIntervalSince($0.at).rounded())) },
                interruptedTurns: pending?.interruptedTurns ?? 0)
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
        /// The build it moves to, for the press that confirms.
        public let build: ManagedRunnerBuild
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
            return shown + RunnerPageCopy.RUNNER_LINE_SEPARATOR
                + RunnerPageCopy.runnerUpdateTurnRunning(duration: RunnerPageFormat.updateWaited(minutes: minutes))
        }
        let count = busy.turns.count
        return Confirmation(
            title: RunnerPageCopy.runnerUpdateNowTitle(runner: RunnerPageCopy.MANAGED_RUNNER_LABEL),
            body: count == 0 ? RunnerPageCopy.managedUpdateNowBodyNone(build: name)
                : count == 1 ? RunnerPageCopy.managedUpdateNowBodyOne(build: name)
                : RunnerPageCopy.managedUpdateNowBodyMany(build: name),
            turns: turns,
            jobsNote: busy.backgroundJobs > 0
                ? RunnerPageCopy.managedUpdateNowJobs(
                    jobs: busy.backgroundJobs,
                    noun: busy.backgroundJobs == 1 ? "background job" : "background jobs")
                : RunnerPageCopy.MANAGED_UPDATE_NOW_SERVICES,
            confirm: RunnerPageCopy.runnerUpdateNowConfirm(turns: count), build: build)
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
