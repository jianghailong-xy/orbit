import Foundation

/// Update Now… (docs/runner-update-drain-design.md §2, D4): install the waiting release now,
/// interrupting the owner's turns in flight, which continue once the runner is back — the web's
/// `runnerUpdateNow.ts`. The words are `RunnerPageCopy`'s, held to the web's by
/// `RunnerPageCopyParityTests`.
public enum RunnerUpdateNow {
    /// Declared by a runner that honours Update Now (@orbit/shared `SELF_UPDATE_NOW_V1`). The control
    /// plane refuses Update Now for a runner without it.
    public static let capability = "self-update-now/v1"

    /// Whether this runner takes the owner's Update Now: it says it does, and has a release waiting
    /// (available, draining or postponed).
    public static func offered(_ runner: Runner) -> Bool {
        guard runner.capabilities?.contains(capability) == true,
              let report = runner.selfUpdate, report.targetVersion?.isEmpty == false else { return false }
        return report.phase == "available" || report.phase == "draining" || report.phase == "postponed"
    }

    /// What the confirmation asks (board 3 ⑧, board 5): the question, what it does, the turns it
    /// interrupts and how long each has run, the jobs note, and the red button's cost.
    public struct Confirmation: Equatable, Sendable {
        public let title: String
        public let body: String
        public let turns: [RunnerPageFormat.UpdateCard.Turn]
        /// Only when it interrupts something, as the web draws it.
        public let jobsNote: String?
        public let confirm: String
        public let version: String

        /// The whole question as one text, for an alert's message: the body, a line per turn
        /// (`Backfill missing shard rows · running 1 h 52 min`), then the jobs note.
        public var message: String {
            var paragraphs = [body]
            if !turns.isEmpty {
                paragraphs.append(turns.map { turn in
                    [turn.title, turn.running].compactMap { $0 }.joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
                }.joined(separator: "\n"))
            }
            if let jobsNote { paragraphs.append(jobsNote) }
            return paragraphs.joined(separator: "\n\n")
        }
    }

    /// The confirmation for `runner`, read as of `now` so each turn's `running 47 min` is as of the
    /// press. `machine` is the name the reader knows the runner by.
    public static func confirmation(_ runner: Runner, machine: String, now: Date) -> Confirmation {
        let version = runner.selfUpdate?.targetVersion ?? ""
        let turns = RunnerPageFormat.updateTurns(runner, now: now)
        return Confirmation(title: RunnerPageCopy.runnerUpdateNowTitle(runner: machine),
                            body: RunnerPageCopy.runnerUpdateNowBody(version: version, turns: turns.count),
                            turns: turns,
                            jobsNote: turns.isEmpty ? nil : RunnerPageCopy.RUNNER_UPDATE_NOW_JOBS_NOTE,
                            confirm: RunnerPageCopy.runnerUpdateNowConfirm(turns: turns.count),
                            version: version)
    }

    /// The body of POST /runners/:id/self-update/now: the owner's explicit "interrupt these turns".
    public static let request = RunnerSelfUpdateNowRequest(interruptTurns: true)

    // MARK: the transcript (D4)

    /// The interrupt event's reason for a turn the owner's Update Now stopped (@orbit/shared
    /// `RUNNER_UPDATE_INTERRUPT_REASON`), beside `runner_restart`.
    public static let interruptReason = "runner_update"

    /// The first sentence of the turn Orbit sends a session whose turn Update Now interrupted
    /// (@orbit/shared `RUNNER_UPDATE_RESUME_NOTE`).
    public static let resumeNote = "The runner update interrupted this turn; continue."

    /// Whether a user turn is the one Orbit sent to continue a turn the owner's Update Now cut: it
    /// opens with `[Orbit] ` and the note. Drawn as one Orbit line, not the owner's bubble.
    public static func isResume(_ text: String?) -> Bool {
        text?.hasPrefix("[Orbit] \(resumeNote)") == true
    }

    /// The line a resume turn is drawn as; nil for every other turn.
    public static func resumeLine(_ text: String?) -> String? {
        isResume(text) ? resumeNote : nil
    }
}

/// The choices between the sentences RunnerPageCopy declares one by one (as web's runnerCopy.ts does, which
/// RunnerPageCopyParityTests reads sentence by sentence): kept out of RunnerPageCopy.swift, as the web
/// keeps them out of runnerCopy.ts (runnerUpdateNow.ts, runnerUpdateCard.ts).
extension RunnerPageCopy {
    /// How long the Updated card stays: a day, then About's Last Update says it (board 4).
    public static let RUNNER_UPDATE_TAG_UPDATED_HOURS = 24

    /// Restarting for the owner's Update Now: `2 interrupted turns continue once it is back. Usually under a minute.`
    public static func runnerUpdateRestartingBodyInterrupted(turns: Int) -> String {
        turns == 1 ? RUNNER_UPDATE_RESTARTING_BODY_ONE : runnerUpdateRestartingBodyMany(turns: turns)
    }

    /// `34 s`, `1 min 12 s`, `2 min`.
    public static func runnerUpdateTook(seconds: Int) -> String {
        if seconds < 60 { return runnerUpdateTookSeconds(seconds: seconds) }
        let rest = seconds % 60
        return rest > 0 ? runnerUpdateTookMinutesSeconds(minutes: seconds / 60, seconds: rest) : runnerUpdateTookMinutes(minutes: seconds / 60)
    }

    /// `Took 34 s. 2 interrupted turns resumed.`; either half alone when the runner measured only that.
    public static func runnerUpdateUpdatedBody(took: String?, interruptedTurns: Int) -> String {
        var parts: [String] = []
        if let took { parts.append(runnerUpdateUpdatedTook(took: took)) }
        if interruptedTurns == 1 {
            parts.append(RUNNER_UPDATE_RESUMED_ONE)
        } else if interruptedTurns > 1 {
            parts.append(runnerUpdateResumedMany(turns: interruptedTurns))
        }
        return parts.joined(separator: " ")
    }

    /// The confirmation's first paragraph, by how many turns it interrupts.
    public static func runnerUpdateNowBody(version: String, turns: Int) -> String {
        if turns == 0 { return runnerUpdateNowBodyNone(version: version) }
        return turns == 1 ? runnerUpdateNowBodyOne(version: version) : runnerUpdateNowBodyMany(version: version)
    }

    /// The red button: `Interrupt 2 Turns and Update`; with nothing running, `Update Now`.
    public static func runnerUpdateNowConfirm(turns: Int) -> String {
        if turns == 0 { return RUNNER_UPDATE_NOW_CONFIRM }
        return turns == 1 ? RUNNER_UPDATE_NOW_CONFIRM_ONE : runnerUpdateNowConfirmMany(turns: turns)
    }

    /// The transcript's line for an interrupt the owner's Update Now made.
    public static func runnerUpdateInterruptedLine(version: String?) -> String {
        version.map { runnerUpdateInterruptedTo(version: $0) } ?? RUNNER_UPDATE_INTERRUPTED
    }
}
