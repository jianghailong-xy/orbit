import Foundation

/// What this end says when a message, or a Run, meets the run that actually holds a task.
///
/// One task has one run at a time — `session_task_execution_claim_idx` makes that a property of the
/// database — and the platform re-dispatches a failed task within seconds. So the session somebody
/// is looking at stops being the task's current run without anything on their screen changing, and
/// the next thing they send meets a refusal written for a program:
///
///     task 5Tkr… could not be started: session 6vVU… (RUNNING) holds its execution claim. Let
///     that run reach a terminal status of its own, then start the task again
///
/// Every client used to put that sentence on screen verbatim, because `friendly(error)` reduced the
/// answer to `body["message"]` and `ComposerLogic.sendFailureMessage` wrapped that one string. The
/// refusals were already STRUCTURED — a stable `code`, the run in the way as a public id, whether
/// it is on its way out — and `APIError.http(status:body:)` has carried the whole body all along;
/// the structure was simply being thrown away one layer above it. This is the layer that reads it:
/// a code in, words and a way out back.
///
/// Read BY CODE, never by prose. Several unrelated 409s reach the same handlers, and a build that
/// branched on the sentence would start showing the wrong card the first time somebody reworded it.
/// A code this build has never heard of — an older server that sends none at all, a newer one that
/// has grown a case — comes back nil, and the caller shows the server's own words. That fallback is
/// the point rather than a leftover: a refusal nobody translated is still better read than
/// swallowed.
///
/// The request half of the same contract is `docs/session-message-routing-contract.md`, which the
/// apiserver holds up with `sessions/resume-routes-to-current-run.pg.spec.ts`.
///
/// The visible strings are the web client's, word for word: `src/web/src/lib/taskRunHandoff.ts`
/// declares them as constants for exactly this reason, and `TaskRunHandoffCopyParityTests` reads
/// that file so neither end can be re-worded alone.
///
/// One deliberate difference from the web file, and it is plumbing rather than copy: an action
/// carries the run's **id** and not a URL. A browser navigates by href; this client routes with
/// `AppModel.route(to: .session(id))`, and inventing `/sessions/<id>` here would be a string no
/// navigator on this platform reads.
public enum TaskRunHandoff {

    // MARK: the words

    /// 2.1: the message was delivered, to the run that has the task rather than the one it was
    /// sent in.
    public static let handedOverTitle = "Sent to the run working on this task"
    public static let handedOverBody =
        "This session was replaced by a newer run, so your message went there."

    /// 2.4, and the Run button: the task is taken, and waiting is not what fixes it.
    public static let heldTitle = "A newer run has this task"
    public static let heldBody =
        "Another run is working on this task, so this one cannot take it. Open the run that has it "
        + "and carry on there."

    /// 2.3: the run in the way is on its way out, so this settles itself in a moment.
    public static let endingTitle = "That run is stopping"
    public static let endingBody =
        "The run working on this task is on its way out. Nothing is lost — this goes through as "
        + "soon as it lets go."

    public static let pinTitle = "This task is pinned to a different provider"

    public static let switchTitle = "Stop the run that is going?"

    public static let openTheRun = "Open the run"
    public static let clearThePin = "Clear the task's pin"
    public static let stopAndContinue = "Stop it and continue"
    public static let keepItRunning = "Keep it running"

    /// The two entries a task offers when nothing of it is going — unchanged, and named here so the
    /// third one is chosen against them in one place.
    public static let runEntryLabel = "Run"
    public static let retryEntryLabel = "Retry"
    public static let openRunEntryHint = "A run of this task is going — open it"

    /// How long to hold a message whose holder is letting go. The server's own
    /// `TASK_RUN_RETRY_AFTER_SECONDS`; a resend before that meets the same answer. Web's
    /// `TASK_RUN_RESEND_AFTER_MS` is the same interval in the unit that end counts in.
    public static let resendAfter: TimeInterval = 2

    /// How many times waiting is a plan.
    ///
    /// A run that is letting go normally frees the task within a couple of seconds, so a handful of
    /// resends covers it. Past that, whatever is holding the engine is not the shutdown this was
    /// waiting for, and a client that went on resending would be a request every two seconds for as
    /// long as the window stays open — on exactly the screen somebody leaves up while they go and
    /// look at something else. So it stops, and says the true thing instead: the run is still there.
    public static let resendMaxAttempts = 5

    // MARK: what the answer is

    /// Which of the four situations this is — chosen by what the reader has to DO, not by status
    /// code.
    ///
    /// `held` and `ending` are one code (`TASK_ALREADY_RUNNING`) and separated by a field, because
    /// the status alone cannot tell them apart: a run being cancelled has `cancel_requested_at` set
    /// and is still RUNNING. Waiting fixes one of them and nothing but opening the other fixes the
    /// other.
    public enum Kind: String, Equatable, Sendable {
        case held = "HELD"
        case ending = "ENDING"
        case pin = "PIN"
        case confirmSwitch = "CONFIRM_SWITCH"
    }

    public struct Action: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable {
            case openRun = "OPEN_RUN"
            case clearPin = "CLEAR_PIN"
            case stopAndContinue = "STOP_AND_CONTINUE"
            case keepRunning = "KEEP_RUNNING"
        }
        public let kind: Kind
        public let label: String
        /// The run `openRun` routes to, as the public id the server named. Nil on the others, and
        /// nil on an `openRun` whose answer named no run — then the button is not offered rather
        /// than offered dead.
        public let sessionID: String?
        public init(kind: Kind, label: String, sessionID: String? = nil) {
            self.kind = kind
            self.label = label
            self.sessionID = sessionID
        }
    }

    /// What to send back to answer a `confirmSwitch`, straight from the server. It names the
    /// SESSION rather than being a bare flag: the authorisation is for the run the person was
    /// shown, so a claim that changed hands between question and answer asks again instead of being
    /// stopped on a confirmation about a different run.
    public struct Confirm: Equatable, Sendable {
        public let field: String
        public let value: String
        public init(field: String, value: String) {
            self.field = field
            self.value = value
        }
    }

    public struct Conflict: Equatable, Sendable {
        public var kind: Kind
        public var title: String
        public var body: String
        /// The run in the way, as the public id the server named, or nil if it named none.
        public var sessionID: String?
        /// The task both runs are about, so a way out that edits the TASK (clearing its pin) has
        /// something to edit. Every one of these refusals names it.
        public var taskID: String?
        public var actions: [Action]
        public var confirm: Confirm?
        /// Present only on `ending`: resend the same message, unchanged, after this long.
        public var resendAfter: TimeInterval?
    }

    // MARK: reading one

    /// The refusal as structure, or nil when this build has no words for it.
    public static func readConflict(_ error: Error) -> Conflict? {
        guard case APIError.http(let status, let rawBody) = error, status == 409,
              let raw = rawBody, let data = raw.data(using: .utf8),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let code = body["code"] as? String
        else { return nil }

        let sessionID = string(body, "conflictingSessionId")
        let taskID = string(body, "taskId")

        switch code {
        case "TASK_ALREADY_RUNNING":
            // A run that is letting go frees the task by itself, so this end waits rather than
            // asking the reader to do anything — the message is still in hand and has lost nothing.
            if body["conflictingSessionEnding"] as? Bool == true {
                return Conflict(kind: .ending, title: endingTitle, body: endingBody,
                                sessionID: sessionID, taskID: taskID,
                                actions: [openRun(sessionID)], resendAfter: resendAfter)
            }
            return Conflict(kind: .held, title: heldTitle, body: heldBody,
                            sessionID: sessionID, taskID: taskID, actions: [openRun(sessionID)])

        case "TASK_RUN_PIN_CONFLICT":
            // The providers are the one part of the server's sentence worth keeping: they are what
            // the reader is choosing between, and neither of them is an id.
            let pinned = string(body, "pinnedTo") ?? "another provider"
            let running = string(body, "runningOn") ?? "a different one"
            return Conflict(
                kind: .pin, title: pinTitle,
                body: "This task is pinned to \(pinned), and the run working on it is on "
                    + "\(running). A run keeps its provider for its whole life, so \(pinned) "
                    + "starts with the next one.",
                sessionID: sessionID, taskID: taskID,
                actions: [openRun(sessionID), Action(kind: .clearPin, label: clearThePin)])

        case "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED":
            let running = string(body, "runningProvider") ?? "another provider"
            let requested = string(body, "requestedProvider") ?? "the one you picked"
            let asked = body["confirm"] as? [String: Any]
            let confirm = zip(string(asked, "field"), string(asked, "value")).map(Confirm.init)
            return Conflict(
                kind: .confirmSwitch, title: switchTitle,
                body: "This task is being worked on \(running). A run keeps its provider for its "
                    + "whole life, so continuing on \(requested) means stopping that one first — "
                    + "its branch and worktree are kept.",
                sessionID: sessionID, taskID: taskID,
                actions: [Action(kind: .stopAndContinue, label: stopAndContinue),
                          Action(kind: .keepRunning, label: keepItRunning)],
                confirm: confirm)

        default:
            // Including an older server, which sends no code at all and never reaches the switch.
            // The caller shows the server's own sentence.
            return nil
        }
    }

    private static func openRun(_ sessionID: String?) -> Action {
        Action(kind: .openRun, label: openTheRun, sessionID: sessionID)
    }

    /// A non-empty string field, or nil — an empty id is the same absence as a missing one, and
    /// letting one through would draw a button that routes nowhere.
    private static func string(_ body: [String: Any]?, _ key: String) -> String? {
        guard let value = body?[key] as? String, !value.isEmpty else { return nil }
        return value
    }

    /// Both halves of a confirmation or neither: a `field` with no `value` authorises nothing, and
    /// sending one without the other would ask the server to stop a run it was never told to.
    private static func zip(_ field: String?, _ value: String?) -> (String, String)? {
        guard let field, let value else { return nil }
        return (field, value)
    }

    /// The same refusal, re-read once waiting has stopped being a plan.
    ///
    /// Not a second server answer — nothing new was learned — but this end's own account of a
    /// holder that did not let go. It keeps the run it named, so the way out is the same one press
    /// it always was, and drops the promise the `ending` wording makes.
    public static func stillHeldAfterWaiting(_ conflict: Conflict) -> Conflict {
        var settled = conflict
        settled.kind = .held
        settled.title = heldTitle
        settled.body = heldBody
        settled.resendAfter = nil
        return settled
    }

    /// Where a resume actually put the message, when that is not where it was sent.
    ///
    /// The field's PRESENCE is the fact (contract 2.1). Absent means the ordinary resume happened
    /// and the message is in this session, which is what every build before this one assumed
    /// unconditionally — so an older server keeps behaving exactly as it did.
    public static func routedToSession(_ accepted: TurnAccepted?) -> String? {
        guard let id = accepted?.routedToSessionId, !id.isEmpty else { return nil }
        return id
    }

    /// The one thing that authorises stopping a run that is doing work.
    ///
    /// Only a `confirmSwitch` carries one, and only once the reader has answered it. Never derived
    /// from some other conflict that happens to name a session, and never remembered: stopping a
    /// run is destructive, so every stop is its own answer to its own question.
    public static func stopSessionID(_ conflict: Conflict?, confirmed: Bool) -> String? {
        guard confirmed, conflict?.kind == .confirmSwitch else { return nil }
        return conflict?.confirm?.value
    }

    /// What a provider pick in the composer will actually do, said while the pick is still standing.
    ///
    /// It replaced a status line that named the change and not its timing — and the timing is the
    /// whole question here, because a run keeps its provider for its whole life. With something
    /// going, the pick cannot touch it and lands on the next turn; with nothing going, the next
    /// message is the next turn. Nil when there is nothing to say, which includes picking what is
    /// already running: that is not a switch.
    public static func providerSwitchNote(from: String?, to: String, liveRun: Bool) -> String? {
        guard let from, !from.isEmpty, !to.isEmpty, from != to else { return nil }
        return liveRun
            ? "The turn in flight finishes on \(from). Your next one runs on \(to)."
            : "Your next message runs on \(to)."
    }

    // MARK: the entry a task offers

    public struct Entry: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable {
            case run = "RUN"
            case retry = "RETRY"
            case openRun = "OPEN_RUN"
        }
        public let kind: Kind
        public let label: String
        public let hint: String
        /// The run to open, when this end knows which one it is; nil when it only knows there is
        /// one.
        public let sessionID: String?
    }

    /// What a task's row and its detail offer to press.
    ///
    /// The live run wins over `status`, and that ordering is the fix: `status` is a label a
    /// workspace maintains and it lags, while `running`/`queued` are derived from the session rows
    /// on every read (`tasks.service.ts#withRunning`). The reported failure is exactly that gap — a
    /// task failed, the platform re-dispatched it two seconds later, and the row still said FAILED
    /// — so a Retry drawn off the status is a button whose only possible answer is the 409 this
    /// file translates.
    ///
    /// A caller that carries the task's sessions gets the run to route to; a list row, which
    /// carries the flags but no session, gets the same entry without one rather than a guess.
    public static func entry(for task: TaskItem) -> Entry {
        let busy = (task.sessions ?? []).first { $0.status == .running || $0.status == .pending }
        if task.running == true || task.queued == true || busy != nil {
            return Entry(kind: .openRun, label: openTheRun, hint: openRunEntryHint,
                         sessionID: busy?.id)
        }
        return task.status == .failed
            ? Entry(kind: .retry, label: retryEntryLabel, hint: retryEntryLabel, sessionID: nil)
            : Entry(kind: .run, label: runEntryLabel, hint: runEntryLabel, sessionID: nil)
    }
}
