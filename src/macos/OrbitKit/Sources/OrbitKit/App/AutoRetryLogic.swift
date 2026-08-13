import Foundation

/// What the auto-retry card shows, factored out of the SwiftUI view so every branch is unit-tested
/// on Linux. Mirrors web's `AutoRetryCard`: the transcript supplies the failure (`AutoRetryNotice`),
/// the session detail supplies the live retry state (`retryAt` / `retryAttempts`), and this decides
/// the wording and which controls are offered — no decisions live in the view.
///
/// A failure that fixes itself is not an error to act on, it is a pause. While a retry is armed the
/// card stays neutral: the situation is handled and nothing is being asked of the reader. It
/// escalates only when the ball is back in their court — no moment to retry at could be determined,
/// the retries ran out, or they switched it off themselves.
public enum AutoRetryLogic {

    /// How many attempts the server spends before handing back. A quota is retried until its own
    /// reported reset stops moving (auto-retry.service BACKOFF_MS); a provider error gets the
    /// shorter API_ERROR_RETRY_BACKOFF_MS ladder.
    public static func maxAttempts(_ variant: AutoRetryNotice.Variant) -> Int {
        switch variant {
        case .quota:    return 5
        case .apiError: return EngineErrors.maxApiErrorRetries
        }
    }

    public struct State: Equatable, Sendable {
        public var title: String
        public var body: String
        /// Show the runtime's sentence verbatim. Which error it was is the only actionable detail if
        /// it keeps recurring — and unlike a quota's sentence it is not restated by the body above.
        public var showsMessage: Bool
        /// A retry is pending and its moment is still ahead.
        public var armed: Bool
        /// Its moment has passed: the server is re-sending right now.
        public var firing: Bool
        public var gaveUp: Bool
        /// This outage is still open and nothing is going to move it — the only state that earns the
        /// warning tint. A stale card (the session went on) is history, not an alarm.
        public var needsYou: Bool
        /// The switch can be flipped back on, at `rearmAt`.
        public var canArm: Bool
        /// "in 27 sec" / "in 11 min", while there is something to count down to.
        public var countdown: String?
        /// A quota card leads with the absolute moment the window resets — a time the reader may
        /// need to plan around. A provider error's few minutes need no date.
        public var showsResetAt: Bool
        /// The auto-retry switch row: shown while armed (so it can be turned off) or while it can be
        /// put back. Off is rendered rather than implied by the row vanishing, so the state the user
        /// just chose stays legible.
        public var showsAutoRow: Bool
        public var autoLabel: String
        public var autoDetail: String
        /// When the switch is flipped back on, the instant the re-armed retry should fire. Nil when
        /// the runtime named no time (Codex quota messages don't) — then the switch isn't offered
        /// rather than offered dead.
        public var rearmAt: Date?
        /// Title of the manual retry button, or nil when there is nothing to re-send.
        public var retryNowTitle: String?
        /// The caveat under a manual retry that races an armed one.
        public var retryNowNote: String?
        /// Quote what would be re-sent. Suppressed when that bubble is the line directly above.
        public var quotesRetryText: Bool
    }

    /// - Parameters:
    ///   - live: this card describes the current situation (not a settled outage, and there is a
    ///     session to act through). A stale card degrades to the diagnosis alone.
    ///   - retryAt: the server's armed retry, or nil when nothing is armed.
    ///   - attempts: attempts already spent on this outage — what separates "never armed" from
    ///     "gave up".
    ///   - hasRetryText: there is a last user message a manual retry could re-send.
    public static func state(notice: AutoRetryNotice,
                             live: Bool,
                             retryAt: Date?,
                             attempts: Int,
                             provider: String,
                             runnerName: String?,
                             hasRetryText: Bool,
                             now: Date,
                             rand: () -> Double = { .random(in: 0..<1) }) -> State {
        let quota = notice.variant == .quota
        let at = live ? retryAt : nil
        let secondsLeft = at.map { $0.timeIntervalSince(now) } ?? 0
        let armed = at != nil && secondsLeft > 0
        let firing = at != nil && secondsLeft <= 0
        let gaveUp = live && at == nil && attempts >= maxAttempts(notice.variant)
        let needsYou = live && !armed && !firing
        let window = quotaWindow(notice.message)
        let rearmAt: Date? = quota
            ? EngineErrors.parseQuotaResetAt(notice.message, now: now)
            : EngineErrors.apiErrorRetryAt(attempts: attempts, now: now, rand: rand)
        let canArm = live && !armed && !firing && !gaveUp && rearmAt != nil

        let title: String
        if gaveUp { title = "Auto-retry gave up" }
        else if quota { title = window.title }
        else { title = "Provider unavailable" }

        // An unarmed card cannot tell WHY it is unarmed: "the user switched it off" and "no moment
        // to retry at could be determined" are both spelled `retryAt == nil`, and guessing wrong
        // tells the user their own click was a system limitation. So it states only what is true
        // either way, and the reason is visible in what they just did.
        let body: String
        if gaveUp {
            body = quota
                ? "Tried \(attempts) times — the quota still reports as spent. Over to you."
                : "Tried \(attempts) times — the API is still failing. Over to you."
        } else if quota {
            let on = runnerName.map { $0.isEmpty ? "" : " on “\($0)”" } ?? ""
            body = "\(window.what) for \(provider)\(on) is used up."
                + (needsYou ? " Auto-retry is off." : "")
        } else {
            body = "The \(provider) API could not answer — nothing about your message caused it."
                + (needsYou ? " Auto-retry is off." : "")
        }

        return State(
            title: title,
            body: body,
            showsMessage: !quota,
            armed: armed,
            firing: firing,
            gaveUp: gaveUp,
            needsYou: needsYou,
            canArm: canArm,
            countdown: armed ? countdownText(seconds: secondsLeft) : nil,
            showsResetAt: quota,
            showsAutoRow: armed || canArm,
            autoLabel: quota ? "Auto-retry when the quota resets" : "Auto-retry — this usually clears",
            autoDetail: armed
                ? "Runs on the server — you don't have to stay here."
                : "Off — nothing will re-send until you do.",
            rearmAt: rearmAt,
            retryNowTitle: (live && !firing && hasRetryText) ? (armed ? "Retry now anyway" : "Retry now") : nil,
            retryNowNote: (live && !firing && hasRetryText && armed)
                ? (quota ? "The quota hasn’t reset yet — this will likely fail again."
                         : "The API may still be failing — this could fail again.")
                : nil,
            quotesRetryText: live && !firing && hasRetryText && !notice.afterUserMsg)
    }

    /// The window that ran out, in the runtime's own terms. Keyed on the whole phrase the runtime
    /// uses ("hit your weekly limit"), not on "weekly limit" loose in the text: naming the wrong
    /// window tells the user to wait days for a quota that comes back in hours. Codex names no
    /// window at all and falls through to the generic wording.
    ///
    /// The runtime calls its 5-hour window a "session limit", but here that reads as a limit on the
    /// Orbit session the card sits in — the one noun this product uses for something else entirely.
    /// Titled by its length instead; the runtime's own phrasing survives in the body.
    static func quotaWindow(_ message: String) -> (title: String, what: String) {
        let m = message.lowercased()
        if m.contains("hit your session limit") { return ("5-hour limit reached", "The 5-hour quota") }
        if m.contains("hit your weekly limit") { return ("Weekly limit reached", "The weekly quota") }
        return ("Usage limit reached", "The quota")
    }

    /// "in 27 sec" / "in 11 min" / "in 2 hr" / "in 2 days" — the felt distance, next to the absolute
    /// time. Seconds matter: a provider-error retry is 30 seconds out, and rounding that up to
    /// "in 1 min" reads as a countdown that isn't moving.
    public static func countdownText(seconds: TimeInterval) -> String {
        if seconds < 60 { return "in \(max(1, Int(seconds.rounded(.up)))) sec" }
        let min = Int((seconds / 60).rounded(.up))
        if min < 60 { return "in \(min) min" }
        let hr = Int((Double(min) / 60).rounded())
        if hr < 36 { return "in \(hr) hr" }
        return "in \(Int((Double(hr) / 24).rounded())) days"
    }
}
