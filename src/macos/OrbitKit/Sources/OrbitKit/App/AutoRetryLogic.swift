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

    /// What a continue sends — the sentence the card's button sends in the reader's name, and the
    /// one the armed retry sends at the reset. Mirrors `CONTINUE_MESSAGE` in @orbit/shared, where
    /// the server's half of the same rule lives.
    public static let continueMessage = "Continue where you left off."

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
        /// There is nothing of anybody's for a re-send to carry, so every verb on this card is
        /// Continue: the failure landed on a turn nobody sent and the reader's own message was
        /// answered long before it. What the two controls send is `continueMessage` — by hand now,
        /// or by the server at the reset through the switch.
        public var continues: Bool
        /// What the card says while its moment is passing: re-sending somebody's words, or picking
        /// the session back up with the platform's own.
        public var firingText: String
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
        /// The answer a Retry got when the task had already moved on to another run.
        ///
        /// The card is the reason this is a field rather than a status line. Retry is the card's
        /// own control, and a refusal that only flashed past somewhere else left the card exactly
        /// as it was — still offering the button, still reading as though nothing had happened,
        /// which is indistinguishable from a press that did nothing. The situation belongs to the
        /// card because it is the card's own claim ("this failed and can be re-sent") that has
        /// stopped being true: somebody else is already doing it.
        public var takenOver: TaskRunHandoff.Conflict?
    }

    /// - Parameters:
    ///   - live: this card describes the current situation (not a settled outage, and there is a
    ///     session to act through). A stale card degrades to the diagnosis alone.
    ///   - retryAt: the server's armed retry, or nil when nothing is armed.
    ///   - attempts: attempts already spent on this outage — what separates "never armed" from
    ///     "gave up".
    ///   - hasRetryText: there is a last user message a manual retry could re-send.
    ///   - nothingToResend: the server answered that there is nothing of anybody's to send —
    ///     not the reader's words, and not a reply or confirmation turn the sweep re-sends on its
    ///     own (`APIClient.retryMessage`). The card continues instead of re-sending.
    public static func state(notice: AutoRetryNotice,
                             live: Bool,
                             retryAt: Date?,
                             attempts: Int,
                             provider: String,
                             runnerName: String?,
                             hasRetryText: Bool,
                             nothingToResend: Bool = false,
                             now: Date,
                             takenOver: TaskRunHandoff.Conflict? = nil,
                             rand: () -> Double = { .random(in: 0..<1) }) -> State {
        let quota = notice.variant == .quota
        // Read once: the body, the labels and the two controls all branch on it, and they must
        // never disagree about which verb this card is offering.
        let continues = live && nothingToResend
        // Only a card with a session behind it can be taken over: a stale card is history (the
        // session went on) and the share page's has no console to have pressed anything.
        let takenOver = live ? takenOver : nil
        let at = live ? retryAt : nil
        let secondsLeft = at.map { $0.timeIntervalSince(now) } ?? 0
        let armed = at != nil && secondsLeft > 0
        // "Re-sending your message…" is a promise, and it is false once another run has the task.
        // Both at once would have the card claiming to be doing the thing it just declined to do.
        let firing = at != nil && secondsLeft <= 0 && takenOver == nil
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
        // Why there is no Retry, said where the button would have been. Nothing of the reader's is
        // waiting to go out — the failure landed on a turn nobody sent — and that, not a switch
        // position, is the fact that decides what this card offers.
        let nothingToSend = quota
            ? "Nothing to re-send — the limit landed on a turn that wasn’t yours."
            : "Nothing to re-send — the failure landed on a turn that wasn’t yours."
        if gaveUp {
            body = quota
                ? "Tried \(attempts) times — the quota still reports as spent. Over to you."
                : "Tried \(attempts) times — the API is still failing. Over to you."
        } else if quota {
            let on = runnerName.map { $0.isEmpty ? "" : " on “\($0)”" } ?? ""
            body = "\(window.what) for \(provider)\(on) is used up."
                + (continues ? " \(nothingToSend)" : needsYou ? " Auto-retry is off." : "")
        } else {
            body = "The \(provider) API could not answer — nothing about your message caused it."
                + (continues ? " \(nothingToSend)" : needsYou ? " Auto-retry is off." : "")
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
            continues: continues,
            firingText: continues
                ? "Continuing — picking up where it left off…"
                : "Retrying — re-sending your message…",
            countdown: armed ? countdownText(seconds: secondsLeft) : nil,
            showsResetAt: quota,
            showsAutoRow: armed || canArm,
            autoLabel: continues
                ? (quota ? "Continue when the quota resets" : "Continue — this usually clears")
                : (quota ? "Auto-retry when the quota resets" : "Auto-retry — this usually clears"),
            autoDetail: armed
                ? "Runs on the server — you don't have to stay here."
                : continues ? "Off — nothing will continue until you do."
                            : "Off — nothing will re-send until you do.",
            rearmAt: rearmAt,
            // …and the press itself is withdrawn: with the task in another run's hands, the only
            // answer this button can get is the refusal that is now standing in its place.
            // A continue is pressable on the same terms — it needs no words from this window, only
            // the server's answer that a continue is what the session is waiting on.
            retryNowTitle: (live && !firing && (hasRetryText || continues) && takenOver == nil)
                ? (armed ? (continues ? "Continue now anyway" : "Retry now anyway")
                         : (continues ? "Continue" : "Retry now")) : nil,
            // The one promise the card can make about words nobody wrote: which sentence the press
            // sends. Said under the button rather than left to the transcript, because the sentence
            // goes out in the reader's name.
            retryNowNote: (live && !firing && (hasRetryText || continues) && takenOver == nil)
                ? (armed
                    ? (quota ? "The quota hasn’t reset yet — this will likely fail again."
                             : "The API may still be failing — this could fail again.")
                    : continues ? "Sends “\(continueMessage)”" : nil)
                : nil,
            quotesRetryText: live && !firing && hasRetryText && !notice.afterUserMsg
                && takenOver == nil,
            takenOver: takenOver)
    }

    /// Which of an account's quota windows a usage-limit failure says ran out — web's
    /// `quotaWindowKind` (`lib/quotaWindow.ts`).
    public enum QuotaWindow: Equatable, Sendable {
        case fiveHour, weekly, other
    }

    /// The window that ran out, in the runtime's own terms. Keyed on the whole phrase the runtime
    /// uses ("hit your weekly limit"), not on "weekly limit" loose in the text: naming the wrong
    /// window tells the user to wait days for a quota that comes back in hours. Codex names no
    /// window at all and is `other`.
    ///
    /// One judgment for both places that name the window: this card's title, and the pause line of
    /// an evidence version waiting for its coordinator (`EvidenceDecisions.coordinatorPause`), so the
    /// line can never name another window than the card above it. Whether a failure is a usage
    /// limit at all is `EngineErrors.isUsageLimitErrorText`'s answer, not this one's.
    public static func quotaWindowKind(_ message: String) -> QuotaWindow {
        let m = message.lowercased()
        if m.contains("hit your session limit") { return .fiveHour }
        if m.contains("hit your weekly limit") { return .weekly }
        return .other
    }

    /// The card's words for that window.
    ///
    /// The runtime calls its 5-hour window a "session limit", but here that reads as a limit on the
    /// Orbit session the card sits in — the one noun this product uses for something else entirely.
    /// Titled by its length instead; the runtime's own phrasing survives in the body.
    static func quotaWindow(_ message: String) -> (title: String, what: String) {
        switch quotaWindowKind(message) {
        case .fiveHour: return ("5-hour limit reached", "The 5-hour quota")
        case .weekly:   return ("Weekly limit reached", "The weekly quota")
        case .other:    return ("Usage limit reached", "The quota")
        }
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
