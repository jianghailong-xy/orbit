import Foundation

/// The preview line shown under a session title in the Agent-console list — a direct port of the
/// web `sessionLine`. For a live session that's generating (see `Session.isGenerating`) it
/// surfaces the current state (the tool in flight, that it's blocked on you, the message you just
/// sent while awaiting the reply, or a bare "Running…") so the row never collapses to just a
/// title; otherwise it's the flattened last assistant reply, falling back to the run's own state
/// word. `tone` drives the colour.
public struct SessionLine: Equatable, Sendable {
    public enum Tone: String, Sendable {
        case preview     // reply content — default/secondary
        case running     // working
        case approval    // needs you
        case queued      // waiting for a slot
        case background  // a process the agent left up — outlives the turn, but isn't work
        case watching    // parked on a watch that will resume it — not a process, not waiting on you
        case review      // its report is with its reviewer — drawn, not counted, never amber
        case warning     // amber words for a fact that asks nothing: a landing the server judged timed out
    }
    public let text: String
    public let tone: Tone
    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    /// Build the line for a session. `live` is false in Trash. Always yields a line: a run that
    /// ended before producing any reply still says what happened, so the row can't shrink to a
    /// bare title (iOS sizes its list row from its content — a missing line visibly shortens it).
    /// `watching` is the session as an observer: parked with a live watch that will resume it.
    /// `recaps` is the account's Session recaps switch (Settings): on unless turned off, and off
    /// means the row falls through to the raw reply exactly as it did before the recap existed. It
    /// gates that one line and nothing else — every live line above it is untouched. `machine` is the
    /// runner the session runs on, by name: a session held for the Claude region says that Anthropic is
    /// unavailable there (`ClaudeRegion.heldWords`), where it is known.
    public static func make(for s: Session, live: Bool, watching: WatchSessionSummary? = nil,
                            recaps: Bool = true, machine: String? = nil) -> SessionLine {
        // Somebody is waiting on YOU here, which outranks everything else the row could say: every
        // other line reports what the agent is doing, and this one is the only one you can act on.
        //
        // Deliberately OUTSIDE the `isGenerating` gate it used to live inside, matching the web
        // port. A blocked tool call holds the turn open, so the gate was free for it; the owner
        // decisions the server now folds into this count (apiserver `owner-decision-signal.ts`) are
        // held open by nobody — the card is delivered and the turn ends underneath it — so they sit
        // on a PARKED conversation. Inside the gate, a real criteria decision waiting for an answer
        // left the row reading as an ordinary idle reply preview.
        //
        // WHAT it is waiting for is `SessionHeader.waitingWord`: an OWNER_CONFIRMED task's run says
        // so in the confirmation card's words, and anything else keeps the approval wording. Only
        // the words change — the row carries no button either way, because the one place to answer
        // is the card in the session.
        if live && (s.pendingApprovals ?? 0) > 0 {
            return SessionLine(text: SessionHeader.waitingWord(for: s), tone: .approval)
        }
        // The same place for a run whose report is still with its reviewer (contract §5 N3): who has
        // it, in the quiet tone — the card is drawn and can be pressed, but nobody is asking the owner
        // yet, so the row neither lights nor counts. Web parity: `sessionLine`'s `review` tone.
        if live, let review = s.confirmationUnderReview {
            return SessionLine(text: OwnerConfirmations.underReviewLine(review.reviewerTitle), tone: .review)
        }
        if live && s.isGenerating {
            if let t = s.lastToolUse, !t.isEmpty { return SessionLine(text: "Running \(fmtTool(t))…", tone: .running) }
            // A sub-agent or workflow in flight: its launch result cleared the tool line at once, so
            // say it rather than fall through to a preview that reads as idle (web parity).
            if let n = s.runningSubagentCount, n > 0 {
                return SessionLine(text: "\(subagentRunningLabel(n))…", tone: .running)
            }
            // The agent hasn't answered yet: show the message it was sent (server-kept from the moment
            // it is enqueued until a reply lands) rather than the previous turn's reply, which
            // would read as if this one had already been answered. Content, not status — the
            // spinner already conveys "working" — so it takes the muted preview tone.
            if let u = s.lastUserText, !u.isEmpty { return orbitLine(u, s.lastUserFromOrbit) ?? externalLine(u, s.lastUserFromExternal) ?? sentLine(u, from: s.lastUserFrom) }
            if let a = s.lastAssistantText, !a.isEmpty { return SessionLine(text: plainPreview(a), tone: .preview) }
            return SessionLine(text: "Running…", tone: .running)
        }
        if live && s.effectiveRunState == .queued {
            if let held = ClaudeRegion.heldWords(s, machine: machine) { return SessionLine(text: held, tone: .queued) }
            // A runner draining for its update is the one queue word in the warning colour (board 5,
            // web `sessionLine`): it can last hours, and only the owner can shorten it.
            if RunnerUpdating.holds(s) { return SessionLine(text: RunnerUpdating.RUNNER_UPDATING_TITLE, tone: .warning) }
            return SessionLine(text: "Queued", tone: .queued)
        }
        // Parked while a sub-agent or workflow it started works on: the workspace itself still
        // working, so it outranks the wait it is parked on and anything it left running (web's
        // `parkedWorkLabel`, subagent first). Its turn has ended, so this is where it surfaces.
        if live, let n = s.runningSubagentCount, n > 0 {
            return SessionLine(text: "\(subagentRunningLabel(n))…", tone: .running)
        }
        // Parked on a live watch that will resume it: not idle, not waiting on you, and — whatever
        // else it left running — not a background process (contract §9.2). Said in the strip's own
        // line, so the row and the strip above its composer read the same (web parity).
        if live, let watching, s.effectiveRunState == .awaitingInput {
            return SessionLine(text: watching.rowLine, tone: .watching)
        }
        // Parked (AWAITING_INPUT) but a background process is still running — not idle, though
        // not the agent working either (see the glyph): muted, not the working blue.
        if live, let bg = s.runningBgCount, bg > 0 {
            return SessionLine(text: "\(bgRunningLabel(bg))…", tone: .background)
        }
        // A message that never got an answer — the turn was interrupted, or failed, before any
        // reply landed — outranks the previous turn's reply: it's the newer of the two, and it's
        // what the session is left waiting on. The server only keeps it while it stands
        // unanswered, so a non-empty value here always means exactly that.
        if let u = s.lastUserText, !u.isEmpty { return orbitLine(u, s.lastUserFromOrbit) ?? externalLine(u, s.lastUserFromExternal) ?? sentLine(u, from: s.lastUserFrom) }
        // The rolling recap (0418) takes the place of the reply preview it used to show: the sentence
        // the server wrote about the session, not the raw last reply flattened down to one line. Only
        // here — below every live line above — so a working session still says what it is doing (web
        // parity). Off with the account's Session recaps switch, the row falls through to the reply
        // preview below exactly as it did before the recap existed. Unlabelled, as a project row's
        // always was (the owner, 2026-10-22): the whole line is the sentence, and when it was
        // written is the Recap card's to say, at the conversation's end (`RecapCard`).
        if recaps, let r = s.recapText?.trimmingCharacters(in: .whitespacesAndNewlines), !r.isEmpty {
            return SessionLine(text: r, tone: .preview)
        }
        if let a = s.lastAssistantText, !a.isEmpty { return SessionLine(text: plainPreview(a), tone: .preview) }
        // Nothing to preview at all (a run that died before even its user turn was recorded, or an
        // older row from before the server kept the pending message). Fall back to the run's own
        // state word — the same one the console header shows — so the row still says what happened
        // instead of collapsing.
        return SessionLine(text: SessionHeader.statusWord(for: s), tone: .preview)
    }

    /// The line for a message the agent hasn't answered yet, marked with who sent it (`sender`).
    /// Prefixed, because the preview line is otherwise the agent's voice: unmarked, a message and a
    /// reply to it read exactly alike, and "has it answered me yet?" is the one question the list has
    /// to answer while a turn is running. Same flattening as a reply — a sent message may be markdown
    /// too. Web parity: `sentLine` in WorkspaceView.tsx.
    static func sentLine(_ text: String, from: SessionMessageFrom?) -> SessionLine {
        SessionLine(text: "\(sender(from)): \(plainPreview(text))", tone: .preview)
    }

    /// The line for a message somebody other than the owner sent — a member of a connected Feishu group
    /// (`lastUserFromExternal`, docs/feishu-bot-design.md §8.2) or a guest the owner invited
    /// (docs/session-guests-design.md §3) — or nil for anybody else's: named the way the conversation
    /// names them over their words, `From Feishu · <name>: …` or `From <name>: …`, never "You". One message
    /// has one sender; the web asks it inside `sentBy`, before another session's title.
    static func externalLine(_ text: String, _ from: ExternalMessageFrom?) -> SessionLine? {
        guard let from else { return nil }
        return SessionLine(text: "\(ExternalSender.label(from)): \(plainPreview(text))", tone: .preview)
    }

    /// The owner, as the sender of their own message (web `SENT_BY_YOU`).
    static let you = "You"

    /// Who sent the message a row previews. "You" only for the owner's own words — and for every
    /// message from an older control plane, which names no sender. A message another Orbit session
    /// sent names that session (`lastUserFrom`) as the conversation's card names it: its title, or
    /// what an untitled one is called (`SessionMessageCard.untitled`; docs/session-list-projects-design.md
    /// §3.5, owner 2026-11-07). A coordinator's unanswered message is usually a task's report, which
    /// "You:" put in the owner's mouth. Web parity: `sentBy`.
    static func sender(_ from: SessionMessageFrom?) -> String {
        guard let from else { return you }
        let title = from.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? SessionMessageCard.untitled : title
    }

    /// Orbit, as the sender of its own messages (web `SENT_BY_ORBIT`).
    static let orbit = "Orbit"

    /// The line for a message Orbit wrote itself (`lastUserFromOrbit`; docs/session-list-projects-design.md
    /// §3.5, owner 2026-11-07), or nil for anybody else's: Orbit says it, never "You", which put "You: From
    /// Orbit · project …" on a coordinator's row while it read the notification. A notification the
    /// conversation draws as a line says that line's own sentence (`CoordinatorDeliveryCard.sentence`);
    /// any other says its first line, flattened like a preview — the rest is written for the agent. Web
    /// parity: `orbitLine` in WorkspaceView.tsx.
    static func orbitLine(_ text: String, _ mark: OrbitMessageFrom?) -> SessionLine? {
        guard let mark else { return nil }
        let said = mark.coordinatorDelivery.map(CoordinatorDeliveryCard.sentence)
            ?? plainPreview(text.components(separatedBy: "\n").first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? "")
        return SessionLine(text: "\(orbit): \(said)", tone: .preview)
    }

    /// Flatten an assistant reply into a single prose line: drop code blocks and the markdown
    /// marks, then collapse all whitespace. (Length is left to the view's truncation.)
    ///
    /// The same rules as the web `plainPreview`. Only what Markdown would draw as a mark goes, so
    /// the line says what the bubble says: the `_` and `*` of `tea_user_*_cnch`, the `~` of
    /// `~/.orbit`, the `--` of `--force` and the `#` of `#123` are words someone wrote.
    ///
    /// A link keeps only its text and an image only its alt, so `[name](orbit-task:…)` reads as
    /// `name`. Images go first so a linked image, `[![alt](src)](url)`, still comes down to its
    /// alt. Inline code is held out of every rule and put back at the end, which leaves the
    /// brackets and marks inside `code` alone.
    static func plainPreview(_ md: String) -> String {
        var s = md.replacingOccurrences(of: "```[\\s\\S]*?```", with: " ", options: .regularExpression) // fenced code
        var code = MarkdownMarks.HeldCode()
        s = code.hold(MarkdownMarks.inlineCode, in: s)                                              // inline code, held out
        s = s.replacingOccurrences(of: "!\\[([^\\[\\]]*)\\]\\([^)]*\\)", with: "$1",
                                   options: .regularExpression)                                     // images -> alt
        s = s.replacingOccurrences(of: "\\[([^\\[\\]]*)\\]\\([^)]*\\)", with: "$1",
                                   options: .regularExpression)                                     // links -> link text
        s = s.replacingOccurrences(of: "(?m)^[ \\t]*([-*_])[ \\t]*(?:\\1[ \\t]*){2,}$", with: "",
                                   options: .regularExpression)                                     // thematic breaks
        s = s.replacingOccurrences(of: "(?m)^(?:[ \\t]*(?:>|(?:#{1,6}|[-*])(?=[ \\t]|$)))+", with: "",
                                   options: .regularExpression)                                     // line-start markers
        s = MarkdownMarks.withoutEmphasis(s)
        s = code.putBack(s)                                                                         // inline code, back without its ticks
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Shorten a tool id for the live status line: mcp__orbit__task_create -> task_create; plain
    /// tool names (Bash, Read, Edit) pass through unchanged.
    static func fmtTool(_ name: String) -> String {
        name.replacingOccurrences(of: "^mcp__[^_]+__", with: "", options: .regularExpression)
    }

    /// "Running Agent" / "Running N agents" — the runtime's own sub-agents and workflows, word for
    /// word web's `subagentRunningLabel`.
    static func subagentRunningLabel(_ n: Int) -> String {
        n > 1 ? "Running \(n) agents" : "Running Agent"
    }

    /// "Background process running" / "N background processes running".
    static func bgRunningLabel(_ n: Int) -> String {
        n > 1 ? "\(n) background processes running" : "Background process running"
    }
}
